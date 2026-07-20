import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Repositories are fail-closed on tenant context. request-context is imported
// dynamically (after vi.resetModules) to share the same AsyncLocalStorage the
// re-imported repos use.
async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithRequestContext } = await import("@infra/request-context");
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

describe.sequential("tracer-links repository", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-tracer-repo-test-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
    };

    await import("../db/migrate");
    const dbModule = await import("../db");
    closeDb = dbModule.closeDb;

    await dbModule.db.insert(dbModule.schema.jobs).values({
      id: "job-tracer-1",
      source: "manual",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/1",
    });
  });

  afterEach(async () => {
    closeDb?.();
    closeDb = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    process.env = { ...originalEnv };
  });

  it("reuses token for same job + source path + destination hash", async () => {
    const repo = await import("./tracer-links");

    const first = await asTenant(() => repo.getOrCreateTracerLink({
      jobId: "job-tracer-1",
      sourcePath: "basics.url.href",
      sourceLabel: "Portfolio",
      destinationUrl: "https://example.com/portfolio",
      destinationUrlHash: "hash-a",
      slugPrefix: "sarfaraz-amazon",
    }));

    const second = await asTenant(() => repo.getOrCreateTracerLink({
      jobId: "job-tracer-1",
      sourcePath: "basics.url.href",
      sourceLabel: "Portfolio",
      destinationUrl: "https://example.com/portfolio",
      destinationUrlHash: "hash-a",
      slugPrefix: "sarfaraz-amazon",
    }));

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
    expect(first.token).toMatch(/^sarfaraz-amazon-[a-z2-9]{8}$/);
  });

  it("creates a new token when destination changes for same source path", async () => {
    const repo = await import("./tracer-links");

    const first = await asTenant(() => repo.getOrCreateTracerLink({
      jobId: "job-tracer-1",
      sourcePath: "basics.url.href",
      sourceLabel: "Portfolio",
      destinationUrl: "https://example.com/portfolio-v1",
      destinationUrlHash: "hash-v1",
      slugPrefix: "sarfaraz-amazon",
    }));

    const second = await asTenant(() => repo.getOrCreateTracerLink({
      jobId: "job-tracer-1",
      sourcePath: "basics.url.href",
      sourceLabel: "Portfolio",
      destinationUrl: "https://example.com/portfolio-v2",
      destinationUrlHash: "hash-v2",
      slugPrefix: "sarfaraz-amazon",
    }));

    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
  });
});
