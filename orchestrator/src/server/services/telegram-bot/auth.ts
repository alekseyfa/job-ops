import { randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "@infra/logger";
import {
  getChatIdsForTenant,
  isChatLinked,
  linkChat,
} from "../../repositories/telegram-links";

const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_BYTES = 6; // 12 hex chars = 48 bits of entropy
const MAX_ACTIVE_CODES = 16;

/** A pending link code carries the minting web user's identity + tenant. */
interface LinkCodeRecord {
  userId: string;
  tenantId: string;
  expiresAt: number;
}

const activeLinkCodes = new Map<string, LinkCodeRecord>();

function purgeExpired(now: number): void {
  for (const [code, record] of activeLinkCodes) {
    if (record.expiresAt <= now) activeLinkCodes.delete(code);
  }
}

/**
 * Mint a link code bound to a specific user + tenant. Called from a web session
 * (POST /api/telegram/link-code) so the resulting chat lands in the correct
 * workspace. Redeeming the code creates the chat→{userId,tenantId} mapping.
 */
export function generateLinkCode(binding: {
  userId: string;
  tenantId: string;
}): string {
  const now = Date.now();
  purgeExpired(now);
  if (activeLinkCodes.size >= MAX_ACTIVE_CODES) {
    // Drop the oldest to bound memory; iteration order is insertion order.
    const oldest = activeLinkCodes.keys().next().value;
    if (oldest !== undefined) activeLinkCodes.delete(oldest);
  }
  const code = randomBytes(CODE_BYTES).toString("hex");
  activeLinkCodes.set(code, {
    userId: binding.userId,
    tenantId: binding.tenantId,
    expiresAt: now + CODE_TTL_MS,
  });
  logger.info("Telegram link code generated", {
    codeLength: code.length,
    tenantId: binding.tenantId,
  });
  return code;
}

/**
 * Validate a link code in constant time. Returns the bound {userId, tenantId}
 * on success (consuming the code), or null if invalid/expired.
 */
export function consumeLinkCode(
  input: string,
): { userId: string; tenantId: string } | null {
  const candidate = input.trim();
  if (!candidate) return null;
  const now = Date.now();
  purgeExpired(now);

  const candidateBuf = Buffer.from(candidate);
  for (const [code, record] of activeLinkCodes) {
    const codeBuf = Buffer.from(code);
    if (codeBuf.length !== candidateBuf.length) continue;
    if (!timingSafeEqual(codeBuf, candidateBuf)) continue;
    activeLinkCodes.delete(code);
    if (record.expiresAt <= now) return null;
    return { userId: record.userId, tenantId: record.tenantId };
  }
  return null;
}

// Per-chat brute-force protection for /link attempts.
const LINK_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_LINK_ATTEMPTS = 5;

interface AttemptRecord {
  count: number;
  resetAt: number;
}

const linkAttempts = new Map<number, AttemptRecord>();

export function registerLinkAttempt(chatId: number): {
  allowed: boolean;
  retryInSeconds?: number;
} {
  const now = Date.now();
  const record = linkAttempts.get(chatId);
  if (!record || record.resetAt <= now) {
    linkAttempts.set(chatId, {
      count: 1,
      resetAt: now + LINK_ATTEMPT_WINDOW_MS,
    });
    return { allowed: true };
  }
  if (record.count >= MAX_LINK_ATTEMPTS) {
    return {
      allowed: false,
      retryInSeconds: Math.ceil((record.resetAt - now) / 1000),
    };
  }
  record.count += 1;
  return { allowed: true };
}

export function clearLinkAttempts(chatId: number): void {
  linkAttempts.delete(chatId);
}

/**
 * Redeem a link code for a chat: validates the code and binds the chat to the
 * code's {userId, tenantId}. Returns the bound context on success, null on
 * invalid/expired code.
 */
export async function redeemLinkCode(
  chatId: number,
  code: string,
): Promise<{ userId: string; tenantId: string } | null> {
  const binding = consumeLinkCode(code);
  if (!binding) return null;
  await linkChat({ chatId, userId: binding.userId, tenantId: binding.tenantId });
  logger.info("Telegram chat linked", {
    chatId,
    tenantId: binding.tenantId,
  });
  return binding;
}

export async function isAuthorized(chatId: number): Promise<boolean> {
  return isChatLinked(chatId);
}

/** Chat IDs bound to a given tenant — used by per-tenant broadcasters. */
export async function getChatIdsForTenantId(
  tenantId: string,
): Promise<number[]> {
  return getChatIdsForTenant(tenantId);
}

export async function areNotificationsEnabled(): Promise<boolean> {
  // Must be called inside a tenant context; reads that tenant's own setting.
  const settingsRepo = await import("../../repositories/settings");
  const raw = await settingsRepo.getSetting("telegramNotificationsEnabled");
  return raw !== "0" && raw !== "false";
}
