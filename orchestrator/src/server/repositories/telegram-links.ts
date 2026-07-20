/**
 * Telegram link repository — maps a Telegram chat to a user + tenant.
 *
 * These queries are keyed by the globally-unique Telegram chatId, NOT by the
 * active tenant: their purpose is to DISCOVER which tenant a chat belongs to
 * before any request context exists. Do not add getActiveTenantId() here.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index";

const { telegramLinks } = schema;

export type TelegramChatContext = {
  chatId: number;
  userId: string;
  tenantId: string;
};

/** Resolve a chat to its {userId, tenantId}, or null if the chat isn't linked. */
export async function resolveChatContext(
  chatId: number,
): Promise<TelegramChatContext | null> {
  const [row] = await db
    .select({
      chatId: telegramLinks.chatId,
      userId: telegramLinks.userId,
      tenantId: telegramLinks.tenantId,
    })
    .from(telegramLinks)
    .where(eq(telegramLinks.chatId, chatId))
    .limit(1);
  return row ?? null;
}

export async function isChatLinked(chatId: number): Promise<boolean> {
  return (await resolveChatContext(chatId)) !== null;
}

/** Bind a chat to a user+tenant (idempotent upsert). */
export async function linkChat(input: {
  chatId: number;
  userId: string;
  tenantId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(telegramLinks)
    .values({
      chatId: input.chatId,
      userId: input.userId,
      tenantId: input.tenantId,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: telegramLinks.chatId,
      set: {
        userId: input.userId,
        tenantId: input.tenantId,
        lastSeenAt: now,
      },
    });
}

export async function unlinkChat(chatId: number): Promise<void> {
  await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
}

/** All chatIds bound to a tenant (for per-tenant broadcasts). */
export async function getChatIdsForTenant(tenantId: string): Promise<number[]> {
  const rows = await db
    .select({ chatId: telegramLinks.chatId })
    .from(telegramLinks)
    .where(eq(telegramLinks.tenantId, tenantId));
  return rows.map((r) => r.chatId);
}

/** Distinct tenantIds that have at least one linked chat (drives broadcasts). */
export async function listTenantIdsWithLinkedChats(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tenantId: telegramLinks.tenantId })
    .from(telegramLinks);
  return rows.map((r) => r.tenantId);
}

/** Touch lastSeenAt for a chat (best-effort activity tracking). */
export async function touchChat(chatId: number): Promise<void> {
  await db
    .update(telegramLinks)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(eq(telegramLinks.chatId, chatId));
}
