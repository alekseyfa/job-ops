import { timingSafeEqual } from "node:crypto";
import { toAppError, unauthorized } from "@infra/errors";
import { fail, ok, okWithMeta } from "@infra/http";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { isDemoMode } from "@server/config/demo";
import { runPipeline } from "@server/pipeline/index";
import { simulatePipelineRun } from "@server/services/demo-simulator";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { type Request, type Response, Router } from "express";

export const webhookRouter = Router();

/** Constant-time bearer-token check to avoid leaking the secret via timing. */
function bearerMatches(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  const expected = `Bearer ${expectedToken}`;
  const provided = authHeader ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * POST /api/webhook/trigger - Webhook endpoint for n8n to trigger the pipeline
 */
webhookRouter.post("/trigger", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.WEBHOOK_SECRET;

  if (expectedToken && !bearerMatches(authHeader, expectedToken)) {
    return fail(res, unauthorized());
  }

  try {
    if (isDemoMode()) {
      const simulated = await simulatePipelineRun();
      return okWithMeta(
        res,
        {
          message: "Pipeline trigger simulated in demo mode",
          triggeredAt: new Date().toISOString(),
          runId: simulated.runId,
        },
        { simulated: true },
      );
    }

    // Start pipeline in background. The webhook is a public, unauthenticated
    // trigger with no tenant identity, so it is scoped to the default tenant
    // (preserves single-tenant behavior; a per-tenant webhook would need its
    // own tenant-scoped secret).
    runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, () => {
      runPipeline().catch((error) => {
        logger.error("Webhook-triggered pipeline run failed", error);
      });
    });

    ok(res, {
      message: "Pipeline triggered",
      triggeredAt: new Date().toISOString(),
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});
