/**
 * Fast, deterministic regression guards for the scoring PROMPT CONTRACT —
 * not "is the score correct" (that needs a real LLM, see
 * pipeline/scoring-eval.ts), but "does the prompt we build actually contain
 * the candidate's real, readable resume content."
 *
 * These exist because of a real incident: scorer.ts sent raw HTML
 * (<p>/<ul>/<li> from the design-resume import) straight into the scoring
 * prompt's JSON payload, and the LLM — unable to parse the resume as
 * substantive content — repeatedly scored jobs 45-50 with reasoning like
 * "the candidate's profile is incomplete", even though the resume was fully
 * populated. Nothing crashed and no existing test caught it; only a live
 * pipeline run against real data surfaced it. This file locks in the prompt
 * shape so that class of bug fails fast, in CI, before it reaches a user's
 * job list.
 *
 * See CLAUDE.md → "Scoring Accuracy Tests" for the second tier (a live-LLM
 * semantic eval) and when to run it.
 */

import { getDefaultPromptTemplate } from "@shared/prompt-template-definitions.js";
import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixtureProfile, buildStrongMatchJob } from "./scoring-fixtures";

const {
  getEffectiveSettingsMock,
  getSettingMock,
  resolveLlmModelMock,
  createConfiguredLlmServiceMock,
  callJsonMock,
} = vi.hoisted(() => ({
  getEffectiveSettingsMock: vi.fn(),
  getSettingMock: vi.fn(),
  resolveLlmModelMock: vi.fn(),
  createConfiguredLlmServiceMock: vi.fn(),
  callJsonMock: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));

vi.mock("../repositories/settings", () => ({
  getSetting: getSettingMock,
}));

vi.mock("./modelSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./modelSelection")>();
  return {
    ...actual,
    resolveLlmModel: resolveLlmModelMock,
    createConfiguredLlmService: createConfiguredLlmServiceMock,
  };
});

import { scoreJobSuitability } from "./scorer";

/** Pulls the exact prompt string sent to the LLM out of the mock's last call. */
function capturedPrompt(): string {
  const call = callJsonMock.mock.calls.at(-1)?.[0];
  return call?.messages?.[0]?.content ?? "";
}

describe("scoring prompt contract", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      capScoreOnDealBreakers: { value: true, default: true, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      scoringPromptTemplate: {
        value: getDefaultPromptTemplate("scoringPromptTemplate"),
        default: getDefaultPromptTemplate("scoringPromptTemplate"),
        override: null,
      },
      rxresumeBaseResumeId: "base-resume-123",
    } as any);
    resolveLlmModelMock.mockResolvedValue("test-model");
    callJsonMock.mockResolvedValue({
      success: true,
      data: { score: 70, reason: "Reasonable fit" },
    });
    createConfiguredLlmServiceMock.mockResolvedValue({ callJson: callJsonMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never sends raw HTML tags from the resume to the LLM", async () => {
    const profile = buildFixtureProfile();
    await scoreJobSuitability(buildStrongMatchJob(), profile);

    const prompt = capturedPrompt();
    // The fixture profile deliberately includes <p>, <ul>, <li>, <strong>,
    // <em> — the exact tag set the resume-import prompt allows. If any of
    // these survive into the LLM prompt, sanitizeProfileForPrompt() has
    // regressed and stopped stripping HTML.
    expect(prompt).not.toMatch(/<p>|<\/p>|<ul>|<\/ul>|<li>|<\/li>|<strong>|<em>/);
  });

  it("still contains the plain-text resume content after stripping HTML", async () => {
    const profile = buildFixtureProfile();
    await scoreJobSuitability(buildStrongMatchJob(), profile);

    const prompt = capturedPrompt();
    // Guards against a fix that strips HTML by deleting the whole field
    // instead of just the tags — the words must survive, not just vanish.
    expect(prompt).toContain("Own the payments processing service");
    expect(prompt).toContain("Kubernetes-based autoscaling pipeline");
    expect(prompt).toContain("Distributed token-bucket rate limiter");
    expect(prompt).toContain(
      "Backend engineer with 8+ years building high-throughput distributed systems",
    );
  });

  it("includes the candidate's skills so the model can see the real stack", async () => {
    const profile = buildFixtureProfile();
    await scoreJobSuitability(buildStrongMatchJob(), profile);

    const prompt = capturedPrompt();
    expect(prompt).toContain("Kubernetes");
    expect(prompt).toContain("Postgres");
    expect(prompt).toContain("Python");
  });

  it("caps experience at the first 5 items without silently dropping the rest of the array", async () => {
    const profile = buildFixtureProfile({ experienceCount: 6 });
    await scoreJobSuitability(buildStrongMatchJob(), profile);

    const prompt = capturedPrompt();
    expect(prompt).toContain("Northwind Systems");
    expect(prompt).toContain("Cedarline Tech"); // 5th item, still included
    expect(prompt).not.toContain("Should Never Appear Co"); // 6th item, capped
  });

  it("caps projects at the first 6 items without silently dropping the rest of the array", async () => {
    const profile = buildFixtureProfile({ projectCount: 7 });
    await scoreJobSuitability(buildStrongMatchJob(), profile);

    const prompt = capturedPrompt();
    expect(prompt).toContain("Postgres query planner visualizer");
    expect(prompt).not.toContain("Should never appear project E"); // 7th item, capped
  });

  it("truncates job descriptions over 8000 chars with an explicit marker, not silently", async () => {
    const longDescription = `${"Requirement bullet point. ".repeat(400)}`; // > 8000 chars
    await scoreJobSuitability(
      buildStrongMatchJob({ jobDescription: longDescription }),
      buildFixtureProfile(),
    );

    const prompt = capturedPrompt();
    expect(prompt).toContain("[description truncated]");
  });

  it("does NOT truncate job descriptions under the 8000-char limit", async () => {
    const shortDescription = "A normal-length job description.";
    await scoreJobSuitability(
      buildStrongMatchJob({ jobDescription: shortDescription }),
      buildFixtureProfile(),
    );

    const prompt = capturedPrompt();
    expect(prompt).not.toContain("[description truncated]");
    expect(prompt).toContain(shortDescription);
  });

  describe("dealbreaker-cap visibility (matchAnalysis.uncappedScore)", () => {
    it("records the pre-cap score so the UI can show \"would've scored X\"", async () => {
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 82,
          reason: "Strong technical fit",
          dealBreakers: ["Active security clearance required"],
        },
      });

      const result = await scoreJobSuitability(
        buildStrongMatchJob(),
        buildFixtureProfile(),
      );

      expect(result.score).toBe(50);
      expect(result.matchAnalysis?.uncappedScore).toBe(82);
    });

    it("leaves uncappedScore unset when no cap was applied", async () => {
      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 75, reason: "Good fit", dealBreakers: [] },
      });

      const result = await scoreJobSuitability(
        buildStrongMatchJob(),
        buildFixtureProfile(),
      );

      expect(result.score).toBe(75);
      expect(result.matchAnalysis?.uncappedScore).toBeUndefined();
    });
  });

  it("still builds a well-formed prompt for a profile with no HTML at all (plain-text resumes)", async () => {
    // Not every resume goes through the rich-text importer — some profiles
    // arrive as plain strings. The stripper must be a no-op here, not a bug.
    const job = createJob({ id: "plain-text-profile", title: "Backend Engineer" });
    await scoreJobSuitability(job, {
      basics: { label: "Backend Engineer", summary: "Plain text summary, no markup." },
      sections: {
        skills: null,
        experience: { items: [] },
        projects: { items: [] },
        education: { items: [] },
      },
    });

    const prompt = capturedPrompt();
    expect(prompt).toContain("Plain text summary, no markup.");
  });
});
