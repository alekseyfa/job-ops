/**
 * Grammy update-simulation harness for handler tests.
 *
 * Drives a real `grammy` Bot in-process via `bot.handleUpdate(update)` WITHOUT
 * any networking:
 *   • `bot.botInfo` is set manually so grammy skips the `getMe` network init
 *     that `handleUpdate` would otherwise require.
 *   • An API transformer is installed on `bot.api` (via `bot.api.config.use`)
 *     that short-circuits EVERY outgoing Bot API call (sendMessage,
 *     editMessageText, answerCallbackQuery, …), recording it into `outbox` and
 *     returning a synthetic `ApiResponse` so no HTTP request is ever made.
 *     grammy copies the installed transformers onto the per-update `ctx.api`
 *     inside `handleUpdate`, so `ctx.reply()` / `ctx.editMessageText()` etc. are
 *     all captured too.
 *
 * The caller builds the Bot (so it can install its own auth/tenant middleware
 * and register handlers) and hands it to `createTelegramHarness`. IMPORTANT for
 * tenant-scoped tests: build the Bot AFTER `createTestDb()` has run its
 * `vi.resetModules()`, so the bot + handlers bind to the same post-reset module
 * graph (DB singleton + request-context AsyncLocalStorage) the test seeds
 * through — otherwise the middleware's request context won't reach the repos.
 */

import type { Bot, Transformer } from "grammy";

/** The Update shape grammy's handleUpdate expects, derived from the Bot type. */
type Update = Parameters<Bot["handleUpdate"]>[0];

export interface OutboxEntry {
  /** Bot API method name, e.g. "sendMessage" / "editMessageText". */
  method: string;
  /** The raw payload grammy would have sent to Telegram. */
  // biome-ignore lint/suspicious/noExplicitAny: raw Bot API payload shape varies per method.
  payload: Record<string, any>;
}

export interface TelegramHarness {
  bot: Bot;
  /** Every outgoing API call, in order, since the last clear(). */
  outbox: OutboxEntry[];
  /** All `text` fields sent via send/editMessage calls (drops undefined). */
  texts(): string[];
  /** The text of the most recent send/editMessage call, if any. */
  lastText(): string | undefined;
  /** All outbox entries for a given API method. */
  find(method: string): OutboxEntry[];
  /** Reset the outbox between simulated interactions. */
  clear(): void;
  /** Simulate a user tapping an inline button with callback `data`. */
  sendCallback(chatId: number, data: string): Promise<void>;
  /** Simulate a user sending a plain text message. */
  sendText(chatId: number, text: string): Promise<void>;
}

const MESSAGE_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "editMessageCaption",
  "sendDocument",
  "sendPhoto",
]);

/**
 * Wrap a caller-built Bot so it can be driven offline. Sets `botInfo`, installs
 * the capture transformer, and returns update-injection helpers.
 */
export async function createTelegramHarness(
  buildBot: () => Bot | Promise<Bot>,
): Promise<TelegramHarness> {
  const bot = await buildBot();

  // Skip the network getMe() init: handleUpdate only requires botInfo to exist.
  bot.botInfo = {
    id: 424242,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    can_manage_bots: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };

  const outbox: OutboxEntry[] = [];
  let messageIdSeq = 1000;

  // Intercept every outgoing API call. Returning a well-formed ApiResponse
  // stops grammy from attempting a real HTTP request.
  const capture: Transformer = async (_prev, method, payload) => {
    outbox.push({ method, payload: (payload ?? {}) as Record<string, unknown> });

    let result: unknown = true;
    if (MESSAGE_METHODS.has(method)) {
      const p = payload as { chat_id?: number | string; text?: string };
      result = {
        message_id: messageIdSeq++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(p?.chat_id ?? 0), type: "private" },
        text: p?.text,
      };
    }
    // biome-ignore lint/suspicious/noExplicitAny: synthetic ApiResponse for offline transport.
    return { ok: true, result } as any;
  };
  bot.api.config.use(capture);

  let updateIdSeq = 1;

  async function sendCallback(chatId: number, data: string): Promise<void> {
    const update = {
      update_id: updateIdSeq++,
      callback_query: {
        id: `cbq-${updateIdSeq}`,
        from: { id: chatId, is_bot: false, first_name: "Test User" },
        chat_instance: `ci-${chatId}`,
        message: {
          message_id: messageIdSeq++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private", first_name: "Test User" },
          from: bot.botInfo,
          text: "(previous screen)",
        },
        data,
      },
    } as unknown as Update;
    await bot.handleUpdate(update);
  }

  async function sendText(chatId: number, text: string): Promise<void> {
    const update = {
      update_id: updateIdSeq++,
      message: {
        message_id: messageIdSeq++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private", first_name: "Test User" },
        from: { id: chatId, is_bot: false, first_name: "Test User" },
        text,
      },
    } as unknown as Update;
    await bot.handleUpdate(update);
  }

  return {
    bot,
    outbox,
    texts: () =>
      outbox
        .map((e) => e.payload?.text)
        .filter((t): t is string => typeof t === "string"),
    lastText: () => {
      for (let i = outbox.length - 1; i >= 0; i--) {
        const t = outbox[i].payload?.text;
        if (typeof t === "string") return t;
      }
      return undefined;
    },
    find: (method: string) => outbox.filter((e) => e.method === method),
    clear: () => {
      outbox.length = 0;
    },
    sendCallback,
    sendText,
  };
}
