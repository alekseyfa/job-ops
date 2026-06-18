import { logger } from "@infra/logger";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { discoverWorkdayUrl, parseWorkdayUrl } from "@extractors/ats-boards/src/workday";
import * as settingsRepo from "../../../repositories/settings";
import { awaitingInput } from "../awaiting-input";
import { escapeHtml } from "../formatting";
import {
  ATS_BOARD_PRESET_CATALOG,
  getPresetById,
} from "@shared/ats-board-presets";

interface AtsBoardEntry {
  provider: "greenhouse" | "ashby" | "lever" | "workday" | "smartrecruiters";
  slug: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  greenhouse: "🌿 Greenhouse",
  ashby: "🔷 Ashby",
  lever: "🔶 Lever",
  workday: "🏢 Workday",
  smartrecruiters: "📋 SmartRecruiters",
};

// awaitingInput action prefix for board flow: "board:<provider>"
const BOARD_PAGE_SIZE = 8;

function parseBoards(raw: string | null): AtsBoardEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getBoards(): Promise<AtsBoardEntry[]> {
  const raw = await settingsRepo.getSetting("atsBoardSlugs");
  return parseBoards(raw ?? null);
}

async function saveBoards(boards: AtsBoardEntry[]): Promise<void> {
  await settingsRepo.setSetting("atsBoardSlugs", JSON.stringify(boards));
}

function buildBoardsListView(
  boards: AtsBoardEntry[],
  page: number,
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(boards.length / BOARD_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageItems = boards.slice(
    safePage * BOARD_PAGE_SIZE,
    (safePage + 1) * BOARD_PAGE_SIZE,
  );

  let text = "<b>📡 ATS Boards</b>\n\n";
  text +=
    "Track company career pages directly.\n" +
    "Zero tokens — uses public ATS APIs.\n\n";

  if (boards.length === 0) {
    text += "<i>No companies tracked yet.</i>\n";
    text += "\nTap <b>+ Add</b> to start tracking.";
  } else {
    for (const [i, entry] of boards.entries()) {
      const label = PROVIDER_LABELS[entry.provider] ?? entry.provider;
      text += `${i + 1}. ${label} — <b>${escapeHtml(entry.slug)}</b>\n`;
    }
    text += `\n${boards.length} board(s) tracked.`;
  }

  const keyboard = new InlineKeyboard()
    .text("+ Add", "b:add")
    .text("📦 Presets", "b:presets")
    .row()
    .text("❓ Help", "b:help");

  if (boards.length > 0) {
    keyboard.row();
    for (let i = 0; i < pageItems.length; i++) {
      const globalIdx = safePage * BOARD_PAGE_SIZE + i;
      keyboard.text(`🗑 ${pageItems[i].slug}`, `b:rm:${globalIdx}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    }
    if (pageItems.length % 2 === 1) keyboard.row();

    if (totalPages > 1) {
      if (safePage > 0) keyboard.text("◀️", `b:menu:${safePage - 1}`);
      keyboard.text(`${safePage + 1}/${totalPages}`, "noop");
      if (safePage < totalPages - 1)
        keyboard.text("▶️", `b:menu:${safePage + 1}`);
      keyboard.row();
    }
  }

  keyboard.text("🏠 Menu", "m:menu");

  return { text, keyboard };
}

function logErr(scope: string, err: unknown): void {
  logger.error(scope, { error: err instanceof Error ? err.message : String(err) });
}

export function registerBoardHandlers(bot: Bot): void {
  // Board list menu — supports b:menu and b:menu:<page>
  bot.callbackQuery(/^b:menu(?::(\d+))?$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const page = ctx.match![1] ? parseInt(ctx.match![1], 10) : 0;
      const boards = await getBoards();
      const { text, keyboard } = buildBoardsListView(boards, page);

      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    } catch (err) {
      logErr("Boards menu error", err);
      await ctx.reply("❌ Failed to load boards.").catch((e) =>
        logErr("Boards reply error", e),
      );
    }
  });

  // Provider selection for adding
  bot.callbackQuery("b:add", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const keyboard = new InlineKeyboard()
        .text("🌿 Greenhouse", "b:p:greenhouse")
        .row()
        .text("🔷 Ashby", "b:p:ashby")
        .row()
        .text("🔶 Lever", "b:p:lever")
        .row()
        .text("🏢 Workday", "b:p:workday")
        .row()
        .text("📋 SmartRecruiters", "b:p:smartrecruiters")
        .row()
        .text("« Back", "b:menu");

      await ctx.editMessageText(
        "<b>Select ATS provider:</b>\n\n" +
          "🌿 <b>Greenhouse</b> — Stripe, Anthropic, Coinbase, Figma...\n" +
          "🔷 <b>Ashby</b> — Notion, Ramp, Linear, Vercel...\n" +
          "🔶 <b>Lever</b> — Netflix, Datadog, Twitch...\n" +
          '🏢 <b>Workday</b> — BMW, Siemens, Intel, Allianz... (auto-detect!)\n' +
          '📋 <b>SmartRecruiters</b> — Visa, IKEA, Bosch, Sanofi...',
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logErr("Boards add menu error", err);
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Provider chosen — await slug text input
  for (const provider of ["greenhouse", "ashby", "lever", "smartrecruiters"] as const) {
    bot.callbackQuery(`b:p:${provider}`, async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        awaitingInput.set(chatId, `board:${provider}`);

        const label = PROVIDER_LABELS[provider];
        await ctx.editMessageText(
          `${label}\n\n` +
            "Send the company <b>slug</b> (the part from the careers URL):\n\n" +
            "<i>Example: for jobs.greenhouse.io/<b>stripe</b>, send: stripe</i>\n\n" +
            "Send /cancel to go back.",
          { parse_mode: "HTML" },
        );
      } catch (err) {
        logErr(`Boards provider:${provider} prompt error`, err);
        await ctx.answerCallbackQuery("❌ Error").catch(() => {});
      }
    });
  }

  // Workday provider — auto-discovery flow
  bot.callbackQuery("b:p:workday", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      awaitingInput.set(chatId, "board:workday");

      await ctx.editMessageText(
        "🏢 <b>Workday</b>\n\n" +
          "Send the <b>company name</b> and I'll find the careers page automatically.\n\n" +
          "<i>Examples: BMW, Siemens, Intel, Allianz, Munich Re</i>\n\n" +
          "Or paste a full Workday URL:\n" +
          "<i>bmw.wd3.myworkdayjobs.com/BMW_Karriere_Extern</i>\n\n" +
          "Send /cancel to go back.",
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logErr("Boards workday prompt error", err);
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Remove board entry
  bot.callbackQuery(/^b:rm:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const index = parseInt(ctx.match[1], 10);
      const boards = await getBoards();

      if (index < 0 || index >= boards.length) {
        await ctx.answerCallbackQuery("Invalid index").catch(() => {});
        return;
      }

      const removed = boards[index];
      boards.splice(index, 1);
      await saveBoards(boards);

      await ctx.reply(
        `🗑 Removed <b>${escapeHtml(removed.slug)}</b> (${removed.provider})`,
        { parse_mode: "HTML" },
      );

      // Re-render list, snapping to a valid page after removal.
      const updatedBoards = await getBoards();
      const page = Math.min(
        Math.floor(index / BOARD_PAGE_SIZE),
        Math.max(0, Math.ceil(updatedBoards.length / BOARD_PAGE_SIZE) - 1),
      );
      const { text, keyboard } = buildBoardsListView(updatedBoards, page);
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (err) {
      logErr("Boards remove error", err);
      await ctx.reply("❌ Failed to remove board.").catch(() => {});
    }
  });

  // Preset list
  bot.callbackQuery("b:presets", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const keyboard = new InlineKeyboard();

      for (const preset of ATS_BOARD_PRESET_CATALOG) {
        keyboard.text(
          `${preset.name} (${preset.entries.length})`,
          `b:preset:${preset.id}`,
        );
        keyboard.row();
      }

      keyboard.text("« Back to Boards", "b:menu");

      await ctx.editMessageText(
        "<b>📦 ATS Board Presets</b>\n\n" +
          "Curated collections of high-value remote-first companies.\n" +
          "Tap a preset to preview and enable.\n\n" +
          "<i>Presets are one-click shortcuts to track multiple companies at once.</i>",
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logErr("Presets list error", err);
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Preset preview
  bot.callbackQuery(/^b:preset:([^:]+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const presetId = ctx.match![1];
      const preset = getPresetById(presetId);

      if (!preset) {
        await ctx.answerCallbackQuery("❌ Preset not found").catch(() => {});
        return;
      }

      const keyboard = new InlineKeyboard()
        .text("✅ Enable Preset", `b:preset:enable:${preset.id}`)
        .row()
        .text("« Back", "b:presets");

      await ctx.editMessageText(
        `<b>📦 ${escapeHtml(preset.name)}</b>\n\n` +
          `${escapeHtml(preset.description)}\n\n` +
          `<b>${preset.entries.length} companies</b> across Greenhouse, Ashby, and Lever.\n\n` +
          "<i>Tap 'Enable Preset' to add all companies to your tracked boards.</i>",
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logErr("Preset preview error", err);
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Preset enable
  bot.callbackQuery(/^b:preset:enable:([^:]+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const presetId = ctx.match![1];
      const preset = getPresetById(presetId);

      if (!preset) {
        await ctx.answerCallbackQuery("❌ Preset not found").catch(() => {});
        return;
      }

      const boards = await getBoards();
      const existingKeys = new Set(
        boards.map((b) => `${b.provider}:${b.slug}`),
      );

      let addedCount = 0;
      for (const entry of preset.entries) {
        const key = `${entry.provider}:${entry.slug}`;
        if (!existingKeys.has(key)) {
          boards.push({ provider: entry.provider, slug: entry.slug });
          existingKeys.add(key);
          addedCount++;
        }
      }

      if (addedCount === 0) {
        await ctx.editMessageText(
          `<b>📦 ${escapeHtml(preset.name)}</b>\n\n` +
            "✅ All companies from this preset are already tracked.\n\n" +
            "<i>0 new companies added.</i>",
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("📡 View Boards", "b:menu")
              .text("« Back", "b:presets"),
          },
        );
        return;
      }

      await saveBoards(boards);

      const keyboard = new InlineKeyboard()
        .text("📡 View Boards", "b:menu")
        .text("« Back", "b:presets");

      await ctx.editMessageText(
        `<b>✅ Preset Enabled</b>\n\n` +
          `Added <b>${addedCount}</b> companies from <i>${escapeHtml(preset.name)}</i>.\n\n` +
          "Jobs will appear in the next pipeline run.",
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logErr("Preset enable error", err);
      await ctx.reply("❌ Failed to enable preset.").catch(() => {});
    }
  });

  // Help
  bot.callbackQuery("b:help", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        "<b>📡 ATS Boards — Help</b>\n\n" +
          "Track companies directly from their ATS (Applicant Tracking System).\n\n" +
          "<b>How it works:</b>\n" +
          "1. Add a company by its ATS slug or name\n" +
          "2. Pipeline automatically fetches their open positions\n" +
          "3. Zero LLM tokens used — direct API access\n\n" +
          "<b>Finding slugs:</b>\n" +
          "• <code>jobs.greenhouse.io/stripe</code> → slug: <b>stripe</b>\n" +
          "• <code>jobs.ashbyhq.com/notion</code> → slug: <b>notion</b>\n" +
          "• <code>jobs.lever.co/netflix</code> → slug: <b>netflix</b>\n" +
          '• 🏢 Workday: just type company name (e.g. "BMW") — auto-detected!\n\n' +
          "<b>Popular companies:</b>\n" +
          "🌿 Greenhouse: stripe, anthropic, coinbase, figma, datadog\n" +
          "🔷 Ashby: notion, ramp, linear, vercel, supabase\n" +
          "🔶 Lever: netflix, twitch, clearbit\n" +
          "🏢 Workday: BMW, Siemens, Intel, Allianz, Infineon\n" +
          "📋 SmartRecruiters: Visa, IKEA, Bosch, Sanofi",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("« Back", "b:menu"),
        },
      );
    } catch (err) {
      logErr("Boards help error", err);
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Text input handler for slug
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const action = awaitingInput.get(chatId);
    if (!action || !action.startsWith("board:")) return next();
    awaitingInput.delete(chatId);

    const provider = action.slice("board:".length);
    const text = ctx.message.text.trim();

    if (text === "/cancel") {
      await ctx.reply("Cancelled.");
      return;
    }

    if (provider === "workday" || provider === "workday_manual") {
      await handleWorkdayInput(ctx, text, provider === "workday_manual");
      return;
    }

    if (!/^[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(text) || text.length > 100) {
      await ctx.reply(
        "Invalid slug. Use only letters, numbers, and hyphens.\nExample: <b>stripe</b>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const slug = text.toLowerCase();
    const boards = await getBoards();

    const exists = boards.some(
      (b) => b.provider === provider && b.slug === slug,
    );
    if (exists) {
      await ctx.reply(
        `Already tracking <b>${escapeHtml(slug)}</b> on ${PROVIDER_LABELS[provider]}.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    boards.push({ provider: provider as AtsBoardEntry["provider"], slug });
    await saveBoards(boards);

    const keyboard = new InlineKeyboard()
      .text("📡 View Boards", "b:menu")
      .text("+ Add More", "b:add");

    await ctx.reply(
      `✅ Added ${PROVIDER_LABELS[provider]} — <b>${escapeHtml(slug)}</b>\n\n` +
        "Jobs will appear in the next pipeline run.",
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });
}

async function handleWorkdayInput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { chat?: { id: number }; reply: (...args: any[]) => Promise<any> },
  text: string,
  isManualUrl: boolean,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (text.includes("myworkdayjobs.com")) {
    const config = parseWorkdayUrl(text);
    if (!config) {
      await ctx.reply(
        "Invalid Workday URL. Expected format:\n" +
          "<i>bmw.wd3.myworkdayjobs.com/BMW_Karriere_Extern</i>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const slug = `${config.subdomain}.${new URL(config.baseUrl).hostname.match(/\.wd\d+\./)?.[0]?.slice(1, -1) ?? "wd1"}.myworkdayjobs.com/${config.companyIdRaw}`;
    await addWorkdayBoard(ctx, slug);
    return;
  }

  if (isManualUrl) {
    await ctx.reply(
      "Please paste a full Workday careers URL containing <b>myworkdayjobs.com</b>.",
      { parse_mode: "HTML" },
    );
    return;
  }

  await ctx.reply(
    `🔍 Searching for <b>${escapeHtml(text)}</b> on Workday...`,
    { parse_mode: "HTML" },
  );

  try {
    const discovered = await discoverWorkdayUrl(text);
    if (discovered) {
      await addWorkdayBoard(ctx, discovered);
    } else {
      awaitingInput.set(chatId, "board:workday_manual");
      await ctx.reply(
        `Could not auto-detect Workday page for "<b>${escapeHtml(text)}</b>".\n\n` +
          "Please paste the full Workday careers URL:\n" +
          "<i>example.wd3.myworkdayjobs.com/External</i>\n\n" +
          "Send /cancel to go back.",
        { parse_mode: "HTML" },
      );
    }
  } catch (err) {
    logErr("Workday auto-discovery error", err);
    awaitingInput.set(chatId, "board:workday_manual");
    await ctx.reply(
      "Auto-detection failed (network error). Please paste the full Workday URL:\n" +
        "<i>example.wd3.myworkdayjobs.com/External</i>\n\n" +
        "Send /cancel to go back.",
      { parse_mode: "HTML" },
    );
  }
}

async function addWorkdayBoard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { reply: (...args: any[]) => Promise<any> },
  slug: string,
): Promise<void> {
  const boards = await getBoards();

  const exists = boards.some(
    (b) => b.provider === "workday" && b.slug === slug,
  );
  if (exists) {
    await ctx.reply(
      `Already tracking <b>${escapeHtml(slug)}</b> on 🏢 Workday.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  boards.push({ provider: "workday", slug });
  await saveBoards(boards);

  const keyboard = new InlineKeyboard()
    .text("📡 View Boards", "b:menu")
    .text("+ Add More", "b:add");

  await ctx.reply(
    `✅ Added 🏢 Workday — <b>${escapeHtml(slug)}</b>\n\n` +
      "Jobs will appear in the next pipeline run.",
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}
