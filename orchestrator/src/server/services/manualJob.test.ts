import { runWithRequestContext } from "@infra/request-context";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsRepo from "../repositories/settings";
import { inferManualJobDetails } from "./manualJob";

// inferManualJobDetails runs inside the pipeline's tenant context in production
// (resolveLlmModel/createConfiguredLlmService -> getEffectiveSettings ->
// design-resume repo is fail-closed on tenancy). Unit tests must supply that
// ambient context or the repo throws "Tenant context is required". Static import
// binds the same singleton AsyncLocalStorage the statically-imported service
// uses (no vi.resetModules here), so this wrapper is sufficient.
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

vi.mock("../repositories/settings", () => ({
  getSetting: vi.fn(),
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

const originalEnv = process.env;
const originalFetch = global.fetch;

describe("manual job inference", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, OPENROUTER_API_KEY: "test-key" };
    global.fetch = vi.fn();
    vi.mocked(settingsRepo.getSetting).mockResolvedValue(null);
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      llmProvider: "openrouter",
      llmApiKey: "test-key",
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a warning when the API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({});

    const result = await asTenant(() => inferManualJobDetails("JD text"));

    expect(result.job).toEqual({});
    expect(result.warning).toContain("LLM API key not set");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("parses JSON even when wrapped in markdown fences", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                'Here is the data: ```json\n{ "title": "Backend Engineer", "employer": "Acme", "salary": " 100k " }\n```',
            },
          },
        ],
      }),
    } as any);

    const result = await asTenant(() => inferManualJobDetails("JD text"));

    expect(result.warning).toBeUndefined();
    expect(result.job).toMatchObject({
      title: "Backend Engineer",
      employer: "Acme",
      salary: "100k",
    });
  });

  it("returns a warning when the API response fails", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await asTenant(() => inferManualJobDetails("JD text"));

    expect(result.job).toEqual({});
    expect(result.warning).toContain("AI inference failed");
    warnSpy.mockRestore();
  });
});
