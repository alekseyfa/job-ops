import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings are tenant-scoped and fail-closed on request context now, so every
// repo call must run inside a tenant context. request-context is imported
// DYNAMICALLY (after vi.resetModules) so we share the SAME AsyncLocalStorage
// instance the re-imported settings repo uses — a static import would bind a
// stale ALS. Wrap at the call site: an ALS entered in beforeEach does not
// persist into the it() body.
async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithRequestContext } = await import("@infra/request-context");
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

const originalEnv = { ...process.env };

describe.sequential("envSettings overrides", () => {
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-env-migration-test-"));
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      MODEL: "test-model",
      LLM_API_KEY: "sk-env-default",
    };

    await import("../db/migrate");
    const dbMod = await import("../db/index");
    closeDb = dbMod.closeDb;
  });

  afterEach(async () => {
    if (closeDb) closeDb();
    await rm(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("keeps stored llmApiKey overrides out of process env", async () => {
    const settingsRepo = await import("../repositories/settings");
    const { applyStoredEnvOverrides } = await import("./envSettings");

    await asTenant(() => settingsRepo.setSetting("llmApiKey", "sk-db-override"));

    await applyStoredEnvOverrides();

    expect(await asTenant(() => settingsRepo.getSetting("llmApiKey"))).toBe(
      "sk-db-override",
    );
    expect(process.env.LLM_API_KEY).toBe("sk-env-default");
  });

  it("leaves process env unchanged when override is explicitly cleared", async () => {
    const settingsRepo = await import("../repositories/settings");
    const { applyStoredEnvOverrides } = await import("./envSettings");

    await asTenant(() => settingsRepo.setSetting("llmApiKey", ""));

    await applyStoredEnvOverrides();

    expect(process.env.LLM_API_KEY).toBe("sk-env-default");
  });
});
