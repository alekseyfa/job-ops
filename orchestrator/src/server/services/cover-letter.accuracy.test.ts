/**
 * Fast, deterministic regression guards for the cover-letter PROMPT CONTRACT
 * — mirrors scorer.accuracy.test.ts. Cover letters build a profile summary
 * from the same rich-text profile fields (basics.summary, experience[].summary,
 * projects[].description) that caused the scoring-HTML incident documented in
 * CLAUDE.md ("Scoring Accuracy Gate"): raw HTML from the resume reached an LLM
 * prompt unstripped, and the model silently produced bad output. Nothing
 * crashed and no test caught it until a live run surfaced it. This file locks
 * in the cover-letter prompt shape so the same bug class fails fast, in CI.
 */

import type { ResumeProfile } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixtureProfile, buildStrongMatchJob } from "./scoring-fixtures";

const { getSettingMock, resolveLlmModelMock, createConfiguredLlmServiceMock, callJsonMock } =
  vi.hoisted(() => ({
    getSettingMock: vi.fn(),
    resolveLlmModelMock: vi.fn(),
    createConfiguredLlmServiceMock: vi.fn(),
    callJsonMock: vi.fn(),
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

import { generateCoverLetter } from "./cover-letter";

const FAKE_LETTER =
  "Riverton Cloud's payments platform is exactly the kind of high-throughput distributed system I've spent eight years building. " +
  "At Northwind Systems I migrated a core API from Python 2 to Python 3 with zero downtime and designed a Kubernetes-based " +
  "autoscaling pipeline that cut infrastructure cost by 30 percent, the same pattern of ownership this role asks for. " +
  "I have shipped a distributed token-bucket rate limiter used across three internal services, giving me a concrete feel " +
  "for the throughput and reliability bar the job description sets. I would welcome the chance to bring that experience " +
  "to a team mentoring others on distributed systems fundamentals.";

function profile(overrides?: Parameters<typeof buildFixtureProfile>[0]): ResumeProfile {
  return buildFixtureProfile(overrides) as unknown as ResumeProfile;
}

/** Pulls the exact prompt string sent to the LLM out of the mock's last call. */
function capturedPrompt(): string {
  const call = callJsonMock.mock.calls.at(-1)?.[0];
  return call?.messages?.[0]?.content ?? "";
}

describe("cover letter prompt contract", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    resolveLlmModelMock.mockResolvedValue("test-model");
    callJsonMock.mockResolvedValue({
      success: true,
      data: { coverLetter: FAKE_LETTER },
    });
    createConfiguredLlmServiceMock.mockResolvedValue({ callJson: callJsonMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never sends raw HTML tags from the resume to the LLM", async () => {
    await generateCoverLetter(buildStrongMatchJob(), profile());

    const prompt = capturedPrompt();
    expect(prompt).not.toMatch(/<p>|<\/p>|<ul>|<\/ul>|<li>|<\/li>|<strong>|<em>/);
  });

  it("still contains the plain-text resume content after stripping HTML", async () => {
    await generateCoverLetter(buildStrongMatchJob(), profile());

    const prompt = capturedPrompt();
    expect(prompt).toContain("Own the payments processing service");
    expect(prompt).toContain("Kubernetes-based autoscaling pipeline");
    expect(prompt).toContain("Distributed token-bucket rate limiter");
    expect(prompt).toContain(
      "Backend engineer with 8+ years building high-throughput distributed systems",
    );
  });

  it("caps experience at the first 5 items without silently dropping the rest of the array", async () => {
    await generateCoverLetter(
      buildStrongMatchJob(),
      profile({ experienceCount: 6 }),
    );

    const prompt = capturedPrompt();
    expect(prompt).toContain("Northwind Systems");
    expect(prompt).toContain("Cedarline Tech"); // 5th item, still included
    expect(prompt).not.toContain("Should Never Appear Co"); // 6th item, capped
  });

  it("caps projects at the first 6 items without silently dropping the rest of the array", async () => {
    await generateCoverLetter(
      buildStrongMatchJob(),
      profile({ projectCount: 7 }),
    );

    const prompt = capturedPrompt();
    expect(prompt).toContain("Postgres query planner visualizer");
    expect(prompt).not.toContain("Should never appear project E"); // 7th item, capped
  });

  it("truncates job descriptions over 8000 chars with an explicit marker, not silently", async () => {
    const longDescription = "Requirement bullet point. ".repeat(400); // > 8000 chars
    await generateCoverLetter(
      buildStrongMatchJob({ jobDescription: longDescription }),
      profile(),
    );

    const prompt = capturedPrompt();
    expect(prompt).toContain("[description truncated]");
  });

  it("does NOT truncate job descriptions under the 8000-char limit", async () => {
    const shortDescription = "A normal-length job description.";
    await generateCoverLetter(
      buildStrongMatchJob({ jobDescription: shortDescription }),
      profile(),
    );

    const prompt = capturedPrompt();
    expect(prompt).not.toContain("[description truncated]");
    expect(prompt).toContain(shortDescription);
  });

  it("still builds a well-formed prompt for a profile with no HTML at all (plain-text resumes)", async () => {
    const job = buildStrongMatchJob({ id: "plain-text-profile" });
    const plainProfile: ResumeProfile = {
      basics: { name: "Jane Doe", label: "Backend Engineer", summary: "Plain text summary, no markup." },
      sections: {
        skills: null,
        experience: { items: [] },
        projects: { items: [] },
        education: { items: [] },
      },
    } as unknown as ResumeProfile;

    await generateCoverLetter(job, plainProfile);

    const prompt = capturedPrompt();
    expect(prompt).toContain("Plain text summary, no markup.");
  });

  it("keeps the banned-phrases and no-salutation guardrails in the prompt", async () => {
    await generateCoverLetter(buildStrongMatchJob(), profile());

    const prompt = capturedPrompt();
    expect(prompt).toContain("passionate about");
    expect(prompt).toContain("results-oriented");
    expect(prompt).toMatch(/salutation/i);
  });

  it("rejects a too-short LLM response instead of returning a stub letter", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { coverLetter: "Too short." },
    });

    const result = await generateCoverLetter(buildStrongMatchJob(), profile());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too short/i);
  });

  it("gives a clear config-check message when the LLM call fails for a config reason", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "401 Unauthorized: invalid API key",
    });

    const result = await generateCoverLetter(buildStrongMatchJob(), profile());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM not configured/i);
  });

  it("passes through the raw error message for a transient LLM failure", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "503 Service Unavailable",
    });

    const result = await generateCoverLetter(buildStrongMatchJob(), profile());

    expect(result.success).toBe(false);
    expect(result.error).toBe("503 Service Unavailable");
  });

  it("returns an error instead of calling the LLM when the job has no description", async () => {
    const job = buildStrongMatchJob({ jobDescription: "" });

    const result = await generateCoverLetter(job, profile());

    expect(result.success).toBe(false);
    expect(callJsonMock).not.toHaveBeenCalled();
  });
});
