import { getTenantId, requireTenantId } from "@infra/request-context";
import { DEFAULT_TENANT_ID } from "./constants";

/**
 * The tenant for the current request/operation.
 *
 * FAIL-CLOSED: throws when no tenant context is established, rather than
 * silently falling back to the default tenant. A silent fallback turned every
 * missing-context bug (schedulers, bot handlers, background timers) into a
 * cross-tenant read/write against the admin's data. Throwing surfaces those
 * bugs immediately instead of leaking.
 *
 * Every request path (HTTP auth guard, Telegram middleware) and every
 * background root (schedulers, smart-apply timers, webhook) MUST wrap work in
 * runWithRequestContext({ tenantId }). Genuinely tenant-agnostic startup code
 * that must run without a request should use DEFAULT_TENANT_ID explicitly.
 */
export function getActiveTenantId(): string {
  return requireTenantId();
}

/** Non-throwing variant for code that legitimately tolerates a missing tenant. */
export function getActiveTenantIdOrNull(): string | null {
  return getTenantId() ?? null;
}
