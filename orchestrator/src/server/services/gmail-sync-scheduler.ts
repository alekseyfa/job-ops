/**
 * Gmail auto-sync scheduler — polls every connected Gmail account on a
 * fixed interval (default: 2 hours) and runs the post-application ingestion
 * pipeline for each.
 *
 * The scheduler is built to be reliable above all else:
 *   - Skips if any sync run is already in flight (idempotent under server
 *     reload + manual triggers).
 *   - Tracks consecutive failures per account and emits a health-alert event
 *     after three in a row so we can surface "Reconnect Gmail" in chat.
 *   - Survives transient network/Gmail errors — the next tick will retry.
 */

import { EventEmitter } from "node:events";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { getActiveTenantId } from "@server/tenancy/context";
import { listConnectedPostApplicationIntegrations } from "../repositories/post-application-integrations";
import * as settingsRepo from "../repositories/settings";
import { listTenants } from "../repositories/tenants";
import {
  type GmailSyncSummary,
  runGmailIngestionSync,
} from "./post-application/ingestion/gmail-sync";

const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 2;
const FAILURE_ALERT_THRESHOLD = 3;

type AccountKey = string;

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number | null;
  lastTickStartedAt: number | null;
  lastTickCompletedAt: number | null;
  inFlight: boolean;
  consecutiveFailures: Map<AccountKey, number>;
}

const state: SchedulerState = {
  timer: null,
  intervalMs: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  inFlight: false,
  consecutiveFailures: new Map(),
};

export type GmailSyncHealthEvent =
  | {
      type: "tick_started";
      accountCount: number;
      startedAt: number;
    }
  | {
      type: "account_synced";
      accountKey: AccountKey;
      summary: GmailSyncSummary;
      durationMs: number;
    }
  | {
      type: "account_failed";
      accountKey: AccountKey;
      error: string;
      consecutiveFailures: number;
      shouldAlertUser: boolean;
    }
  | {
      type: "tick_completed";
      durationMs: number;
      totals: GmailSyncSummary;
      accountCount: number;
    }
  | {
      type: "no_accounts_connected";
    };

const healthEvents = new EventEmitter();
healthEvents.setMaxListeners(20);

export function subscribeToGmailSyncHealth(
  listener: (event: GmailSyncHealthEvent) => void,
): () => void {
  healthEvents.on("event", listener);
  return () => healthEvents.off("event", listener);
}

function emit(event: GmailSyncHealthEvent): void {
  try {
    healthEvents.emit("event", event);
  } catch (err) {
    logger.warn("Gmail sync health listener threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function readIntervalMs(): Promise<number> {
  const raw = await settingsRepo.getSetting("gmailSyncIntervalHours");
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const safeHours = Number.isFinite(parsed)
    ? Math.min(24, Math.max(1, parsed))
    : DEFAULT_INTERVAL_HOURS;
  return safeHours * MS_PER_HOUR;
}

async function readEnabled(): Promise<boolean> {
  const raw = await settingsRepo.getSetting("gmailSyncEnabled");
  if (raw === null || raw === undefined) return true; // default-on
  return raw === "true" || raw === "1";
}

function emptyTotals(): GmailSyncSummary {
  return { discovered: 0, relevant: 0, classified: 0, errored: 0 };
}

/**
 * Sync every connected Gmail account for the CURRENT tenant context. Must be
 * called inside a runWithRequestContext({tenantId}) scope. Does not manage the
 * global in-flight guard (the caller owns that). Failure counters are keyed by
 * `${tenantId}:${accountKey}` so one tenant's failures can't mask another's.
 */
async function syncCurrentTenantAccounts(): Promise<{
  ranAccounts: number;
  totals: GmailSyncSummary;
}> {
  const tenantId = getActiveTenantId();
  const totals = emptyTotals();
  const integrations = await listConnectedPostApplicationIntegrations("gmail");
  if (integrations.length === 0) {
    return { ranAccounts: 0, totals };
  }

  for (const integration of integrations) {
    const accountKey = integration.accountKey;
    const failureKey = `${tenantId}:${accountKey}`;
    const accountStartedAt = Date.now();
    try {
      const summary = await runGmailIngestionSync({ accountKey });
      totals.discovered += summary.discovered;
      totals.relevant += summary.relevant;
      totals.classified += summary.classified;
      totals.errored += summary.errored;
      state.consecutiveFailures.delete(failureKey);
      emit({
        type: "account_synced",
        accountKey,
        summary,
        durationMs: Date.now() - accountStartedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = (state.consecutiveFailures.get(failureKey) ?? 0) + 1;
      state.consecutiveFailures.set(failureKey, failures);
      const shouldAlertUser = failures === FAILURE_ALERT_THRESHOLD;
      emit({
        type: "account_failed",
        accountKey,
        error: message,
        consecutiveFailures: failures,
        shouldAlertUser,
      });
      logger.warn("Gmail sync failed for account", {
        tenantId,
        accountKey,
        consecutiveFailures: failures,
        error: message,
      });
    }
  }

  return { ranAccounts: integrations.length, totals };
}

/**
 * Run the sync for the CURRENT tenant only. Used by manual triggers (e.g. the
 * /sync command), which run inside the requesting tenant's context. Returns the
 * combined summary so the caller can show "synced N messages" feedback.
 */
export async function runGmailSyncForCurrentTenant(args?: {
  reason?: "scheduled" | "manual";
}): Promise<{ ranAccounts: number; totals: GmailSyncSummary }> {
  if (state.inFlight) {
    logger.info("Gmail sync skipped: already in flight", {
      reason: args?.reason,
    });
    return { ranAccounts: 0, totals: emptyTotals() };
  }

  state.inFlight = true;
  state.lastTickStartedAt = Date.now();
  try {
    const result = await syncCurrentTenantAccounts();
    if (result.ranAccounts === 0) {
      emit({ type: "no_accounts_connected" });
      return result;
    }
    emit({
      type: "tick_started",
      accountCount: result.ranAccounts,
      startedAt: state.lastTickStartedAt,
    });
    emit({
      type: "tick_completed",
      durationMs: Date.now() - state.lastTickStartedAt,
      totals: result.totals,
      accountCount: result.ranAccounts,
    });
    return result;
  } finally {
    state.inFlight = false;
    state.lastTickCompletedAt = Date.now();
  }
}

/**
 * Scheduled entry point: sync every tenant's connected Gmail accounts. Each
 * tenant is evaluated inside its own request context and self-gates on its own
 * gmailSyncEnabled setting. Aggregates totals across all tenants.
 */
export async function runGmailSyncForAllAccounts(args?: {
  reason?: "scheduled" | "manual";
}): Promise<{ ranAccounts: number; totals: GmailSyncSummary }> {
  if (state.inFlight) {
    logger.info("Gmail sync skipped: already in flight", {
      reason: args?.reason,
    });
    return { ranAccounts: 0, totals: emptyTotals() };
  }

  state.inFlight = true;
  state.lastTickStartedAt = Date.now();
  const totals = emptyTotals();
  let ranAccounts = 0;

  try {
    const tenants = await listTenants();
    for (const tenant of tenants) {
      const result = await runWithRequestContext(
        { tenantId: tenant.id },
        async () => {
          if (!(await readEnabled())) return null;
          return syncCurrentTenantAccounts();
        },
      );
      if (!result) continue;
      ranAccounts += result.ranAccounts;
      totals.discovered += result.totals.discovered;
      totals.relevant += result.totals.relevant;
      totals.classified += result.totals.classified;
      totals.errored += result.totals.errored;
    }

    if (ranAccounts === 0) {
      emit({ type: "no_accounts_connected" });
      return { ranAccounts: 0, totals };
    }

    emit({
      type: "tick_started",
      accountCount: ranAccounts,
      startedAt: state.lastTickStartedAt,
    });
    emit({
      type: "tick_completed",
      durationMs: Date.now() - state.lastTickStartedAt,
      totals,
      accountCount: ranAccounts,
    });

    return { ranAccounts, totals };
  } finally {
    state.inFlight = false;
    state.lastTickCompletedAt = Date.now();
  }
}

function clearTimer(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.intervalMs = null;
}

async function tick(): Promise<void> {
  try {
    await runGmailSyncForAllAccounts({ reason: "scheduled" });
  } catch (error) {
    logger.error("Gmail sync tick failed unexpectedly", { error });
  }
}

/**
 * Start (or restart) the Gmail sync scheduler.  Safe to call repeatedly —
 * it will tear down the existing timer before starting a new one whenever
 * the interval changes.
 */
export async function initializeGmailSyncScheduler(): Promise<void> {
  // The scheduled loop always runs; per-tenant gating (gmailSyncEnabled) is
  // evaluated inside runGmailSyncForAllAccounts for each tenant. The interval
  // cadence is a system-level setting read from the default tenant context.
  const intervalMs = await runWithRequestContext(
    { tenantId: DEFAULT_TENANT_ID },
    () => readIntervalMs(),
  );
  if (state.timer && state.intervalMs === intervalMs) {
    // Already running at the right cadence; nothing to do.
    return;
  }

  clearTimer();
  state.intervalMs = intervalMs;
  state.timer = setInterval(() => {
    void tick();
  }, intervalMs);
  logger.info("Gmail sync scheduler started", {
    intervalMs,
    intervalHours: intervalMs / MS_PER_HOUR,
  });

  // Defer the first tick by 1 minute so the server is fully booted (DB,
  // registry, etc.) before reaching out to Gmail.
  setTimeout(() => {
    void tick();
  }, 60_000);
}

export function stopGmailSyncScheduler(): void {
  clearTimer();
  state.consecutiveFailures.clear();
  state.lastTickStartedAt = null;
  state.lastTickCompletedAt = null;
  state.inFlight = false;
}

export interface GmailSyncSchedulerStatus {
  enabled: boolean;
  intervalHours: number | null;
  lastTickStartedAt: number | null;
  lastTickCompletedAt: number | null;
  inFlight: boolean;
  consecutiveFailures: Record<string, number>;
}

export function getGmailSyncSchedulerStatus(): GmailSyncSchedulerStatus {
  return {
    enabled: state.timer !== null,
    intervalHours:
      state.intervalMs !== null ? state.intervalMs / MS_PER_HOUR : null,
    lastTickStartedAt: state.lastTickStartedAt,
    lastTickCompletedAt: state.lastTickCompletedAt,
    inFlight: state.inFlight,
    consecutiveFailures: Object.fromEntries(state.consecutiveFailures),
  };
}
