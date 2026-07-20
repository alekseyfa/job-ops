import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { resolveChatContext } from "@server/repositories/telegram-links";
import { Bot, type Context, InlineKeyboard } from "grammy";
import {
  clearLinkAttempts,
  isAuthorized,
  redeemLinkCode,
  registerLinkAttempt,
} from "./auth";
import { sendFullChangelog } from "./changelog-notifications";

let bot: Bot | null = null;

export function getBot(): Bot | null {
  return bot;
}

// Commands allowed before authorization. Match must be exact, or followed by
// whitespace / argument — so "/startfoo" never bypasses auth.
const PUBLIC_COMMANDS = new Set(["/start", "/link", "/help"]);

function extractCommand(text: string): string | null {
  if (!text.startsWith("/")) return null;
  // Strip optional @botname suffix and grab the command token.
  const token = text.split(/\s+/, 1)[0] ?? "";
  const stripped = token.split("@", 1)[0] ?? "";
  return stripped || null;
}

export function createBot(token: string): Bot {
  // Grammy uses fetch internally; HTTPS_PROXY is honoured via the global
  // undici dispatcher installed at startup (see config/proxy.ts).
  const botInstance = new Bot(token);

  botInstance.catch((err) => {
    logger.error("Telegram bot error", {
      error: err.message,
      ctx: err.ctx?.update?.update_id,
    });
  });

  // Auth + tenant-context middleware — runs before all handlers.
  //
  // This is the ONE place the bot establishes a request context. Because grammy
  // middleware is linear and next() is awaited, wrapping next() in
  // runWithRequestContext propagates {userId, tenantId} via AsyncLocalStorage to
  // EVERY downstream handler and repository call — so the bot is tenant-isolated
  // with a single wrapper. Unlinked chats are rejected before any DB read.
  botInstance.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const text = ctx.message?.text || "";
    const command = extractCommand(text);
    if (command && PUBLIC_COMMANDS.has(command)) {
      // /start, /link, /help manage their own context (they run pre-link).
      return next();
    }

    const chatContext = await resolveChatContext(chatId);
    if (!chatContext) {
      await ctx.reply(
        "🔒 Not authorized. Open Job Ops → Settings → Link Telegram to get a code, then send /link <code>.",
      );
      return;
    }

    return runWithRequestContext(
      {
        tenantId: chatContext.tenantId,
        userId: chatContext.userId,
        requestId: `tg:${chatId}:${ctx.update.update_id}`,
      },
      () => next(),
    );
  });

  // /start command
  botInstance.command("start", async (ctx) => {
    const chatId = ctx.chat.id;
    const chatContext = await resolveChatContext(chatId);
    if (chatContext) {
      // Establish tenant context so the menu's stats/greeting are scoped.
      await runWithRequestContext(
        { tenantId: chatContext.tenantId, userId: chatContext.userId },
        () => sendMainMenu(ctx),
      );
    } else {
      await ctx.reply(
        "👋 Welcome to Job Ops Bot!\n\n" +
          "To connect, get a link code from Job Ops Settings page, then send:\n" +
          "/link <code>",
      );
    }
  });

  // /link command — register chat ID
  botInstance.command("link", async (ctx) => {
    const chatId = ctx.chat.id;

    // Throttle brute-force attempts per-chat.
    const gate = registerLinkAttempt(chatId);
    if (!gate.allowed) {
      await ctx.reply(
        `⏳ Too many attempts. Try again in ~${Math.ceil((gate.retryInSeconds ?? 60) / 60)} min.`,
      );
      return;
    }

    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply("Usage: /link <code>\nGet the code from Job Ops Settings.");
      return;
    }

    const binding = await redeemLinkCode(chatId, code);
    if (binding) {
      clearLinkAttempts(chatId);
      // Ensure this tenant now receives proactive pipeline notifications
      // (no restart needed). Idempotent.
      const { ensureTenantSubscribed } = await import("./notifications");
      ensureTenantSubscribed(binding.tenantId);
      await ctx.reply("✅ Linked successfully! You can now use the bot.");
      // Render the menu inside the freshly-bound tenant context.
      await runWithRequestContext(
        { tenantId: binding.tenantId, userId: binding.userId },
        () => sendMainMenu(ctx),
      );
      // Send changelog to newly linked user so they know about recent features
      sendFullChangelog(chatId).catch((err) => {
        logger.warn("Failed to send full changelog to new user", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      await ctx.reply("❌ Invalid or expired code. Get a new one from Settings.");
    }
  });

  // /menu command
  botInstance.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  // /help command — /help is whitelisted as a public command, so it must have a
  // handler (otherwise typing it is silent). Works for unlinked users too.
  botInstance.command("help", async (ctx) => {
    const linked = ctx.chat ? await isAuthorized(ctx.chat.id) : false;
    const lines = [
      "<b>🤖 Job Ops Bot — Help</b>",
      "",
      "<b>Commands</b>",
      "/menu — main menu (jobs, pipeline, stats, settings)",
      "/search &lt;keyword&gt; — find jobs by title, company, or location",
      "/insights — application funnel &amp; trends",
      "/interview — interview prep (STAR stories, Q&amp;A)",
      "/sync — sync application emails now",
      "/gmail — email sync status",
      "/changelog — what's new",
      "/help — this message",
    ];
    if (!linked) {
      lines.push(
        "",
        "<b>Not linked yet?</b>",
        "Open Job Ops → Settings → get a link code, then send:",
        "<code>/link &lt;code&gt;</code>",
      );
    }
    const keyboard = new InlineKeyboard();
    if (linked) keyboard.text("🏠 Menu", "m:menu");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: linked ? keyboard : undefined,
    });
  });

  // m:menu callback — every "◀️ Menu" button across the bot lands here.
  // Single canonical implementation in this file.
  botInstance.callbackQuery("m:menu", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await sendMainMenu(ctx);
    } catch (err) {
      logger.error("Main menu render failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerCallbackQuery("❌ Error loading menu").catch(() => {});
    }
  });

  // /changelog command — show full changelog history
  botInstance.command("changelog", async (ctx) => {
    await sendFullChangelog(ctx.chat.id);
  });

  // /search <query> — find jobs by title, employer, or location
  botInstance.command("search", async (ctx) => {
    const { searchJobs } = await import("../../repositories/jobs");
    const { escapeHtml, formatJobListItem } = await import("./formatting");

    const query = (ctx.match || "").trim();
    if (!query) {
      await ctx.reply(
        "Usage: <code>/search &lt;keyword&gt;</code>\n" +
          "<i>Searches across job title, company, and location.</i>\n" +
          "Examples: <code>/search Berlin</code>, <code>/search Senior PM</code>, <code>/search BMW</code>",
        { parse_mode: "HTML" },
      );
      return;
    }

    if (query.length < 2) {
      await ctx.reply("🔎 Query too short. Use at least 2 characters.");
      return;
    }

    try {
      const results = await searchJobs(query, 20);
      if (results.length === 0) {
        await ctx.reply(`🔎 No jobs match <b>${escapeHtml(query)}</b>.`, {
          parse_mode: "HTML",
        });
        return;
      }

      const text =
        `<b>🔎 Search: ${escapeHtml(query)} (${results.length})</b>\n\n` +
        results.map((j, i) => formatJobListItem(j, i)).join("\n\n");

      const keyboard = new InlineKeyboard();
      for (const j of results.slice(0, 10)) {
        const shortId = j.id.slice(0, 8);
        const score = j.suitabilityScore !== null ? `⭐${j.suitabilityScore}` : "";
        const company = j.employer.slice(0, 15);
        const title = j.title.slice(0, 22);
        keyboard.text(`${score} ${title} · ${company}`, `j:d:${shortId}`).row();
      }
      keyboard.text("◀️ Menu", "m:menu");

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err) {
      logger.error("Search command error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply("❌ Search failed. Try again.");
    }
  });

  bot = botInstance;
  return botInstance;
}

/**
 * Render the canonical main menu.  Works both as a /menu command response
 * (uses ctx.reply for a fresh message) and as a "back to menu" callback
 * (uses ctx.editMessageText to replace the previous screen in-place).
 *
 * Fallback: when editMessageText fails (e.g. message older than 48h or the
 * inline message has gone missing), we silently fall back to ctx.reply so
 * the user never gets stuck on an "Error loading menu" toast.
 */
export async function sendMainMenu(ctx: Context): Promise<void> {
  const { getJobStats } = await import("../../repositories/jobs");
  const { escapeHtml } = await import("./formatting");
  const { getCandidateNameParts } = await import(
    "../candidate-profile"
  );
  const stats = await getJobStats();

  const ready = stats.ready || 0;
  const applied = stats.applied || 0;
  const discovered = stats.discovered || 0;

  // Identity comes from the uploaded resume (the single source of truth), NOT
  // ctx.from.first_name — see CLAUDE.md "Candidate Identity". Falls back to no
  // greeting if the resume has no name yet.
  let name = "";
  try {
    name = (await getCandidateNameParts()).firstName ?? "";
  } catch {
    name = "";
  }
  const greeting = name ? ` ${escapeHtml(name)}` : "";

  const text =
    `<b>🏠 Job Ops${greeting}</b>\n\n` +
    `📋 ${ready} ready · ${applied} applied · ${discovered} discovered`;

  // Single source of truth for the main menu layout.  Every "Menu" button
  // anywhere in the bot now renders the same set of options.
  const keyboard = new InlineKeyboard()
    .text("🔍 Pipeline", "p:status")
    .text("📋 Jobs", "j:ready:0")
    .row()
    .text("📊 Stats", "s:stats")
    .text("📈 Insights", "i:w:30")
    .row()
    .text("🎤 Interview Prep", "ip:menu")
    .text("📬 Email Sync", "g:status")
    .row()
    .text("📡 Boards", "b:menu")
    .text("⚙️ Settings", "x:menu");

  const options = {
    parse_mode: "HTML" as const,
    reply_markup: keyboard,
  };

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      // Message too old to edit or otherwise gone — fall through to reply.
    }
  }
  await ctx.reply(text, options);
}
