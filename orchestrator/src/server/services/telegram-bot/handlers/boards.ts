import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import * as settingsRepo from "../../../repositories/settings";
import { escapeHtml } from "../formatting";

interface AtsBoardEntry {
  provider: "greenhouse" | "ashby" | "lever";
  slug: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  greenhouse: "🌿 Greenhouse",
  ashby: "🔷 Ashby",
  lever: "🔶 Lever",
};

// Shared state for text input collection
export const awaitingBoardInput = new Map<number, string>();

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

export function registerBoardHandlers(bot: Bot): void {
  // Board list menu
  bot.callbackQuery("b:menu", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const boards = await getBoards();

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
        .text("❓ Help", "b:help");

      if (boards.length > 0) {
        keyboard.row();
        // Show remove buttons (max 8 per page)
        const shown = boards.slice(0, 8);
        for (let i = 0; i < shown.length; i++) {
          keyboard.text(
            `🗑 ${shown[i].slug}`,
            `b:rm:${i}`,
          );
          if ((i + 1) % 2 === 0) keyboard.row();
        }
      }

      keyboard.row().text("🏠 Menu", "m:menu");

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() =>
        ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard }),
      );
    } catch (error) {
      await ctx.reply("Failed to load boards.").catch(() => {});
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
        .text("« Back", "b:menu");

      await ctx.editMessageText(
        "<b>Select ATS provider:</b>\n\n" +
          "🌿 <b>Greenhouse</b> — Stripe, Anthropic, Coinbase, Figma...\n" +
          "🔷 <b>Ashby</b> — Notion, Ramp, Linear, Vercel...\n" +
          "🔶 <b>Lever</b> — Netflix, Datadog, Twitch...",
        { parse_mode: "HTML", reply_markup: keyboard },
      ).catch(() => {});
    } catch {
      await ctx.reply("Error").catch(() => {});
    }
  });

  // Provider chosen — await slug text input
  for (const provider of ["greenhouse", "ashby", "lever"] as const) {
    bot.callbackQuery(`b:p:${provider}`, async (ctx) => {
      try {
        await ctx.answerCallbackQuery();
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        awaitingBoardInput.set(chatId, provider);

        const label = PROVIDER_LABELS[provider];
        await ctx.editMessageText(
          `${label}\n\n` +
            "Send the company <b>slug</b> (the part from the careers URL):\n\n" +
            "<i>Example: for jobs.greenhouse.io/<b>stripe</b>, send: stripe</i>\n\n" +
            "Send /cancel to go back.",
          { parse_mode: "HTML" },
        ).catch(() => {});
      } catch {
        await ctx.reply("Error").catch(() => {});
      }
    });
  }

  // Remove board entry
  bot.callbackQuery(/^b:rm:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const index = parseInt(ctx.match[1], 10);
      const boards = await getBoards();

      if (index >= 0 && index < boards.length) {
        const removed = boards[index];
        boards.splice(index, 1);
        await saveBoards(boards);

        await ctx.reply(
          `🗑 Removed <b>${escapeHtml(removed.slug)}</b> (${removed.provider})`,
          { parse_mode: "HTML" },
        );
      }

      // Refresh the menu by simulating the callback
      // Re-render boards menu
      const updatedBoards = await getBoards();
      let text = "<b>📡 ATS Boards</b>\n\n";
      if (updatedBoards.length === 0) {
        text += "<i>No companies tracked yet.</i>\n\nTap <b>+ Add</b> to start tracking.";
      } else {
        for (const [i, entry] of updatedBoards.entries()) {
          const label = PROVIDER_LABELS[entry.provider] ?? entry.provider;
          text += `${i + 1}. ${label} — <b>${escapeHtml(entry.slug)}</b>\n`;
        }
        text += `\n${updatedBoards.length} board(s) tracked.`;
      }
      const keyboard = new InlineKeyboard()
        .text("+ Add", "b:add")
        .text("❓ Help", "b:help");
      if (updatedBoards.length > 0) {
        keyboard.row();
        for (let i = 0; i < Math.min(updatedBoards.length, 8); i++) {
          keyboard.text(`🗑 ${updatedBoards[i].slug}`, `b:rm:${i}`);
          if ((i + 1) % 2 === 0) keyboard.row();
        }
      }
      keyboard.row().text("🏠 Menu", "m:menu");
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch(() => {});
    } catch {
      await ctx.reply("Failed to remove board.").catch(() => {});
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
          "1. Add a company by its ATS slug\n" +
          "2. Pipeline automatically fetches their open positions\n" +
          "3. Zero LLM tokens used — direct API access\n\n" +
          "<b>Finding slugs:</b>\n" +
          "• <code>jobs.greenhouse.io/stripe</code> → slug: <b>stripe</b>\n" +
          "• <code>jobs.ashbyhq.com/notion</code> → slug: <b>notion</b>\n" +
          "• <code>jobs.lever.co/netflix</code> → slug: <b>netflix</b>\n\n" +
          "<b>Popular companies:</b>\n" +
          "🌿 Greenhouse: stripe, anthropic, coinbase, figma, datadog\n" +
          "🔷 Ashby: notion, ramp, linear, vercel, supabase\n" +
          "🔶 Lever: netflix, twitch, clearbit",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("« Back", "b:menu"),
        },
      ).catch(() => {});
    } catch {
      await ctx.reply("Error").catch(() => {});
    }
  });

  // Text input handler for slug
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const provider = awaitingBoardInput.get(chatId);
    if (!provider) return next();
    awaitingBoardInput.delete(chatId);

    const text = ctx.message.text.trim();

    // Allow cancel
    if (text === "/cancel") {
      await ctx.reply("Cancelled.");
      return;
    }

    // Validate slug: alphanumeric + hyphens only
    if (!/^[a-zA-Z0-9][-a-zA-Z0-9]*$/.test(text) || text.length > 100) {
      await ctx.reply(
        "Invalid slug. Use only letters, numbers, and hyphens.\nExample: <b>stripe</b>",
        { parse_mode: "HTML" },
      );
      return;
    }

    const slug = text.toLowerCase();
    const boards = await getBoards();

    // Check for duplicates
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
