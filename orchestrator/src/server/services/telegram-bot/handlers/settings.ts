import { logger } from "@infra/logger";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import * as settingsRepo from "../../../repositories/settings";
import { initializePipelineScheduler, getPipelineSchedulerStatus } from "../../pipeline-scheduler";
import { generateLinkCode } from "../auth";
import { awaitingInput } from "../awaiting-input";
import { escapeHtml } from "../formatting";

const TIMEZONES = [
  { label: "London (GMT)", tz: "Europe/London" },
  { label: "Berlin (CET)", tz: "Europe/Berlin" },
  { label: "Moscow (MSK)", tz: "Europe/Moscow" },
  { label: "Dubai (GST)", tz: "Asia/Dubai" },
  { label: "Mumbai (IST)", tz: "Asia/Kolkata" },
  { label: "Singapore (SGT)", tz: "Asia/Singapore" },
  { label: "Tokyo (JST)", tz: "Asia/Tokyo" },
  { label: "Sydney (AEST)", tz: "Australia/Sydney" },
  { label: "New York (EST)", tz: "America/New_York" },
  { label: "Chicago (CST)", tz: "America/Chicago" },
  { label: "Denver (MST)", tz: "America/Denver" },
  { label: "LA (PST)", tz: "America/Los_Angeles" },
];

function formatLocalHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatInstantInTz(iso: string, tz: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", {
      timeZone: tz,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getTzShortLabel(tz: string): string {
  const entry = TIMEZONES.find((t) => t.tz === tz);
  return entry ? entry.label : tz;
}

// Shared awaiting-input state lives in ../awaiting-input. We prefix actions
// with "settings:" so other handlers' middleware ignores our prompts.
const BLOCKED_PAGE_SIZE = 8;

function parseBlockedKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// ── Apply Profile field metadata ────────────────────────────────────
// Data-driven so adding a reusable answer is a one-line change. `shortKey`
// keeps Telegram callback_data small; `settingKey` is the registry key.
type ApplyFieldKind = "text" | "number" | "tristate" | "bool";

interface ApplyProfileField {
  shortKey: string;
  settingKey: import("../../../repositories/settings").SettingKey;
  label: string;
  prompt: string;
  kind: ApplyFieldKind;
}

const APPLY_PROFILE_FIELDS: ApplyProfileField[] = [
  { shortKey: "li", settingKey: "applyLinkedinUrl", label: "LinkedIn URL", prompt: "Your LinkedIn profile URL.", kind: "text" },
  { shortKey: "gh", settingKey: "applyGithubUrl", label: "GitHub URL", prompt: "Your GitHub profile URL.", kind: "text" },
  { shortKey: "pf", settingKey: "applyPortfolioUrl", label: "Portfolio URL", prompt: "Your portfolio / personal website URL.", kind: "text" },
  { shortKey: "np", settingKey: "applyNoticePeriod", label: "Notice Period", prompt: "e.g. \"Immediately\", \"1 month\", \"3 months\".", kind: "text" },
  { shortKey: "sal", settingKey: "applyDesiredSalary", label: "Desired Salary", prompt: "e.g. \"90,000 EUR\" or \"$120k\". Free text — matches how forms ask.", kind: "text" },
  { shortKey: "yrs", settingKey: "applyYearsExperience", label: "Years of Experience", prompt: "A whole number, e.g. 8.", kind: "number" },
  { shortKey: "vs", settingKey: "applyRequiresVisaSponsorship", label: "Needs Visa Sponsorship", prompt: "", kind: "tristate" },
  { shortKey: "eeo", settingKey: "applyDeclineDemographics", label: "Decline EEO/Demographics", prompt: "", kind: "bool" },
];

function displayApplyValue(field: ApplyProfileField, raw: string | null): string {
  if (field.kind === "tristate") {
    if (raw === "1" || raw === "true") return "Yes";
    if (raw === "0" || raw === "false") return "No";
    return "— (ask each time)";
  }
  if (field.kind === "bool") {
    // Decline demographics defaults ON when unset.
    return raw === "0" || raw === "false" ? "Off" : "On";
  }
  if (!raw || raw.trim() === "") return "— (not set)";
  return raw.length > 40 ? `${raw.slice(0, 37)}…` : raw;
}

// Cycle a boolean/tri-state toggle. tri-state: null → true → false → null.
function cycleToggle(current: string | null, kind: ApplyFieldKind): string | null {
  if (kind === "bool") {
    return current === "0" || current === "false" ? "1" : "0";
  }
  // tri-state
  if (current === null || current === "" ) return "1";
  if (current === "1" || current === "true") return "0";
  return null; // was "0"/false → back to unset
}

async function renderApplyProfileMenu(
  ctx: { editMessageText: (t: string, o: object) => Promise<unknown> },
): Promise<void> {
  const values = await Promise.all(
    APPLY_PROFILE_FIELDS.map(async (f) => ({
      field: f,
      raw: await settingsRepo.getSetting(f.settingKey),
    })),
  );

  let text = "<b>🧾 Apply Profile</b>\n\n";
  text +=
    "Reusable answers Smart Apply fills on every application form, so you " +
    "stop re-typing the same things. Left blank = you fill it per job.\n\n";
  for (const { field, raw } of values) {
    text += `• <b>${escapeHtml(field.label)}</b>: ${escapeHtml(displayApplyValue(field, raw))}\n`;
  }
  text +=
    "\n<i>Note: work-authorization (\"authorized to work in X?\") is never " +
    "auto-answered — it depends on the country. Sponsorship + EEO answers are " +
    "pre-selected but you confirm them in the browser.</i>";

  const keyboard = new InlineKeyboard();
  for (const { field } of values) {
    const action =
      field.kind === "text" || field.kind === "number"
        ? `x:ap:set:${field.shortKey}`
        : `x:ap:tog:${field.shortKey}`;
    keyboard.text(`✏️ ${field.label}`, action).row();
  }
  keyboard.text("◀️ Settings", "x:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
}

export function registerSettingsHandlers(bot: Bot): void {
  // Settings menu
  bot.callbackQuery("x:menu", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();

      const schedVal = await settingsRepo.getSetting("pipelineScheduleEnabled");
      const scheduleEnabled = schedVal === "1" || schedVal === "true";
      const scheduleHour = await settingsRepo.getSetting("pipelineScheduleHour") || "8";
      const notifVal = await settingsRepo.getSetting("telegramNotificationsEnabled");
      const notifEnabled = notifVal !== "0" && notifVal !== "false";
      const userTz = await settingsRepo.getSetting("userTimezone") || "Europe/Berlin";
      const scheduler = getPipelineSchedulerStatus();

      const hour = parseInt(scheduleHour, 10);
      const localTime = formatLocalHour(hour);
      const tzLabel = getTzShortLabel(userTz);
      const nextRunLocal = scheduler.nextRun
        ? formatInstantInTz(scheduler.nextRun, userTz)
        : null;

      let text = "<b>⚙️ Settings</b>\n\n";
      text += `🕐 Pipeline: ${scheduleEnabled ? `✅ ${localTime} (${tzLabel})` : "❌ Disabled"}\n`;
      if (nextRunLocal) text += `Next run: ${nextRunLocal} (${tzLabel})\n`;
      text += `🌍 Timezone: ${tzLabel}\n`;
      text += `🔔 Notifications: ${notifEnabled ? "✅ Enabled" : "🔕 Disabled"}\n`;

      const keyboard = new InlineKeyboard()
        .text(scheduleEnabled ? "⏹ Disable" : "▶️ Enable", "x:sched")
        .text(`🕐 Time (${localTime})`, "x:time")
        .row()
        .text(`🌍 Timezone`, "x:tz")
        .text(notifEnabled ? "🔕 Mute" : "🔔 Unmute", "x:notif")
        .row()
        .text("📡 Boards", "b:menu")
        .text("🚫 Blocked Companies", "x:blocked:0")
        .row()
        .text("🧾 Apply Profile", "x:ap")
        .text("🔗 Link Code", "x:link")
        .row()
        .text("◀️ Back", "m:menu");

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (err) {
      logger.error("Settings menu error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error loading settings").catch(() => {});
    }
  });

  // Toggle schedule
  bot.callbackQuery("x:sched", async (ctx) => {
    try {
      const schedVal = await settingsRepo.getSetting("pipelineScheduleEnabled");
      const current = schedVal === "1" || schedVal === "true";
      const newValue = !current;

      await settingsRepo.setSetting("pipelineScheduleEnabled", newValue ? "1" : "0");
      await initializePipelineScheduler();

      await ctx.answerCallbackQuery(newValue ? "Schedule enabled!" : "Schedule disabled!");

      const keyboard = new InlineKeyboard().text("◀️ Settings", "x:menu").text("◀️ Menu", "m:menu");
      await ctx.editMessageText(
        `✅ Pipeline schedule ${newValue ? "enabled" : "disabled"}.`,
        { reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Toggle schedule error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error toggling schedule").catch(() => {});
    }
  });

  // Toggle notifications
  bot.callbackQuery("x:notif", async (ctx) => {
    try {
      const notifVal = await settingsRepo.getSetting("telegramNotificationsEnabled");
      const current = notifVal !== "0" && notifVal !== "false";
      const newValue = !current;

      await settingsRepo.setSetting("telegramNotificationsEnabled", newValue ? "1" : "0");

      await ctx.answerCallbackQuery(newValue ? "Notifications enabled!" : "Notifications muted!");
      const keyboard = new InlineKeyboard().text("◀️ Settings", "x:menu").text("◀️ Menu", "m:menu");
      await ctx.editMessageText(
        `${newValue ? "🔔" : "🔕"} Notifications ${newValue ? "enabled" : "muted"}.`,
        { reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Toggle notifications error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error toggling notifications").catch(() => {});
    }
  });

  // Timezone picker
  bot.callbackQuery("x:tz", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const currentTz = await settingsRepo.getSetting("userTimezone") || "Europe/Berlin";

      const keyboard = new InlineKeyboard();
      for (let i = 0; i < TIMEZONES.length; i++) {
        const { label, tz } = TIMEZONES[i];
        const display = tz === currentTz ? `[${label}]` : label;
        keyboard.text(display, `x:tz:${i}`);
        if (i % 2 === 1) keyboard.row();
      }
      if (TIMEZONES.length % 2 === 1) keyboard.row();
      keyboard.text("◀️ Back", "x:menu");

      await ctx.editMessageText(
        `<b>🌍 Select Timezone</b>\n\nCurrent: <b>${escapeHtml(getTzShortLabel(currentTz))}</b>`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Timezone picker error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error loading timezones").catch(() => {});
    }
  });

  // Set timezone
  bot.callbackQuery(/^x:tz:(\d+)$/, async (ctx) => {
    try {
      const idx = parseInt(ctx.match![1], 10);
      const entry = TIMEZONES[idx];
      if (!entry) {
        await ctx.answerCallbackQuery("Invalid timezone");
        return;
      }

      await settingsRepo.setSetting("userTimezone", entry.tz);
      await ctx.answerCallbackQuery(`Timezone set to ${entry.label}`);

      await ctx.editMessageText(
        `✅ Timezone set to <b>${escapeHtml(entry.label)}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Settings", "x:menu").text("◀️ Menu", "m:menu"),
        },
      );
    } catch (err) {
      logger.error("Set timezone error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error setting timezone").catch(() => {});
    }
  });

  // Time picker — show hour grid
  bot.callbackQuery("x:time", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const currentHour = await settingsRepo.getSetting("pipelineScheduleHour") || "8";
      const userTz = await settingsRepo.getSetting("userTimezone") || "Europe/Berlin";
      const tzLabel = getTzShortLabel(userTz);

      const keyboard = new InlineKeyboard();
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 6; col++) {
          const h = row * 6 + col;
          const label = h === parseInt(currentHour, 10) ? `[${h}:00]` : `${h}:00`;
          keyboard.text(label, `x:h:${h}`);
        }
        keyboard.row();
      }
      keyboard.text("◀️ Back", "x:menu");

      const currentLocalTime = formatLocalHour(parseInt(currentHour, 10));

      await ctx.editMessageText(
        `<b>🕐 Set Pipeline Schedule Time</b>\n\nCurrent: <b>${currentLocalTime} (${escapeHtml(tzLabel)})</b>\n\nPick an hour in <b>${escapeHtml(tzLabel)}</b>:`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Time picker error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error loading time picker").catch(() => {});
    }
  });

  // Set specific hour
  bot.callbackQuery(/^x:h:(\d+)$/, async (ctx) => {
    try {
      const hour = parseInt(ctx.match![1], 10);
      if (hour < 0 || hour > 23) {
        await ctx.answerCallbackQuery("Invalid hour");
        return;
      }

      await settingsRepo.setSetting("pipelineScheduleHour", String(hour));
      await initializePipelineScheduler();

      const userTz = await settingsRepo.getSetting("userTimezone") || "Europe/Berlin";
      const localTime = formatLocalHour(hour);
      const tzLabel = getTzShortLabel(userTz);

      await ctx.answerCallbackQuery(`Schedule set to ${localTime}`);

      await ctx.editMessageText(
        `✅ Pipeline schedule set to <b>${localTime} (${escapeHtml(tzLabel)})</b>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Settings", "x:menu").text("◀️ Menu", "m:menu"),
        },
      );
    } catch (err) {
      logger.error("Set hour error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error setting hour").catch(() => {});
    }
  });

  // Generate link code
  bot.callbackQuery("x:link", async (ctx) => {
    try {
      const code = generateLinkCode();
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `<b>🔗 Link Code</b>\n\n<code>${code}</code>\n\n<i>Tap the code above to copy it.</i>\n\nSend this to another user. Expires in 5 minutes.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Settings", "x:menu"),
        },
      );
    } catch (err) {
      logger.error("Link code error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error generating link code").catch(() => {});
    }
  });

  // ── Apply Profile ─────────────────────────────────────────────────
  // Reusable non-resume answers that Smart Apply pre-fills on every form, so
  // the user stops re-typing the same LinkedIn/salary/notice/sponsorship
  // answers. Backed by the `apply*` settings (settings-registry.ts).

  bot.callbackQuery("x:ap", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      await renderApplyProfileMenu(ctx);
    } catch (err) {
      logger.error("Apply profile menu error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Prompt for a text/number field's new value.
  bot.callbackQuery(/^x:ap:set:([a-zA-Z]+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const key = ctx.match![1];
      const field = APPLY_PROFILE_FIELDS.find((f) => f.shortKey === key);
      if (!field) return;
      awaitingInput.set(chatId, `settings:ap:${field.shortKey}`);
      await ctx.editMessageText(
        `<b>🧾 ${escapeHtml(field.label)}</b>\n\n${field.prompt}\n\n<i>Send the value, or /clear to unset. /cancel to abort.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Back", "x:ap"),
        },
      );
    } catch (err) {
      logger.error("Apply profile set prompt error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Cycle a tri-state / boolean toggle field.
  bot.callbackQuery(/^x:ap:tog:([a-zA-Z]+)$/, async (ctx) => {
    try {
      const key = ctx.match![1];
      const field = APPLY_PROFILE_FIELDS.find((f) => f.shortKey === key);
      if (!field || field.kind === "text") {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const current = await settingsRepo.getSetting(field.settingKey);
      const next = cycleToggle(current, field.kind);
      if (next === null) {
        await settingsRepo.setSetting(field.settingKey, "");
      } else {
        await settingsRepo.setSetting(field.settingKey, next);
      }
      await ctx.answerCallbackQuery("Updated").catch(() => {});
      await renderApplyProfileMenu(ctx);
    } catch (err) {
      logger.error("Apply profile toggle error", {
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // ── Blocked Companies ─────────────────────────────────────────────

  // List blocked companies (paginated)
  bot.callbackQuery(/^x:blocked:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const page = parseInt(ctx.match![1], 10);
      const raw = await settingsRepo.getSetting("blockedCompanyKeywords");
      const keywords = parseBlockedKeywords(raw);

      const totalPages = Math.max(1, Math.ceil(keywords.length / BLOCKED_PAGE_SIZE));
      const safePage = Math.min(page, totalPages - 1);
      const pageItems = keywords.slice(
        safePage * BLOCKED_PAGE_SIZE,
        (safePage + 1) * BLOCKED_PAGE_SIZE,
      );

      let text = `<b>🚫 Blocked Companies (${keywords.length})</b>\n\n`;
      if (keywords.length === 0) {
        text += "<i>No blocked companies yet.</i>\n";
        text += "Companies matching these keywords will be filtered out during pipeline discovery.";
      } else {
        for (let i = 0; i < pageItems.length; i++) {
          const globalIdx = safePage * BLOCKED_PAGE_SIZE + i;
          text += `${globalIdx + 1}. ${escapeHtml(pageItems[i])}\n`;
        }
      }

      const keyboard = new InlineKeyboard();

      // Remove buttons — one per item on the page
      for (let i = 0; i < pageItems.length; i++) {
        const globalIdx = safePage * BLOCKED_PAGE_SIZE + i;
        const label = `❌ ${pageItems[i].slice(0, 20)}`;
        keyboard.text(label, `x:bl:rm:${globalIdx}`);
        if (i % 2 === 1) keyboard.row();
      }
      if (pageItems.length % 2 === 1) keyboard.row();

      // Pagination
      if (totalPages > 1) {
        if (safePage > 0) keyboard.text("◀️", `x:blocked:${safePage - 1}`);
        keyboard.text(`${safePage + 1}/${totalPages}`, "noop");
        if (safePage < totalPages - 1) keyboard.text("▶️", `x:blocked:${safePage + 1}`);
        keyboard.row();
      }

      keyboard.text("➕ Add", "x:bl:add");
      if (keywords.length > 0) keyboard.text("🗑 Clear All", "x:bl:clear");
      keyboard.row().text("◀️ Settings", "x:menu");

      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err) {
      logger.error("Blocked companies list error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error loading blocked companies").catch(() => {});
    }
  });

  // Add blocked company — prompt for text input
  bot.callbackQuery("x:bl:add", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      awaitingInput.set(chatId, "settings:blocked_company");

      const text =
        "<b>🚫 Add Blocked Companies</b>\n\n" +
        "Send company name(s), comma-separated:\n" +
        "<i>e.g. Acme Corp, Globex, Initech</i>\n\n" +
        "Jobs from companies matching these keywords will be filtered out.";

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("◀️ Back", "x:blocked:0"),
      });
    } catch (err) {
      logger.error("Add blocked prompt error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Remove single blocked keyword
  bot.callbackQuery(/^x:bl:rm:(\d+)$/, async (ctx) => {
    try {
      const idx = parseInt(ctx.match![1], 10);
      const raw = await settingsRepo.getSetting("blockedCompanyKeywords");
      const keywords = parseBlockedKeywords(raw);

      if (idx < 0 || idx >= keywords.length) {
        await ctx.answerCallbackQuery("Invalid index");
        return;
      }

      const removed = keywords.splice(idx, 1)[0];
      await settingsRepo.setSetting("blockedCompanyKeywords", JSON.stringify(keywords));
      await ctx.answerCallbackQuery(`Removed: ${removed}`);

      // Re-render the list at page 0
      const keyboard = new InlineKeyboard()
        .text("🚫 Blocked Companies", "x:blocked:0")
        .text("◀️ Settings", "x:menu");
      await ctx.editMessageText(
        `✅ Removed <b>${escapeHtml(removed)}</b> from blocked list.`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Remove blocked keyword error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Clear all blocked keywords — confirmation step
  bot.callbackQuery("x:bl:clear", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
      const raw = await settingsRepo.getSetting("blockedCompanyKeywords");
      const keywords = parseBlockedKeywords(raw);
      if (keywords.length === 0) {
        await ctx.answerCallbackQuery("Nothing to clear").catch(() => {});
        return;
      }

      const keyboard = new InlineKeyboard()
        .text(`🗑 Yes, clear ${keywords.length}`, "x:bl:clear:do")
        .text("◀️ Cancel", "x:blocked:0");
      await ctx.editMessageText(
        `🗑 <b>Clear all blocked companies?</b>\n\n<i>${keywords.length} keyword(s) will be removed. Cannot be undone.</i>`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (err) {
      logger.error("Clear blocked confirm error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // Clear all blocked keywords — confirmed
  bot.callbackQuery("x:bl:clear:do", async (ctx) => {
    try {
      await settingsRepo.setSetting("blockedCompanyKeywords", "[]");
      await ctx.answerCallbackQuery("All blocked companies cleared!");
      await ctx.editMessageText("✅ All blocked companies cleared.", {
        reply_markup: new InlineKeyboard().text("◀️ Settings", "x:menu").text("◀️ Menu", "m:menu"),
      });
    } catch (err) {
      logger.error("Clear blocked error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.answerCallbackQuery("❌ Error").catch(() => {});
    }
  });

  // ── Text input handler (blocked companies) ────────────────────────

  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    const action = awaitingInput.get(chatId);
    if (!action || !action.startsWith("settings:")) return next();
    awaitingInput.delete(chatId);

    const subAction = action.slice("settings:".length);

    try {
      // Apply Profile field input: "ap:<shortKey>".
      if (subAction.startsWith("ap:")) {
        const shortKey = subAction.slice("ap:".length);
        const field = APPLY_PROFILE_FIELDS.find((f) => f.shortKey === shortKey);
        const backKb = new InlineKeyboard().text("🧾 Apply Profile", "x:ap");
        if (!field) return;

        const value = ctx.message.text.trim();
        if (value === "/cancel") {
          await ctx.reply("Cancelled.", { reply_markup: backKb });
          return;
        }
        if (value === "/clear") {
          await settingsRepo.setSetting(field.settingKey, "");
          await ctx.reply(`✅ ${field.label} cleared.`, { reply_markup: backKb });
          return;
        }
        if (field.kind === "number") {
          const n = parseInt(value, 10);
          if (Number.isNaN(n) || n < 0 || n > 60) {
            await ctx.reply(
              "Please send a whole number between 0 and 60 (or /clear).",
              { reply_markup: backKb },
            );
            return;
          }
          await settingsRepo.setSetting(field.settingKey, String(n));
        } else {
          if (value.length > 300) {
            await ctx.reply("Too long (max 300 characters).", {
              reply_markup: backKb,
            });
            return;
          }
          await settingsRepo.setSetting(field.settingKey, value);
        }
        await ctx.reply(
          `✅ <b>${escapeHtml(field.label)}</b> saved: ${escapeHtml(displayApplyValue(field, value))}`,
          { parse_mode: "HTML", reply_markup: backKb },
        );
        return;
      }

      if (subAction === "blocked_company") {
        const newKeywords = ctx.message.text
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);

        if (newKeywords.length === 0) {
          await ctx.reply("No keywords provided.", {
            reply_markup: new InlineKeyboard().text("🚫 Blocked Companies", "x:blocked:0"),
          });
          return;
        }

        const raw = await settingsRepo.getSetting("blockedCompanyKeywords");
        const existing = parseBlockedKeywords(raw);
        const existingSet = new Set(existing.map((k) => k.toLowerCase()));
        const added: string[] = [];

        for (const kw of newKeywords) {
          if (!existingSet.has(kw)) {
            existing.push(kw);
            existingSet.add(kw);
            added.push(kw);
          }
        }

        await settingsRepo.setSetting("blockedCompanyKeywords", JSON.stringify(existing));

        const keyboard = new InlineKeyboard()
          .text("🚫 Blocked Companies", "x:blocked:0")
          .row()
          .text("◀️ Menu", "m:menu");

        if (added.length > 0) {
          await ctx.reply(
            `✅ Added: <b>${escapeHtml(added.join(", "))}</b>\nTotal blocked: ${existing.length}`,
            { parse_mode: "HTML", reply_markup: keyboard },
          );
        } else {
          await ctx.reply("All keywords already in the blocklist.", { reply_markup: keyboard });
        }
        return;
      }
    } catch (err) {
      logger.error("Text input handler error", { error: err instanceof Error ? err.message : String(err) });
      await ctx.reply("❌ Error saving setting.").catch(() => {});
    }

    return next();
  });

  // (m:menu callback is now registered canonically in bot.ts so every
  //  "◀️ Menu" button across the app renders the same up-to-date layout.)
}
