import { runWithRequestContext } from "@infra/request-context";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsRepo from "../repositories/settings";
import { pickProjectIdsForJob } from "./projectSelection";
import { scoreJobSuitability } from "./scorer";

// These services run inside the pipeline's tenant context in production
// (getEffectiveSettings -> design-resume repo is fail-closed on tenancy).
// Unit tests must supply that ambient context or the repo throws
// "Tenant context is required". Static import binds the same singleton
// AsyncLocalStorage the statically-imported services use (no vi.resetModules
// here), so this wrapper is sufficient.
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

const pick = (args: Parameters<typeof pickProjectIdsForJob>[0]) =>
  asTenant(() => pickProjectIdsForJob(args));

// --- Mocks ---
vi.mock("../repositories/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

// We need to mock 'fetch' globally for these tests
const globalFetch = global.fetch;

const mockJob = createJob({
  id: "test-job",
  source: "gradcracker",
  title: "Senior Engineer",
  employer: "Test Corp",
  jobDescription: "Looking for a TypeScript and React expert.",
  status: "discovered",
  suitabilityScore: null,
  suitabilityReason: null,
});

const mockProfile = { name: "Test User" };

describe("AI Service Resilience", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    delete process.env.LLM_API_KEY;
    process.env.OPENROUTER_API_KEY = "mock-key"; // Ensure logic tries to call API
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      llmProvider: "openrouter",
      llmApiKey: "mock-key",
    });
  });

  afterEach(() => {
    global.fetch = globalFetch;
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    vi.restoreAllMocks();
  });

  describe("scoreJobSuitability (Scorer)", () => {
    it("should return parsed score when API returns valid JSON", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ score: 85, reason: "Great match" }),
              },
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      const result = await asTenant(() => scoreJobSuitability(mockJob, mockProfile));

      expect(result.score).toBe(85);
      expect(result.reason).toBe("Great match");
    });

    it("should throw LlmNotConfiguredError if API Key is missing", async () => {
      delete process.env.OPENROUTER_API_KEY;
      vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({});

      await expect(asTenant(() => scoreJobSuitability(mockJob, mockProfile))).rejects.toThrow(
        "LLM API key not configured",
      );
    });

    it("should throw LlmTransientError on API 5xx errors (per-job skip, not a config pause)", async () => {
      // An upstream 5xx is transient — the LLM error contract routes it to
      // LlmTransientError so score-jobs skips this one job and continues,
      // rather than pausing the whole run. `.text()` is provided because the
      // provider reads the error body.
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Internal Server Error",
      } as any);

      await expect(
        asTenant(() => scoreJobSuitability(mockJob, mockProfile)),
      ).rejects.toThrow("AI temporarily unavailable");
    });

    it("should throw LlmTransientError on Malformed/Invalid JSON in API response", async () => {
      // A 200 with unparseable content is a transient parse failure, not a
      // config error — same per-job-skip contract as a 5xx.
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "This is not JSON at all, just text." } },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      await expect(
        asTenant(() => scoreJobSuitability(mockJob, mockProfile)),
      ).rejects.toThrow("AI temporarily unavailable");
    });

    it("should extract JSON from markdown code blocks", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  'Here is the score: ```json\n{ "score": 90, "reason": "Good" }\n```',
              },
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      const result = await asTenant(() => scoreJobSuitability(mockJob, mockProfile));
      expect(result.score).toBe(90);
    });
  });

  describe("pickProjectIdsForJob (Project Selection)", () => {
    const mockProjects = [
      {
        id: "p1",
        name: "React App",
        description: "Used React",
        date: "2022",
        summaryText: "React stuff",
        isVisibleInBase: true,
      },
      {
        id: "p2",
        name: "Python Script",
        description: "Used Python",
        date: "2023",
        summaryText: "Python stuff",
        isVisibleInBase: true,
      },
    ];

    it("should return projects selected by AI", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ selectedProjectIds: ["p1"] }),
              },
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      const result = await pick({
        jobDescription: "React dev",
        eligibleProjects: mockProjects,
        desiredCount: 1,
      });

      expect(result).toEqual(["p1"]);
    });

    it("throws (no silent keyword fallback) if the API call fails", async () => {
      // The keyword-matching fallback was removed deliberately: a failed AI
      // call now surfaces as LlmNotConfiguredError so the pipeline pauses and
      // asks the user to fix their config, rather than silently shipping a
      // guessed project list. See projectSelection.ts.
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));

      await expect(
        pick({
          jobDescription: "React dev",
          eligibleProjects: mockProjects,
          desiredCount: 1,
        }),
      ).rejects.toThrow(/AI project selection failed/);
    });

    it("throws (no silent keyword fallback) if the AI returns garbage", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "No valid JSON here" } }],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      await expect(
        pick({
          jobDescription: "Python dev",
          eligibleProjects: mockProjects,
          desiredCount: 1,
        }),
      ).rejects.toThrow(/AI project selection failed/);
    });

    it("should validate returned IDs exist in eligible list", async () => {
      // AI returns an ID that doesn't exist ('p999')
      const mockResponse = {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ selectedProjectIds: ["p999", "p1"] }),
              },
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(mockResponse as any);

      const result = await pick({
        jobDescription: "stuff",
        eligibleProjects: mockProjects,
        desiredCount: 2,
      });

      // Should strip p999 and only return p1
      expect(result).toEqual(["p1"]);
    });
  });
});
