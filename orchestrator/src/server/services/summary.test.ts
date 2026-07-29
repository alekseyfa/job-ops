import type { ResumeProfile } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithRequestContext } from "@infra/request-context";
import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";

// generateTailoring runs inside the pipeline's tenant context in production
// (-> getEffectiveSettings -> design-resume repo, fail-closed on tenancy).
// Unit tests must supply that ambient context or the repo throws
// "Tenant context is required". Static import binds the same singleton
// AsyncLocalStorage the statically-imported service uses (no vi.resetModules
// here), so this wrapper is sufficient.
function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ tenantId: DEFAULT_TENANT_ID }, fn);
}

const callJsonMock = vi.fn();
const getProviderMock = vi.fn();
const getBaseUrlMock = vi.fn();

vi.mock("../repositories/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
    getProvider = getProviderMock;
    getBaseUrl = getBaseUrlMock;
  },
}));

vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();

  return {
    ...actual,
    getWritingStyle: vi.fn(),
  };
});

import { getSetting } from "../repositories/settings";
import { LlmNotConfiguredError } from "./llm-errors";
import {
  computeTailoringFingerprint,
  generateTailoring,
  TAILORING_PROMPT_VERSION,
} from "./summary";
import { getWritingStyle } from "./writing-style";

describe("computeTailoringFingerprint (WS1-T7)", () => {
  it("is stable for identical inputs", () => {
    const a = computeTailoringFingerprint({ jobDescription: "JD", includeExperience: false });
    const b = computeTailoringFingerprint({ jobDescription: "JD", includeExperience: false });
    expect(a).toBe(b);
  });

  it("changes when the job description changes", () => {
    const a = computeTailoringFingerprint({ jobDescription: "JD one", includeExperience: false });
    const b = computeTailoringFingerprint({ jobDescription: "JD two", includeExperience: false });
    expect(a).not.toBe(b);
  });

  it("changes when the experience flag changes", () => {
    const a = computeTailoringFingerprint({ jobDescription: "JD", includeExperience: false });
    const b = computeTailoringFingerprint({ jobDescription: "JD", includeExperience: true });
    expect(a).not.toBe(b);
  });

  it("exposes a numeric prompt version that callers can bump", () => {
    expect(typeof TAILORING_PROMPT_VERSION).toBe("number");
  });
});

describe("generateTailoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderMock.mockReturnValue("openrouter");
    getBaseUrlMock.mockReturnValue("https://openrouter.ai");
    callJsonMock.mockResolvedValue({
      success: true,
      data: {
        summary: "Tailored summary",
        headline: "Senior Engineer",
        skills: [],
      },
    });
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "Keep it under 90 words",
      doNotUse: "synergy",
      languageMode: "manual",
      manualLanguage: "german",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });
  });

  it("passes shared writing-style and language instructions into tailoring prompts", async () => {
    const profile: ResumeProfile = {
      basics: {
        name: "Test User",
        label: "Engineer",
        summary: "Existing summary",
      },
    };

    await asTenant(() => generateTailoring("Build APIs", profile));

    expect(callJsonMock).toHaveBeenCalledTimes(1);

    const request = callJsonMock.mock.calls[0]?.[0];
    expect(request?.messages?.[0]?.content).toContain(
      "WRITING STYLE PREFERENCES:",
    );
    expect(request?.messages?.[0]?.content).toContain("Tone: friendly");
    expect(request?.messages?.[0]?.content).toContain("Formality: low");
    expect(request?.messages?.[0]?.content).toContain(
      "Additional constraints: Keep it under 90 words",
    );
    expect(request?.messages?.[0]?.content).toContain(
      "Avoid these words or phrases: synergy",
    );
    expect(request?.messages?.[0]?.content).toContain(
      "Output language for summary and skills: German",
    );
    expect(request?.messages?.[0]?.content).toContain(
      "Do NOT translate, localize, or paraphrase the headline, even if the rest of the output is in German.",
    );
    expect(request?.messages?.[0]?.content).toContain(
      'Keep "headline" in the exact original job-title wording from the JD.',
    );
  });

  it("removes language directives from constraints so explicit language settings win", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "Always respond in French. Keep it under 90 words.",
      doNotUse: "synergy",
      languageMode: "manual",
      manualLanguage: "german",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: {
          name: "Test User",
          label: "Engineer",
        },
      }),
    );

    const request = callJsonMock.mock.calls.at(-1)?.[0];
    expect(request?.messages?.[0]?.content).toContain(
      "Additional constraints: Keep it under 90 words",
    );
    expect(request?.messages?.[0]?.content).not.toContain(
      "Always respond in French",
    );
    expect(request?.messages?.[0]?.content).toContain(
      "Output language for summary and skills: German",
    );
  });

  it("uses a stored tailoring prompt template override", async () => {
    vi.mocked(getSetting).mockImplementation(async (key) =>
      key === "tailoringPromptTemplate"
        ? "Tailor {{tone}} {{outputLanguage}} {{unknownToken}}"
        : null,
    );

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: {
          name: "Test User",
          label: "Engineer",
        },
      }),
    );

    const request = callJsonMock.mock.calls.at(-1)?.[0];
    expect(request?.messages?.[0]?.content).toContain(
      "Tailor friendly German {{unknownToken}}",
    );
  });

  it("includes word limit when summaryMaxWords is set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 35,
      maxKeywordsPerSkill: null,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).toContain("Maximum 35 words.");
  });

  it("uses singular 'word' when summaryMaxWords is 1", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 1,
      maxKeywordsPerSkill: null,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).toContain("Maximum 1 word.");
  });

  it("omits word limit line when summaryMaxWords is null", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).not.toContain("Maximum");
  });

  it("includes keyword limit when maxKeywordsPerSkill is set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: 8,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).toContain("Maximum 8 keywords per category");
  });

  it("omits keyword limit when maxKeywordsPerSkill is null", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).not.toContain("keywords per category");
  });

  it("includes both limits and constraints when all set", async () => {
    vi.mocked(getWritingStyle).mockResolvedValue({
      tone: "friendly",
      formality: "low",
      constraints: "keep under 90 words",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: 35,
      maxKeywordsPerSkill: 8,
    });

    await asTenant(() =>
      generateTailoring("Build APIs", {
        basics: { name: "Test User", label: "Engineer" },
      }),
    );

    const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
    expect(prompt).toContain("Maximum 35 words.");
    expect(prompt).toContain("Maximum 8 keywords per category");
    // "keep under 90 words" is stripped from constraints because summaryMaxWords (35) takes precedence
    expect(prompt).not.toContain("keep under 90 words");
  });

  // WS1-T1: feed the scorer's match analysis into tailoring + drop the
  // "Keyword Stuffing" instruction. Also acts as the WS1-T0 baseline guard.
  describe("matchAnalysis wiring (WS1-T1)", () => {
    const profile: ResumeProfile = {
      basics: { name: "Test User", label: "Engineer", summary: "Existing summary" },
    };

    it("never instructs keyword stuffing (provenance-safe prompt)", async () => {
      await asTenant(() => generateTailoring("Build APIs", profile));
      const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      expect(prompt).not.toContain("Keyword Stuffing");
      expect(prompt).toContain(
        "Do NOT add any skill or technology that is not already present",
      );
    });

    it("renders empty scorer-signal lines when no matchAnalysis is given (baseline)", async () => {
      await asTenant(() => generateTailoring("Build APIs", profile));
      const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      // The section header is always present, but the values are empty.
      expect(prompt).toContain("SCORER SIGNAL");
      expect(prompt).toContain("Priority JD keywords to surface where I genuinely have them: \n");
    });

    it("omits the experience instruction unless includeExperience is set", async () => {
      await asTenant(() => generateTailoring("Build APIs", profile));
      const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      expect(prompt).not.toContain("EXPERIENCE TAILORING");
    });

    it("appends the rephrase-only experience instruction when includeExperience is set", async () => {
      await asTenant(() =>
        generateTailoring("Build APIs", profile, null, {
          includeExperience: true,
        }),
      );
      const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      expect(prompt).toContain("EXPERIENCE TAILORING");
      expect(prompt).toContain("NEVER invent");
      // Schema must now require an experience array.
      const schema = callJsonMock.mock.calls.at(-1)?.[0]?.jsonSchema;
      expect(schema?.schema?.required).toContain("experience");
    });

    it("injects priority keywords, missing skills, and tips from matchAnalysis", async () => {
      await asTenant(() =>
        generateTailoring("Senior Backend Engineer with Python", profile, {
          requirements: { met: [], missing: [], partial: [] },
          skills: {
            matched: [],
            missing: ["GraphQL"],
            transferable: [],
            bonus: [],
          },
          experience: { levelMatch: "match", yearsRequired: null, yearsApparent: null },
          keywords: { addToResume: ["distributed systems"] },
          dealBreakers: [],
          tailoringTips: ["Lead with the payments project"],
        }),
      );
      const prompt = callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      expect(prompt).toContain("distributed systems"); // title-class priority keyword
      expect(prompt).toContain("GraphQL"); // missing skill surfaced
      expect(prompt).toContain("Lead with the payments project"); // tailoring tip
    });
  });

  describe("LLM error contract", () => {
    const profile: ResumeProfile = {
      basics: { name: "Test User", label: "Engineer" },
    };

    it("throws LlmNotConfiguredError on a config-class failure so the run pauses", async () => {
      // Regression: a 401/invalid-key during the PROCESSING phase used to
      // soft-fail here, so the run reported "completed" with 0 tailored jobs
      // instead of pausing. It must now throw so the orchestrator pauses and
      // tells the user to fix their settings (mirrors scorer.ts).
      callJsonMock.mockResolvedValue({
        success: false,
        error: "401 Unauthorized: invalid api key",
      });

      await expect(
        asTenant(() => generateTailoring("Build APIs", profile)),
      ).rejects.toBeInstanceOf(LlmNotConfiguredError);
    });

    it("soft-fails (does NOT throw) on a transient failure so the job is retried next run", async () => {
      callJsonMock.mockResolvedValue({
        success: false,
        error: "503 Service Unavailable: upstream timeout",
      });

      const result = await asTenant(() =>
        generateTailoring("Build APIs", profile),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("503 Service Unavailable");
    });
  });
});
