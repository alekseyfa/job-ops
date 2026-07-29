/**
 * Smart Apply session orchestrator.
 *
 * Lifecycle of one session:
 *   1. start({ jobId }) — validates eligibility, kicks off a background task
 *      that drives Playwright to render+fill the form, then registers a
 *      noVNC viewer token.
 *   2. Status polling from the bot/API shows the user "preparing → ready"
 *      transitions.
 *   3. Once `status === 'ready'`, the user opens the viewer URL on their
 *      device (mobile-friendly).  They click Submit themselves.
 *   4. A URL-change watcher inside the Playwright session detects the
 *      success page and flips the session to `'submitted'`.  We then mark
 *      the underlying job as applied and tear down the browser.
 *
 * Concurrency: we deliberately allow only ONE active Smart Apply session
 * per process (because the noVNC viewer only renders Xvfb display :99,
 * which is a single shared window).  Attempting to start a second session
 * while one is already 'preparing' or 'ready' returns `ALREADY_ACTIVE`.
 *
 * Security: each session gets a one-time random token (32 bytes base64url).
 * The token is short-lived (defaults to the viewer TTL of 15 min) and is
 * scoped — only requests carrying that token in the URL hit the proxy.
 */

import { randomBytes } from "node:crypto";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { getActiveTenantId } from "@server/tenancy/context";
import { transitionStage } from "../applicationTracking";
import {
  buildChallengeViewerUrl,
  createChallengeViewerSession,
  ensureChallengeViewer,
} from "../challenge-viewer";
import { getJobById, updateJob } from "../../repositories/jobs";
import {
  createSmartApplySession,
  expireStaleSessions,
  getActiveSmartApplySession,
  getSmartApplySessionById,
  updateSmartApplySession,
  type SmartApplySessionRecord,
} from "../../repositories/smart-apply-sessions";
import { evaluateSmartApplyEligibility, isSmartApplyEligible } from "./eligibility";
import { parseAshbyForm } from "./parsers/ashby";
import { parseGreenhouseForm } from "./parsers/greenhouse";
import { buildPrefilledForm } from "./prefill";
import type {
  FormSchema,
  PrefilledField,
  PrefilledForm,
  SmartApplyAts,
  SmartApplySessionDto,
} from "./types";
import type { Browser, BrowserContext, Page } from "playwright";

const VIEWER_TTL_MS = 15 * 60 * 1000;
const SUBMIT_WATCHER_INTERVAL_MS = 4_000;

// Single-session guard: only one headed Firefox can use display :99 at a time.
interface ActiveBrowserSession {
  sessionId: string;
  // The tenant that started this session. Background timers (submit watcher,
  // TTL teardown) fire outside any request context, so they re-establish this
  // tenant before touching tenant-scoped repositories.
  tenantId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  watcher: ReturnType<typeof setInterval> | null;
  expiresAt: number;
}

let active: ActiveBrowserSession | null = null;
// Synchronous reservation flag closing the TOCTOU window between the
// single-session guard and `active` being assigned. `active` can only be set
// ~10-30s later (after the browser launches, the form is parsed and filled),
// so two starts firing within that window would both pass an `if (active)`
// guard and spawn two headed browsers on the shared :99 display, orphaning
// one. Setting this synchronously before the first `await` — atomic in
// single-threaded JS — makes the second start bail with ALREADY_ACTIVE.
let reserving = false;
let startupCleanupDone = false;

async function ensureStartupCleanup(): Promise<void> {
  if (startupCleanupDone) return;
  startupCleanupDone = true;
  // Startup maintenance sweeps every tenant's stale sessions.
  const { listTenants } = await import("../../repositories/tenants");
  const tenants = await listTenants();
  for (const tenant of tenants) {
    await runWithRequestContext({ tenantId: tenant.id }, async () => {
      const expired = await expireStaleSessions();
      if (expired > 0) {
        logger.info(
          "Smart Apply: expired stale sessions from previous container life",
          { tenantId: tenant.id, count: expired },
        );
      }
    });
  }
}

async function teardownActive(reason: string): Promise<void> {
  if (!active) return;
  const a = active;
  active = null;
  if (a.watcher) clearInterval(a.watcher);
  try {
    await a.page.close({ runBeforeUnload: false });
  } catch {
    // ignore
  }
  try {
    await a.context.close();
  } catch {
    // ignore
  }
  try {
    await a.browser.close();
  } catch {
    // ignore
  }
  logger.info("Smart Apply: browser session torn down", {
    sessionId: a.sessionId,
    reason,
  });
}

async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const { firefox } = await import("playwright");
  const browser = await firefox.launch({
    headless: false,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function parseFormViaPlaywright(
  page: Page,
  applyUrl: string,
  ats: "greenhouse" | "ashby" | "lever",
): Promise<FormSchema> {
  if (ats === "greenhouse") {
    return parseGreenhouseForm({ page, applyUrl });
  }
  if (ats === "ashby") {
    return parseAshbyForm({ page, applyUrl });
  }
  return (await import("./parsers/lever")).parseLeverForm({ page, applyUrl });
}

async function fillForm(
  page: Page,
  prefilled: PrefilledForm,
): Promise<{ filled: number; skipped: number }> {
  let filled = 0;
  let skipped = 0;

  for (const field of prefilled.fields) {
    try {
      const success = await fillField(page, field);
      if (success) filled += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logger.warn("Smart Apply: failed to fill field", {
        selector: field.selector,
        label: field.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { filled, skipped };
}

async function fillField(
  page: Page,
  field: PrefilledField,
): Promise<boolean> {
  if (!field.filled) return false;
  const value = field.value;
  if (value.kind === "skip") return false;

  const locator = page.locator(field.selector).first();
  // Scroll into view so the user can see what we did.
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 });
  } catch {
    // Some elements aren't scrollable — proceed anyway.
  }

  if (value.kind === "file") {
    try {
      // setInputFiles works on <input type=file> regardless of visibility.
      await locator.setInputFiles(value.path);
      return true;
    } catch (err) {
      logger.warn("Smart Apply: setInputFiles failed, retrying with handle", {
        selector: field.selector,
        error: err instanceof Error ? err.message : String(err),
      });
      const handle = await page.$(field.selector);
      if (handle) {
        try {
          await handle.setInputFiles(value.path);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  if (value.kind === "text") {
    if (field.type === "textarea") {
      await locator.fill(value.value, { timeout: 5_000 });
    } else {
      await locator.fill(value.value, { timeout: 5_000 });
    }
    return true;
  }

  if (value.kind === "choice") {
    if (field.type === "select") {
      await locator.selectOption({ value: value.value });
      return true;
    }
    if (field.type === "radio") {
      const opt = page.locator(`[value="${value.value}"]`).first();
      await opt.check({ timeout: 3_000 });
      return true;
    }
    return false;
  }

  if (value.kind === "boolean") {
    if (value.value) await locator.check({ timeout: 3_000 });
    else await locator.uncheck({ timeout: 3_000 }).catch(() => {});
    return true;
  }

  return false;
}

function isSuccessUrl(url: string, ats: "greenhouse" | "ashby" | "lever"): boolean {
  if (ats === "greenhouse") {
    return (
      url.includes("/applications/thank_you") ||
      url.includes("/thank-you") ||
      url.includes("/confirmation")
    );
  }
  if (ats === "ashby") {
    return url.includes("/application-submitted") || url.includes("/applications/");
  }
  if (ats === "lever") {
    return (
      url.includes("/application/success") ||
      url.includes("/applications/") ||
      url.includes("/thank-you")
    );
  }
  return false;
}

function startSubmitWatcher(
  sessionId: string,
  ats: "greenhouse" | "ashby" | "lever",
  jobId: string,
  tenantId: string,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      if (!active || active.sessionId !== sessionId) return;
      const url = active.page.url();
      if (!isSuccessUrl(url, ats)) return;

      logger.info("Smart Apply: submission detected", {
        sessionId,
        url,
      });

      await runWithRequestContext({ tenantId }, async () => {
        await updateSmartApplySession(sessionId, {
          status: "submitted",
          submittedAt: Date.now(),
        });

        // Mark the job as applied if it wasn't already.
        const job = await getJobById(jobId);
        if (job && job.status !== "applied" && job.status !== "in_progress") {
          await updateJob(jobId, {
            status: "applied",
            appliedAt: new Date().toISOString(),
          });
          try {
            transitionStage(jobId, "applied", Math.floor(Date.now() / 1000), {
              actor: "system",
              eventType: "status_update",
              eventLabel: "Applied via Smart Apply",
              reasonCode: "smart_apply",
            });
          } catch (err) {
            logger.warn("Smart Apply: stage transition failed", {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      // Keep the page open for a few seconds so the user sees the
      // success page, then tear down.
      setTimeout(() => {
        void teardownActive("submitted");
      }, 4_000);
    } catch (err) {
      logger.warn("Smart Apply: submit watcher error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, SUBMIT_WATCHER_INTERVAL_MS);
}

export type StartSessionResult =
  | { ok: true; session: SmartApplySessionDto }
  | { ok: false; code: "INELIGIBLE" | "ALREADY_ACTIVE" | "INTERNAL"; message: string };

export async function startSmartApplySession(args: {
  jobId: string;
}): Promise<StartSessionResult> {
  // Reject if there's already an active OR in-flight browser session. Both
  // checks and the reservation happen synchronously (no await between them),
  // so a concurrent double-start can't slip through the window before `active`
  // is set far later in runBrowserSession.
  if (active || reserving) {
    return {
      ok: false,
      code: "ALREADY_ACTIVE",
      message: "Another Smart Apply session is currently open. Finish or abort it first.",
    };
  }
  reserving = true;

  let handedOff = false;
  try {
    const result = await startSmartApplySessionInner(args);
    // Only a successful start hands the reservation off to the background
    // runBrowserSession (whose `finally` releases it once `active` is set or
    // the attempt fails). Every other outcome — ineligible, viewer down, a
    // thrown error — must release here, or the feature stays wedged forever.
    handedOff = result.ok;
    return result;
  } finally {
    if (!handedOff) reserving = false;
  }
}

async function startSmartApplySessionInner(args: {
  jobId: string;
}): Promise<StartSessionResult> {
  await ensureStartupCleanup();

  const dbActive = await getActiveSmartApplySession();
  if (dbActive) {
    // DB says we have a "ready" session but in-memory we have nothing —
    // mark it expired so the user can start fresh.
    await updateSmartApplySession(dbActive.id, { status: "expired" });
  }

  const job = await getJobById(args.jobId);
  if (!job) {
    return { ok: false, code: "INELIGIBLE", message: "Job not found." };
  }
  const verdict = evaluateSmartApplyEligibility({ job });
  if (!verdict.eligible) {
    return { ok: false, code: "INELIGIBLE", message: verdict.reason };
  }

  const viewer = await ensureChallengeViewer();
  if (!viewer.available) {
    return {
      ok: false,
      code: "INTERNAL",
      message: `Browser viewer not available: ${viewer.reason}`,
    };
  }

  // Capture the tenant now (we're inside the request context). Background timers
  // spawned below outlive this context and must re-establish it.
  const tenantId = getActiveTenantId();

  const session = await createSmartApplySession({
    jobId: args.jobId,
    applyUrl: verdict.applyUrl,
  });

  // Run the actual browser work in the background so the caller (Telegram
  // / HTTP) gets a fast response.
  void runWithRequestContext({ tenantId }, () =>
    runBrowserSession(session, verdict.ats, verdict.applyUrl, job, tenantId),
  );

  return { ok: true, session: await toDto(session) };
}

async function runBrowserSession(
  session: SmartApplySessionRecord,
  ats: SmartApplyAts,
  applyUrl: string,
  job: Awaited<ReturnType<typeof getJobById>>,
  tenantId: string,
): Promise<void> {
  if (!job) {
    await updateSmartApplySession(session.id, {
      status: "failed",
      errorMessage: "Job vanished between eligibility check and browser launch.",
    });
    return;
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    context = launched.context;
    page = launched.page;

    const schema = await parseFormViaPlaywright(page, applyUrl, ats);
    if (schema.hasCaptcha) {
      throw new Error(
        "This form requires a captcha — Smart Apply skips it to avoid trips. Apply manually.",
      );
    }

    const prefilled = await buildPrefilledForm({ schema, job });

    await updateSmartApplySession(session.id, {
      parsedFields: schema.fields,
      prefilled,
    });

    const { filled, skipped } = await fillForm(page, prefilled);
    logger.info("Smart Apply: form filled", {
      sessionId: session.id,
      filled,
      skipped,
      total: prefilled.fields.length,
    });

    // Token-scoped viewer URL.  The challenge-viewer module already handles
    // proxy + TTL.  We mirror the TTL into our DB row for status display.
    const { token } = createChallengeViewerSession({ ttlMs: VIEWER_TTL_MS });
    const expiresAt = Date.now() + VIEWER_TTL_MS;

    const watcher = startSubmitWatcher(session.id, ats, job.id, tenantId);

    // Register the active session BEFORE marking ready so polls see it.
    active = {
      sessionId: session.id,
      tenantId,
      browser,
      context,
      page,
      watcher,
      expiresAt,
    };

    // Auto-teardown after viewer expiry if user never submits.
    setTimeout(() => {
      if (active?.sessionId === session.id) {
        void runWithRequestContext({ tenantId }, async () => {
          const current = await getSmartApplySessionById(session.id);
          if (current?.status === "ready") {
            await updateSmartApplySession(session.id, { status: "expired" });
          }
          await teardownActive("viewer_ttl_expired");
        });
      }
    }, VIEWER_TTL_MS);

    await updateSmartApplySession(session.id, {
      status: "ready",
      viewerToken: token,
      viewerExpiresAt: expiresAt,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Smart Apply failure";
    logger.error("Smart Apply: session failed", {
      sessionId: session.id,
      error: sanitizeUnknown(err),
    });
    if (page) {
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // ignore
      }
    }
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    await updateSmartApplySession(session.id, {
      status: "failed",
      errorMessage: message,
    });
  } finally {
    // The reservation has served its purpose: either `active` is now set (the
    // guard keys off `active` from here on) or the launch failed and there's
    // nothing to protect. Releasing lets the next start proceed.
    reserving = false;
  }
}

export async function abortSmartApplySession(
  sessionId: string,
): Promise<void> {
  await teardownActive("user_aborted");
  await updateSmartApplySession(sessionId, { status: "aborted" });
}

export async function getSmartApplySession(
  sessionId: string,
): Promise<SmartApplySessionDto | null> {
  const record = await getSmartApplySessionById(sessionId);
  if (!record) return null;
  return toDto(record);
}

async function toDto(
  record: SmartApplySessionRecord,
): Promise<SmartApplySessionDto> {
  const viewerUrl =
    record.viewerToken && record.status === "ready"
      ? buildChallengeViewerUrl({ token: record.viewerToken })
      : null;
  return {
    id: record.id,
    jobId: record.jobId,
    status: record.status,
    applyUrl: record.applyUrl,
    viewerUrl,
    viewerExpiresAt: record.viewerExpiresAt,
    submittedAt: record.submittedAt,
    errorMessage: record.errorMessage,
    prefilled: record.prefilled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { isSmartApplyEligible };
