import { toAppError, unauthorized } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { getTenantId, getUserId } from "@infra/request-context";
import { generateLinkCode } from "@server/services/telegram-bot/auth";
import { type Request, type Response, Router } from "express";

export const telegramRouter = Router();

/**
 * POST /api/telegram/link-code
 *
 * Mint a one-time Telegram link code bound to the authenticated user's tenant.
 * The user sends this code to the bot via `/link <code>`, which binds that chat
 * to THIS workspace. This is what makes each Telegram user land in their own
 * tenant instead of the shared default.
 */
telegramRouter.post("/link-code", async (_req: Request, res: Response) => {
  try {
    const userId = getUserId();
    const tenantId = getTenantId();
    if (!userId || !tenantId) {
      return fail(res, unauthorized());
    }
    const code = generateLinkCode({ userId, tenantId });
    ok(res, { code, expiresInSeconds: 300 });
  } catch (error) {
    fail(res, toAppError(error));
  }
});
