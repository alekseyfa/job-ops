import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  DEFAULT_TENANT_ID,
  type TestDbContext,
} from "@server/test-support/tenant-context";

/**
 * Locks the keystone tenancy contract:
 *   1. A tenant-scoped repository call WITHOUT a request context THROWS
 *      (fail-closed) rather than silently reading the default tenant.
 *   2. Data written in tenant A is invisible to tenant B (isolation).
 *
 * If someone reverts getActiveTenantId() to a silent DEFAULT_TENANT_ID
 * fallback, test #1 goes green-to-red immediately.
 */
describe.sequential("fail-closed tenant context", () => {
  let ctx: TestDbContext;
  let jobsRepo: typeof import("@server/repositories/jobs");

  beforeEach(async () => {
    ctx = await createTestDb();
    jobsRepo = await import("@server/repositories/jobs");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("throws when a repository is called with no tenant context", async () => {
    await expect(jobsRepo.getAllJobs()).rejects.toThrow(/tenant/i);
  });

  it("does not leak jobs across tenants", async () => {
    const TENANT_A = "tenant_a";
    const TENANT_B = "tenant_b";
    await ctx.createTenant(TENANT_A);
    await ctx.createTenant(TENANT_B);

    await ctx.withTenant(TENANT_A, () =>
      jobsRepo.createJob({
        source: "manual",
        title: "A-only role",
        employer: "AcmeA",
        jobUrl: "https://example.com/a/1",
      }),
    );
    await ctx.withTenant(TENANT_B, () =>
      jobsRepo.createJob({
        source: "manual",
        title: "B-only role",
        employer: "AcmeB",
        jobUrl: "https://example.com/b/1",
      }),
    );

    const aJobs = await ctx.withTenant(TENANT_A, () => jobsRepo.getAllJobs());
    const bJobs = await ctx.withTenant(TENANT_B, () => jobsRepo.getAllJobs());

    expect(aJobs.map((j) => j.title)).toEqual(["A-only role"]);
    expect(bJobs.map((j) => j.title)).toEqual(["B-only role"]);

    // The default tenant sees neither.
    const defaultJobs = await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      jobsRepo.getAllJobs(),
    );
    expect(defaultJobs).toHaveLength(0);
  });
});
