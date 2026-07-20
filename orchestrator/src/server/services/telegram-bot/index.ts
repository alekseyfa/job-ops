import { logger } from "@infra/logger";
import * as settingsRepo from "../../repositories/settings";
import { generateLinkCode } from "./auth";
import { createBot, getBot } from "./bot";
import { registerBoardHandlers } from "./handlers/boards";
import { registerGmailHandlers } from "./handlers/gmail";
import { registerInsightsHandlers } from "./handlers/insights";
import { registerInterviewPrepHandlers } from "./handlers/interview-prep";
import { registerJobHandlers } from "./handlers/jobs";
import { registerMaintenanceHandlers } from "./handlers/maintenance";
import { registerPipelineHandlers } from "./handlers/pipeline";
import { registerSettingsHandlers } from "./handlers/settings";
import { registerSmartApplyHandlers } from "./handlers/smart-apply";
import { registerStatsHandlers } from "./handlers/stats";
import { sendChangelogIfNeeded } from "./changelog-notifications";
import {
  startGmailNotificationSubscriptions,
  stopGmailNotificationSubscriptions,
} from "./gmail-notifications";
import {
  startNotificationSubscriptions,
  stopNotificationSubscriptions,
} from "./notifications";

export { generateLinkCode } from "./auth";

let started = false;

export async function initializeTelegramBot(): Promise<void> {
  const token =
    (await settingsRepo.getSetting("telegramBotToken"))?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    logger.info("Telegram bot disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }

  try {
    const bot = createBot(token);

    // Register all handlers
    registerPipelineHandlers(bot);
    registerJobHandlers(bot);
    registerStatsHandlers(bot);
    registerSettingsHandlers(bot);
    registerBoardHandlers(bot);
    registerInsightsHandlers(bot);
    registerInterviewPrepHandlers(bot);
    registerGmailHandlers(bot);
    registerMaintenanceHandlers(bot);
    registerSmartApplyHandlers(bot);

    // Populate Telegram's native "/" command autocomplete / Menu button.
    // Best-effort: a failure here must not block the bot from starting.
    bot.api
      .setMyCommands([
        { command: "menu", description: "Main menu" },
        { command: "search", description: "Find jobs by keyword" },
        { command: "insights", description: "Application funnel & trends" },
        { command: "interview", description: "Interview prep" },
        { command: "sync", description: "Sync application emails now" },
        { command: "gmail", description: "Email sync status" },
        { command: "changelog", description: "What's new" },
        { command: "help", description: "How to use this bot" },
      ])
      .catch((err) =>
        logger.warn("Failed to set Telegram command menu", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // Start long-polling
    bot.start({
      onStart: () => {
        logger.info("Telegram bot started (long-polling)");
        started = true;

        // Send changelog for any unseen updates (async, non-blocking)
        sendChangelogIfNeeded().catch((err) =>
          logger.warn("Changelog notification failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      },
      drop_pending_updates: true,
    });

    // Start proactive notifications (per-tenant pipeline subscriptions)
    await startNotificationSubscriptions();
    startGmailNotificationSubscriptions();
  } catch (error) {
    logger.error("Failed to start Telegram bot", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function stopTelegramBot(): Promise<void> {
  const bot = getBot();
  if (bot && started) {
    stopNotificationSubscriptions();
    stopGmailNotificationSubscriptions();
    await bot.stop();
    started = false;
    logger.info("Telegram bot stopped");
  }
}

export function isTelegramBotRunning(): boolean {
  return started;
}
