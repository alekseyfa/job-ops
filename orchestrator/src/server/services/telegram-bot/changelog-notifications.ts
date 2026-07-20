/**
 * Changelog notification service.
 *
 * On bot startup, checks if there are unseen changelog entries
 * and sends a pinned message to all authorized chats.
 */

import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import {
  getChatIdsForTenant,
  listTenantIdsWithLinkedChats,
} from "../../repositories/telegram-links";
import * as settingsRepo from "../../repositories/settings";
import { getBot } from "./bot";
import {
  formatChangelogMessage,
  getChangelogSince,
  getLatestChangelogVersion,
} from "./changelog";

const SETTING_KEY = "telegramChangelogLastSentVersion";

async function getLastSentVersion(): Promise<string | null> {
  return (await settingsRepo.getSetting(SETTING_KEY)) ?? null;
}

async function setLastSentVersion(version: string): Promise<void> {
  await settingsRepo.setSetting(SETTING_KEY, version);
}

/**
 * Send unseen changelog entries to every tenant's linked chats. The
 * last-sent-version cursor is per-tenant, so each workspace independently
 * catches up. Called on bot startup.
 */
export async function sendChangelogIfNeeded(): Promise<void> {
  const bot = getBot();
  if (!bot) return;

  const tenantIds = await listTenantIdsWithLinkedChats();
  for (const tenantId of tenantIds) {
    await runWithRequestContext({ tenantId }, () =>
      sendChangelogForTenant(tenantId),
    ).catch((err) =>
      logger.warn("Changelog send failed for tenant", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Per-tenant changelog catch-up. Runs inside the tenant's request context. */
async function sendChangelogForTenant(tenantId: string): Promise<void> {
  const bot = getBot();
  if (!bot) return;

  const lastSent = await getLastSentVersion();
  const entries = getChangelogSince(lastSent);
  if (entries.length === 0) return;

  const chatIds = new Set(await getChatIdsForTenant(tenantId));
  if (chatIds.size === 0) return;

  // entries are newest-first.  We send them in chronological order
  // (oldest → newest) so the user sees the timeline correctly, and so
  // the LAST message we send is the one to pin.
  const entriesChronological = [...entries].reverse();
  const latestVersion = getLatestChangelogVersion();

  let totalFailureCount = 0;
  let chatsThatGotLatest = 0;

  for (const chatId of chatIds) {
    let pinCandidate: number | null = null;
    let chatFailed = false;

    for (const entry of entriesChronological) {
      const message = formatChangelogMessage([entry]);
      if (!message) continue;
      try {
        const sent = await bot.api.sendMessage(chatId, message, {
          parse_mode: "HTML",
        });
        if (entry.version === latestVersion) {
          pinCandidate = sent.message_id;
        }
      } catch (err) {
        chatFailed = true;
        totalFailureCount += 1;
        logger.warn("Failed to send changelog notification", {
          chatId,
          version: entry.version,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't keep blasting more messages at this chat — move on.
        break;
      }
    }

    // Pin the latest-version message (only) for easy access.
    if (pinCandidate !== null) {
      try {
        await bot.api.pinChatMessage(chatId, pinCandidate, {
          disable_notification: true,
        });
      } catch (pinErr) {
        // Pinning may fail if bot lacks admin rights — that's OK
        logger.debug("Could not pin changelog message", {
          chatId,
          error: pinErr instanceof Error ? pinErr.message : String(pinErr),
        });
      }
      if (!chatFailed) chatsThatGotLatest += 1;
    }
  }

  // Only advance the cursor when every authorized chat got the LATEST
  // version (the older ones being best-effort context).  Otherwise failed
  // chats would silently miss the latest entry forever.
  if (totalFailureCount === 0 && chatsThatGotLatest > 0) {
    await setLastSentVersion(latestVersion);
    logger.info("Changelog notification sent", {
      version: latestVersion,
      chatCount: chatIds.size,
      entriesSent: entriesChronological.length,
    });
  } else if (totalFailureCount > 0) {
    logger.warn("Changelog cursor not advanced — will retry next startup", {
      version: latestVersion,
      chatsThatGotLatest,
      totalFailureCount,
    });
  }
}

/**
 * Send the full changelog to a specific chat (for /changelog command
 * or when a new user links).
 */
export async function sendFullChangelog(chatId: number): Promise<void> {
  const bot = getBot();
  if (!bot) return;

  const entries = getChangelogSince(null);
  if (entries.length === 0) {
    await bot.api.sendMessage(chatId, "No changelog entries yet.", {
      parse_mode: "HTML",
    });
    return;
  }

  const message = formatChangelogMessage(entries);
  await bot.api.sendMessage(chatId, message, { parse_mode: "HTML" });
}
