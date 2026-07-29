import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  getRequestId,
  getTenantId,
  getUserId,
  isSystemAdmin,
  requireTenantId,
  runWithRequestContext,
} from "./request-context";

/**
 * request-context is the AsyncLocalStorage that underpins fail-closed tenancy.
 * Two behaviors are load-bearing and must never silently regress:
 *   • requireTenantId() THROWS with no context (fail-closed) — a silent
 *     default-tenant fallback would turn every missing-context bug into a
 *     cross-tenant read/write.
 *   • runWithRequestContext() merges a NESTED context over the parent,
 *     overriding only the provided keys and preserving the rest. A merge-order
 *     regression would leak one request's tenantId/userId into a nested scope.
 */
describe("request-context", () => {
  describe("outside any context (fail-closed)", () => {
    it("getTenantId / getUserId / getRequestId are undefined and requireTenantId throws", () => {
      expect(getRequestContext()).toBeUndefined();
      expect(getTenantId()).toBeUndefined();
      expect(getUserId()).toBeUndefined();
      expect(getRequestId()).toBeUndefined();
      expect(isSystemAdmin()).toBe(false);
      expect(() => requireTenantId()).toThrow(/tenant context is required/i);
    });
  });

  describe("inside a context", () => {
    it("exposes the provided fields and requireTenantId returns the tenant", () => {
      runWithRequestContext(
        { tenantId: "t1", userId: "u1", requestId: "r1", isSystemAdmin: true },
        () => {
          expect(getTenantId()).toBe("t1");
          expect(getUserId()).toBe("u1");
          expect(getRequestId()).toBe("r1");
          expect(isSystemAdmin()).toBe(true);
          expect(requireTenantId()).toBe("t1");
        },
      );
    });

    it("defaults requestId to 'unknown' when neither provided nor inherited", () => {
      runWithRequestContext({ tenantId: "t1" }, () => {
        expect(getRequestId()).toBe("unknown");
      });
    });
  });

  describe("nested merge semantics", () => {
    it("overrides only the provided keys and preserves the rest of the parent", () => {
      runWithRequestContext(
        { tenantId: "parent", userId: "parent-user", requestId: "req-1" },
        () => {
          // Nested scope changes only jobId; tenant/user/request must persist.
          runWithRequestContext({ jobId: "job-9" }, () => {
            expect(getTenantId()).toBe("parent");
            expect(getUserId()).toBe("parent-user");
            expect(getRequestId()).toBe("req-1");
            expect(getRequestContext()?.jobId).toBe("job-9");
          });

          // Back in the parent scope, the nested jobId is gone.
          expect(getRequestContext()?.jobId).toBeUndefined();
          expect(getTenantId()).toBe("parent");
        },
      );
    });

    it("a nested override of tenantId does NOT leak back to the parent scope", () => {
      runWithRequestContext({ tenantId: "tenant_a", requestId: "r" }, () => {
        runWithRequestContext({ tenantId: "tenant_b" }, () => {
          expect(getTenantId()).toBe("tenant_b");
        });
        // Parent tenant is intact after the nested scope exits.
        expect(getTenantId()).toBe("tenant_a");
      });
    });
  });

  describe("isolation between sibling scopes", () => {
    it("does not bleed context from one run into the next", () => {
      runWithRequestContext({ tenantId: "first" }, () => {
        expect(getTenantId()).toBe("first");
      });
      // A completely separate run must not see 'first'.
      runWithRequestContext({ tenantId: "second" }, () => {
        expect(getTenantId()).toBe("second");
      });
      // And outside any run, still fail-closed.
      expect(getTenantId()).toBeUndefined();
    });

    it("returns the function's value through runWithRequestContext", () => {
      const out = runWithRequestContext({ tenantId: "t" }, () => 42);
      expect(out).toBe(42);
    });
  });
});
