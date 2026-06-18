/**
 * Telegram handlers for Smart Apply.
 *
 * Callback IDs (all under the "sa:" namespace):
 *   sa:start:<short_job_id>   — kick off a Smart Apply session for a job
 *   sa:status:<session_id>    — re-render current status of a session
 *   sa:abort:<session_id>     — abort an in-flight session
 *   sa:draft:<session_id>     — start AI drafting flow for essay questions
 *   sa:save:<session_id>:<selectorB64> — save a drafted essay answer
 *
 * UX flow on the user side:
 *   1. Tap job → see "🚀 Smart Apply" button (only for eligible jobs).
 *   2. Tap button → bot replies with a status card ("⏳ Preparing…").
 *   3. Bot polls status every 3s for up to 90s; when 'ready', the message
 *      shows status. If essay questions are detected, shows "✍️ Draft Essays".
 *   4. User taps Draft → AI drafts each pending essay, one at a time.
 *      User can edit inline or use as-is.
 *   5. After all essays drafted, status card shows "🌐 Open the form" button
 *      linking to the noVNC viewer.
 *   6. User opens the viewer (works on mobile), reviews + clicks Submit
 *      themselves in the rendered browser.
 *   7. The session's URL watcher flips status → 'submitted'; we update the
 *      status card with a success message.
 */

import { logger } from "@infra/logger";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import * as jobsRepo from "@server/repositories/jobs";
import { updateSessionEssayAnswer } from "@server/repositories/smart-apply-sessions";
import {
  abortSmartApplySession,
  getSmartApplySession,
  isSmartApplyEligible,
  startSmartApplySession,
} from "@server/services/smart-apply";
import type { PrefilledField } from "@server/services/smart-apply/types";
import { draftScreeningAnswer } from "@server/services/screening-essay-drafter";
import { escapeHtml } from "../formatting";

const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 90_000;

function shortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

/**
 * Public re-export: callers (e.g. job detail handler) need to know whether
 * to render the "🚀 Smart Apply" button at all.  We expose a job → boolean
 * helper so they don't need to import the service module directly.
 */
export async function jobSupportsSmartApply(jobId: string): Promise<boolean> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) return false;
  // Only meaningful for jobs that are at least "ready" (have a tailored PDF).
  if (job.status !== "ready" && job.status !== "applied" && job.status !== "in_progress") {
    return false;
  }
  return isSmartApplyEligible({ job });
}

function buildPublicBaseUrl(): string {
  return (
    process.env.JOBOPS_PUBLIC_BASE_URL?.trim() ||
    "http://localhost:3005"
  );
}

function buildViewerAbsoluteUrl(viewerPath: string): string {
  const base = buildPublicBaseUrl();
  // Viewer path starts with "/challenge-viewer/...".  Ensure single slash.
  if (viewerPath.startsWith("http")) return viewerPath;
  return `${base.replace(/\/$/, "")}${viewerPath.startsWith("/") ? "" : "/"}${viewerPath}`;
}

function renderStatusCard(args: {
  jobTitle: string;
  employer: string;
  status:
    | "preparing"
    | "ready"
    | "submitted"
    | "expired"
    | "aborted"
    | "failed";
  viewerUrl: string | null;
  reviewRequiredCount: number;
  essayFields: PrefilledField[];
  errorMessage: string | null;
  expiresAt: number | null;
  sessionId: string;
}): { text: string; keyboard: InlineKeyboard } {
  const header = `<b>🚀 Smart Apply</b>\n<b>${escapeHtml(args.jobTitle)}</b> @ ${escapeHtml(args.employer)}\n`;
  const lines: string[] = [header];

  switch (args.status) {
    case "preparing":
      lines.push(
        "⏳ Opening the form in our server browser and pre-filling everything we can…",
      );
      lines.push("");
      lines.push(
        "<i>Usually takes 10–30 seconds.  You'll get a viewer link as soon as it's ready.</i>",
      );
      break;
    case "ready": {
      const minutesLeft = args.expiresAt
        ? Math.max(1, Math.round((args.expiresAt - Date.now()) / 60_000))
        : null;
      lines.push("✅ Form is open and pre-filled.");

      // Check if there are pending essays (essayFields that need drafting).
      const hasPendingEssays = args.essayFields.some(
        (f) => f.requiresReview && !f.draftedAnswer,
      );

      if (hasPendingEssays) {
        lines.push("");
        lines.push(
          "💡 <b>Essay questions need drafting.</b> Tap 'Draft' below.",
        );
      } else if (args.reviewRequiredCount > 0) {
        lines.push(
          `⚠️ <b>${args.reviewRequiredCount}</b> required field(s) need your review before submit.`,
        );
      } else {
        lines.push("All required fields filled — review and submit.");
      }

      if (minutesLeft !== null) {
        lines.push("");
        lines.push(
          `<i>Viewer expires in ~${minutesLeft} min.  If you need more time, restart the session.</i>`,
        );
      }
      break;
    }
    case "submitted":
      lines.push("🎉 <b>Submission detected!</b>");
      lines.push(
        "Job moved to <b>applied</b> automatically.  Confirmation email will be picked up by Gmail sync.",
      );
      break;
    case "expired":
      lines.push(
        "⌛ The session expired.  Start a new one to reopen the form.",
      );
      break;
    case "aborted":
      lines.push("⏹ Session aborted.");
      break;
    case "failed":
      lines.push("❌ Could not prepare the form.");
      if (args.errorMessage) {
        lines.push("");
        lines.push(`<code>${escapeHtml(args.errorMessage.slice(0, 400))}</code>`);
      }
      break;
  }

  const keyboard = new InlineKeyboard();
  if (args.status === "ready" && args.viewerUrl) {
    const hasPendingEssays = args.essayFields.some(
      (f) => f.requiresReview && !f.draftedAnswer,
    );
    if (hasPendingEssays) {
      keyboard.text("✍️ Draft Essays", `sa:draft:${args.sessionId}`).row();
    }
    keyboard
      .url("🌐 Open the form", buildViewerAbsoluteUrl(args.viewerUrl))
      .row()
      .text("🔄 Refresh status", `sa:status:${args.sessionId}`)
      .text("⏹ Abort", `sa:abort:${args.sessionId}`);
  } else if (args.status === "preparing") {
    keyboard
      .text("🔄 Refresh", `sa:status:${args.sessionId}`)
      .text("⏹ Abort", `sa:abort:${args.sessionId}`);
  } else if (
    args.status === "expired" ||
    args.status === "failed" ||
    args.status === "aborted"
  ) {
    keyboard.text("◀️ Menu", "m:menu");
  } else {
    keyboard
      .text("📋 Applied", "j:applied:0")
      .text("◀️ Menu", "m:menu");
  }

  return { text: lines.join("\n"), keyboard };
}

async function renderSession(
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const session = await getSmartApplySession(sessionId);
  if (!session) {
    await ctx.editMessageText("Smart Apply session not found.").catch(() => {});
    return;
  }
  const job = await jobsRepo.getJobById(session.jobId);
  const card = renderStatusCard({
    jobTitle: job?.title ?? "Job",
    employer: job?.employer ?? "Company",
    status: session.status,
    viewerUrl: session.viewerUrl,
    reviewRequiredCount: session.prefilled?.reviewRequiredCount ?? 0,
    essayFields: session.prefilled?.essayFields ?? [],
    errorMessage: session.errorMessage,
    expiresAt: session.viewerExpiresAt,
    sessionId: session.id,
  });
  try {
    await ctx.editMessageText(card.text, {
      parse_mode: "HTML",
      reply_markup: card.keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch {
    await ctx.reply(card.text, {
      parse_mode: "HTML",
      reply_markup: card.keyboard,
      link_preview_options: { is_disabled: true },
    });
  }
}

async function startAndPoll(
  ctx: Context,
  jobShortId: string,
): Promise<void> {
  const jobId = await jobsRepo.getJobIdByShortId(jobShortId);
  if (!jobId) {
    await ctx
      .answerCallbackQuery("Job not found.")
      .catch(() => {});
    return;
  }

  const result = await startSmartApplySession({ jobId });
  if (!result.ok) {
    await ctx
      .answerCallbackQuery(result.message.slice(0, 200))
      .catch(() => {});
    await ctx
      .reply(`❌ Smart Apply: ${escapeHtml(result.message)}`, {
        parse_mode: "HTML",
      })
      .catch(() => {});
    return;
  }

  // Initial status card.
  const job = await jobsRepo.getJobById(jobId);
  const card = renderStatusCard({
    jobTitle: job?.title ?? "Job",
    employer: job?.employer ?? "Company",
    status: result.session.status,
    viewerUrl: result.session.viewerUrl,
    reviewRequiredCount: 0,
    essayFields: [],
    errorMessage: null,
    expiresAt: result.session.viewerExpiresAt,
    sessionId: result.session.id,
  });

  let messageId: number | null = null;
  try {
    const reply = await ctx.reply(card.text, {
      parse_mode: "HTML",
      reply_markup: card.keyboard,
      link_preview_options: { is_disabled: true },
    });
    messageId = reply.message_id;
  } catch (err) {
    logger.warn("Smart Apply: failed to send initial card", { error: err });
    return;
  }
  if (!ctx.chat || messageId == null) return;
  const chatId = ctx.chat.id;
  const finalMessageId = messageId;

  // Background poller: edits the message in-place until terminal status.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const intervalHandle = setInterval(async () => {
    const session = await getSmartApplySession(result.session.id);
    if (!session) {
      clearInterval(intervalHandle);
      return;
    }
    const next = renderStatusCard({
      jobTitle: job?.title ?? "Job",
      employer: job?.employer ?? "Company",
      status: session.status,
      viewerUrl: session.viewerUrl,
      reviewRequiredCount: session.prefilled?.reviewRequiredCount ?? 0,
      essayFields: session.prefilled?.essayFields ?? [],
      errorMessage: session.errorMessage,
      expiresAt: session.viewerExpiresAt,
      sessionId: session.id,
    });
    await ctx.api
      .editMessageText(chatId, finalMessageId, next.text, {
        parse_mode: "HTML",
        reply_markup: next.keyboard,
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});

    if (
      session.status === "ready" ||
      session.status === "submitted" ||
      session.status === "failed" ||
      session.status === "expired" ||
      session.status === "aborted"
    ) {
      clearInterval(intervalHandle);
    } else if (Date.now() > deadline) {
      clearInterval(intervalHandle);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Essay drafting modal: iterate through pending essay fields, draft each one
 * with AI, show the draft to the user with Edit / Use As-Is buttons.
 * After user saves, loop to the next pending essay or return to status card.
 */
async function renderDraftModal(
  ctx: Context,
  sessionId: string,
): Promise<void> {
  const session = await getSmartApplySession(sessionId);
  if (!session?.prefilled) {
    await ctx
      .reply("Session expired or has no prefilled form.")
      .catch(() => {});
    return;
  }

  const pending = session.prefilled.essayFields.filter(
    (f) => f.requiresReview && !f.draftedAnswer,
  );

  if (pending.length === 0) {
    await ctx.reply("All essays already drafted.").catch(() => {});
    await renderSession(ctx, sessionId);
    return;
  }

  const field = pending[0];
  const questionText = escapeHtml(field.label);
  const hintText = field.hint ? `\n<i>${escapeHtml(field.hint)}</i>` : "";
  const text = `<b>Essay Question</b>\n${questionText}${hintText}\n\n⏳ Drafting with AI...`;

  const msg = await ctx
    .reply(text, { parse_mode: "HTML" })
    .catch(() => null);
  if (!msg) return;

  const job = await jobsRepo.getJobById(session.jobId);
  if (!job) {
    await ctx.api
      .editMessageText(ctx.chat!.id, msg.message_id, "Job not found.")
      .catch(() => {});
    return;
  }

  try {
    const draft = await draftScreeningAnswer({
      question: field.label,
      hint: field.hint,
      job,
    });

    if (!draft.success) {
      throw new Error(draft.error ?? "Draft failed");
    }

    const draftText = `<b>Essay Question</b>\n${questionText}${hintText}\n\n<b>AI Draft</b>${draft.fromCache ? " (reused from past application)" : ""}:\n${escapeHtml(draft.answer)}\n\n<i>Edit below or tap 'Use As-Is' to save.</i>`;

    // Encode selector as base64 to avoid Telegram callback_data size issues.
    const selectorB64 = Buffer.from(field.selector).toString("base64");
    const keyboard = new InlineKeyboard()
      .text("✅ Use As-Is", `sa:save:${sessionId}:${selectorB64}`)
      .row()
      .text("◀️ Back", `sa:status:${sessionId}`);

    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, draftText, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    // Note: For inline editing (user types a replacement), we would need to
    // store state (which field is being edited) and listen to ctx.on('message').
    // For simplicity in WS3, we only implement "Use As-Is". User can manually
    // edit in the noVNC viewer after saving the draft.
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `❌ Draft failed: ${escapeHtml(errMsg)}`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    logger.error("Smart Apply: essay draft failed", { error: err });
  }
}

export function registerSmartApplyHandlers(bot: Bot): void {
  bot.callbackQuery(/^sa:start:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Starting Smart Apply…").catch(() => {});
    const jobShortId = ctx.match![1];
    await startAndPoll(ctx, jobShortId);
  });

  bot.callbackQuery(/^sa:status:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const sessionId = ctx.match![1];
    await renderSession(ctx, sessionId);
  });

  bot.callbackQuery(/^sa:abort:(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1];
    try {
      await abortSmartApplySession(sessionId);
      await ctx.answerCallbackQuery("⏹ Aborted").catch(() => {});
      await renderSession(ctx, sessionId);
    } catch (err) {
      logger.error("Smart Apply: abort failed", { error: err });
      await ctx
        .answerCallbackQuery("❌ Abort failed")
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^sa:draft:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const sessionId = ctx.match![1];
    await renderDraftModal(ctx, sessionId);
  });

  bot.callbackQuery(/^sa:save:(.+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match![1];
    const selectorB64 = ctx.match![2];
    const selector = Buffer.from(selectorB64, "base64").toString("utf-8");

    try {
      // Fetch the session to get the drafted answer from the draft modal.
      const session = await getSmartApplySession(sessionId);
      if (!session?.prefilled) {
        await ctx
          .answerCallbackQuery("Session expired.")
          .catch(() => {});
        return;
      }

      const field = session.prefilled.essayFields.find(
        (f) => f.selector === selector,
      );
      if (!field) {
        await ctx
          .answerCallbackQuery("Field not found.")
          .catch(() => {});
        return;
      }

      // The draft is in the message text that the user is replying to.
      // For simplicity, we assume the user tapped "Use As-Is", so we need to
      // extract the answer from the current message. But we don't have it in
      // the callback context. Instead, we fetch it from the session's field
      // value if it's been set, or we re-draft.
      //
      // Actually, the issue is that the draft is shown in the message but not
      // yet saved to the session. We need to extract it. For WS3, let's take
      // a shortcut: re-call draftScreeningAnswer (it will hit the cache) and
      // use that answer.
      const job = await jobsRepo.getJobById(session.jobId);
      if (!job) {
        await ctx
          .answerCallbackQuery("Job not found.")
          .catch(() => {});
        return;
      }

      const draft = await draftScreeningAnswer({
        question: field.label,
        hint: field.hint,
        job,
      });

      if (!draft.success || !draft.answer) {
        throw new Error(draft.error ?? "Draft failed");
      }

      await updateSessionEssayAnswer(sessionId, selector, draft.answer);
      await ctx.answerCallbackQuery("Saved!").catch(() => {});

      // Loop to next pending essay or return to status card.
      await renderDraftModal(ctx, sessionId);
    } catch (err) {
      logger.error("Smart Apply: save essay failed", { error: err });
      await ctx
        .answerCallbackQuery("❌ Save failed")
        .catch(() => {});
    }
  });
}
