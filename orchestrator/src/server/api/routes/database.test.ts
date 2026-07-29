import type { Server } from "node:http";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

// The HTTP routes get tenant context from the auth middleware, but this test
// seeds fixtures by calling the tenant-scoped repo DIRECTLY (outside any
// request), which is fail-closed and throws "Tenant context is required".
// Wrap the direct seed call; the fetch() below establishes its own context.
// request-context is imported DYNAMICALLY because startServer() calls
// vi.resetModules() (test-utils.ts), so a static import would bind a stale
// AsyncLocalStorage instance rather than the one the re-imported repo uses.
async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithRequestContext } = await import("@infra/request-context");
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

describe.sequential("Database API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("clears jobs and pipeline runs", async () => {
    const { createJob } = await import("@server/repositories/jobs");
    await asTenant(() =>
      createJob({
        source: "manual",
        title: "Cleanup Role",
        employer: "Acme",
        jobUrl: "https://example.com/job/cleanup",
        jobDescription: "Test description",
      }),
    );

    const res = await fetch(`${baseUrl}/api/database`, { method: "DELETE" });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.jobsDeleted).toBe(1);
    expect(typeof body.meta.requestId).toBe("string");
  });
});
