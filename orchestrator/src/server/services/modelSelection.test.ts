// src/server/services/modelSelection.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsRepo from "../repositories/settings";
import * as envSettings from "./envSettings";
import { pickProjectIdsForJob } from "./projectSelection";
import { scoreJobSuitability } from "./scorer";
import { getEffectiveSettings } from "./settings";
import { generateTailoring } from "./summary";

// Mock the settings repository
vi.mock("../repositories/settings", () => ({
  getAllSettings: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

describe("Model Selection Logic", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Set environment variables to ensure we don't hit early exits
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "test-key",
      MODEL: "env-model",
    };

    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      llmApiKey: "test-key",
    });
    vi.mocked(settingsRepo.getSetting).mockResolvedValue(null);
    vi.mocked(getEffectiveSettings).mockResolvedValue({
      model: { value: "env-model", default: "env-model", override: null },
      modelScorer: { value: "env-model", override: null },
      modelTailoring: { value: "env-model", override: null },
      modelProjectSelection: { value: "env-model", override: null },
      llmProvider: {
        value: "openrouter",
        default: "openrouter",
        override: null,
      },
      llmBaseUrl: {
        value: "https://openrouter.ai/api/v1",
        default: "https://openrouter.ai/api/v1",
        override: null,
      },
      scoringInstructions: { value: "", default: "", override: null },
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
    } as any);

    // Mock global fetch to capture the request and return a dummy success response
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 50,
                explanation: "ok",
                summary: "sum",
                headline: "head",
                skills: [],
                selectedProjectIds: ["1"],
              }),
            },
          },
        ],
      }),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("Scoring Service", () => {
    it("should use scoring specific model when set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: null,
        },
        modelScorer: {
          value: "specific-scorer-model",
          override: "specific-scorer-model",
        },
        modelTailoring: { value: "global-model", override: null },
        modelProjectSelection: { value: "global-model", override: null },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
        scoringInstructions: { value: "", default: "", override: null },
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
      } as any);

      await scoreJobSuitability(
        { title: "Test Job", jobDescription: "desc" } as any,
        {},
      );

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("specific-scorer-model");
    });

    it("should fall back to global model for scoring when specific not set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: "global-model",
        },
        modelScorer: { value: "global-model", override: null },
        modelTailoring: { value: "global-model", override: null },
        modelProjectSelection: { value: "global-model", override: null },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
        scoringInstructions: { value: "", default: "", override: null },
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
      } as any);

      await scoreJobSuitability({ title: "Test Job" } as any, {});

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("global-model");
    });

    it("should fall back to env model for scoring when no settings set", async () => {
      await scoreJobSuitability({ title: "Test Job" } as any, {});

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("env-model");
    });
  });

  describe("Tailoring Service", () => {
    it("should use tailoring specific model when set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: null,
        },
        modelScorer: { value: "global-model", override: null },
        modelTailoring: {
          value: "specific-tailoring-model",
          override: "specific-tailoring-model",
        },
        modelProjectSelection: { value: "global-model", override: null },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
      } as any);

      await generateTailoring("job desc", {});

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("specific-tailoring-model");
    });

    it("should fall back to global model when specific not set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: "global-model",
        },
        modelScorer: { value: "global-model", override: null },
        modelTailoring: { value: "global-model", override: null },
        modelProjectSelection: { value: "global-model", override: null },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
      } as any);

      await generateTailoring("job desc", {});

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("global-model");
    });
  });

  describe("Bedrock end-to-end (CLAUDE_CODE_USE_BEDROCK)", () => {
    beforeEach(() => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      process.env.AWS_REGION = "eu-west-1";
      process.env.ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
      // The Bedrock token is read via a module-load env snapshot, so spy the
      // accessor rather than mutating process.env (which the snapshot ignores).
      vi.spyOn(envSettings, "getOriginalEnvValue").mockImplementation((key) =>
        key === "AWS_BEARER_TOKEN_BEDROCK" ? "bedrock-bearer-token" : undefined,
      );

      // Bedrock returns Anthropic-shaped content, not chat-completions choices.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                score: 77,
                explanation: "strong match",
                summary: "s",
                headline: "h",
                skills: [],
              }),
            },
          ],
        }),
      });
    });

    it("resolveLlmRuntimeSettings returns the Bedrock endpoint + bearer token, not DB settings", async () => {
      // Regression: CV import / ghostwriter build their own request from these
      // fields. Before the fix this ignored Bedrock and returned stale DB
      // anthropic settings, POSTing the bearer token to api.anthropic.com → 403.
      const { resolveLlmRuntimeSettings } = await import("./modelSelection");
      const runtime = await resolveLlmRuntimeSettings();

      expect(runtime).toEqual({
        provider: "bedrock",
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com",
        apiKey: "bedrock-bearer-token",
      });
    });

    it("routes scoring through the Bedrock endpoint and parses the result", async () => {
      const result = await scoreJobSuitability(
        { id: "job-1", title: "Test Job", jobDescription: "desc" } as any,
        {},
      );

      // End-to-end: the Anthropic-shaped response was parsed back into a score.
      expect(result.score).toBe(77);

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      // Region from AWS_REGION, model in the path, Bedrock invoke route.
      expect(url).toBe(
        "https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bedrock-bearer-token");
      const body = JSON.parse(init?.body as string);
      expect(body.anthropic_version).toBe("bedrock-2023-05-31");
      expect(body.model).toBeUndefined(); // model lives in the URL, not the body
    });
  });

  describe("Project Selection Service", () => {
    it("should use project selection specific model when set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: null,
        },
        modelScorer: { value: "global-model", override: null },
        modelTailoring: { value: "global-model", override: null },
        modelProjectSelection: {
          value: "specific-project-model",
          override: "specific-project-model",
        },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
      } as any);

      await pickProjectIdsForJob({
        jobDescription: "desc",
        eligibleProjects: [
          {
            id: "1",
            name: "p1",
            description: "d1",
            summaryText: "summary",
          } as any,
        ],
        desiredCount: 1,
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("specific-project-model");
    });

    it("should fall back to global model when specific not set", async () => {
      vi.mocked(getEffectiveSettings).mockResolvedValue({
        model: {
          value: "global-model",
          default: "global-model",
          override: "global-model",
        },
        modelScorer: { value: "global-model", override: null },
        modelTailoring: { value: "global-model", override: null },
        modelProjectSelection: { value: "global-model", override: null },
        llmProvider: {
          value: "openrouter",
          default: "openrouter",
          override: null,
        },
        llmBaseUrl: {
          value: "https://openrouter.ai/api/v1",
          default: "https://openrouter.ai/api/v1",
          override: null,
        },
      } as any);

      await pickProjectIdsForJob({
        jobDescription: "desc",
        eligibleProjects: [
          {
            id: "1",
            name: "p1",
            description: "d1",
            summaryText: "summary",
          } as any,
        ],
        desiredCount: 1,
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.model).toBe("global-model");
    });
  });
});
