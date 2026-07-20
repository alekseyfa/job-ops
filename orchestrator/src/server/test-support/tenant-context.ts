/**
 * Test-only tenant-context helpers.
 *
 * Repositories are tenant-scoped and (after the fail-closed change) THROW when
 * no request context is set. These helpers give repo/service tests a real,
 * freshly-migrated temp DB plus a tenant request context, replacing the
 * copy-pasted mkdtemp + migrate + closeDb boilerplate and making cross-tenant
 * isolation tests possible.
 *
 * Usage:
 *   const ctx = await createTestDb();          // fresh migrated DB + default tenant
 *   await ctx.withTenant("tenant_a", async () => {
 *     await jobsRepo.createJob({ ... });        // runs scoped to tenant_a
 *   });
 *   await ctx.cleanup();
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { vi } from "vitest";

// NOTE: request-context is imported DYNAMICALLY inside createTestDb, AFTER
// vi.resetModules(). request-context holds a module-singleton AsyncLocalStorage;
// a static import here would bind a DIFFERENT instance than the repos re-import
// post-reset, so runWithRequestContext would write to one ALS and repos would
// read undefined from the other. Importing it post-reset keeps them on the same
// module graph.

export interface TestDbContext {
  tempDir: string;
  db: Awaited<typeof import("@server/db/index")>["db"];
  schema: Awaited<typeof import("@server/db/index")>["schema"];
  /** Run `fn` inside a request context scoped to `tenantId`. */
  withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  /** Insert a tenant row (so FK-constrained inserts succeed). */
  createTenant(tenantId: string, name?: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Spin up a fresh migrated SQLite DB in a temp dir. Resets modules so the DB
 * singleton picks up the new DATA_DIR. Call within beforeEach.
 */
export async function createTestDb(): Promise<TestDbContext> {
  vi.resetModules();
  const tempDir = await mkdtemp(join(tmpdir(), "job-ops-tenant-ctx-"));
  process.env.DATA_DIR = tempDir;
  process.env.NODE_ENV = "test";

  await import("@server/db/migrate");
  const { db, schema } = await import("@server/db/index");
  // Same post-reset module instance the repositories use — see note above.
  const { runWithRequestContext } = await import("@infra/request-context");

  async function withTenant<T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return runWithRequestContext(
      { tenantId, requestId: `test:${tenantId}` },
      fn,
    );
  }

  async function createTenant(tenantId: string, name = tenantId): Promise<void> {
    await db
      .insert(schema.tenants)
      .values({
        id: tenantId,
        name,
        slug: `${name}-${tenantId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      })
      .onConflictDoNothing();
  }

  async function cleanup(): Promise<void> {
    const { closeDb } = await import("@server/db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  }

  return {
    tempDir,
    db,
    schema,
    withTenant,
    createTenant,
    cleanup,
  };
}

export { DEFAULT_TENANT_ID };
