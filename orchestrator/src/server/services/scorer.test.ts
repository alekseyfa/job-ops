/**
 * Tests for scorer.ts - focusing on robust JSON parsing from AI responses
 */

import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { parseJsonFromContent } from "./scorer";

describe("parseJsonFromContent", () => {
  describe("valid JSON inputs", () => {
    it("should parse clean JSON object", () => {
      const input = '{"score": 85, "reason": "Great match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85);
      expect(result.reason).toBe("Great match");
    });

    it("should parse JSON with extra whitespace", () => {
      const input = '  { "score" : 75 , "reason" : "Good fit" }  ';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(75);
      expect(result.reason).toBe("Good fit");
    });

    it("should parse JSON with newlines", () => {
      const input = `{
        "score": 90,
        "reason": "Excellent match for the role"
      }`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(90);
      expect(result.reason).toBe("Excellent match for the role");
    });
  });

  describe("markdown code fences", () => {
    it("should strip ```json code fences", () => {
      const input = '```json\n{"score": 80, "reason": "Match"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });

    it("should strip ```JSON code fences (uppercase)", () => {
      const input = '```JSON\n{"score": 80, "reason": "Match"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });

    it("should strip ``` code fences without language specifier", () => {
      const input = '```\n{"score": 70, "reason": "Decent"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(70);
    });

    it("should handle nested code fence patterns", () => {
      const input =
        'Here is the score:\n```json\n{"score": 65, "reason": "Partial match"}\n```\nEnd.';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(65);
    });
  });

  describe("surrounding text", () => {
    it("should extract JSON from text before", () => {
      const input =
        'Based on my analysis, here is my evaluation: {"score": 55, "reason": "Limited match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(55);
    });

    it("should extract JSON from text after", () => {
      const input =
        '{"score": 60, "reason": "Moderate match"} I hope this helps!';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(60);
    });

    it("should extract JSON from surrounding text on both sides", () => {
      const input =
        'Here is my response:\n\n{"score": 45, "reason": "Below average fit"}\n\nLet me know if you need more details.';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(45);
    });
  });

  describe("common JSON formatting issues", () => {
    it("should handle trailing comma before closing brace", () => {
      const input = '{"score": 78, "reason": "Good skills",}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(78);
    });

    it("should handle single quotes instead of double quotes", () => {
      const input = "{'score': 82, 'reason': 'Strong candidate'}";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(82);
    });

    it("should handle unquoted keys", () => {
      const input = '{score: 77, reason: "Reasonable match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(77);
    });

    it("should handle mixed issues (trailing comma, single quotes)", () => {
      const input = "{'score': 68, 'reason': 'Average fit',}";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(68);
    });
  });

  describe("decimal scores", () => {
    it("should parse and round decimal scores", () => {
      // parseJsonFromContent returns raw value for valid JSON; rounding only in regex fallback
      const input = '{"score": 85.7, "reason": "Very good match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85.7);
    });

    it("should parse decimal scores in malformed text", () => {
      const input = 'The score is score: 72.3, reason: "Above average"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(72);
    });
  });

  describe("malformed responses - regex fallback", () => {
    it("should extract score from completely malformed response", () => {
      const input =
        'I think the score should be score: 50 and the reason: "Average candidate"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(50);
    });

    it("should extract score with equals sign syntax", () => {
      const input = 'score = 88, reason = "Excellent match"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(88);
    });

    it("should handle reason with special characters", () => {
      const input =
        '{"score": 73, "reason": "Good match! The candidate\'s skills align well."}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(73);
    });

    it("should provide default reason when only score is extractable", () => {
      const input = "I rate this candidate 85 out of 100 - score: 85";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85);
      expect(result.reason).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle zero score", () => {
      const input = '{"score": 0, "reason": "No match at all"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(0);
    });

    it("should handle score of 100", () => {
      const input = '{"score": 100, "reason": "Perfect candidate"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(100);
    });

    it("should handle empty reason", () => {
      const input = '{"score": 50, "reason": ""}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(50);
      expect(result.reason).toBe("");
    });

    it("should handle multiline reason", () => {
      const input = `{"score": 70, "reason": "Good skills match. Experience is a bit lacking."}`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(70);
      expect(result.reason).toContain("Good skills match");
    });

    it("should handle unicode in reason", () => {
      const input = '{"score": 80, "reason": "Great match ✓ for this role"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });
  });

  describe("failure cases", () => {
    it("should throw when no score can be extracted", () => {
      const input = "This is just plain text with no JSON or score.";
      expect(() => parseJsonFromContent(input)).toThrow(
        "Unable to parse JSON from model response",
      );
    });

    it("should throw for empty input", () => {
      expect(() => parseJsonFromContent("")).toThrow(
        "Unable to parse JSON from model response",
      );
    });

    it("should throw for only whitespace", () => {
      expect(() => parseJsonFromContent("   \n\t   ")).toThrow(
        "Unable to parse JSON from model response",
      );
    });
  });

  describe("real-world AI responses", () => {
    it("should handle GPT-style verbose response", () => {
      const input = `Based on my analysis of the job description and candidate profile, I have evaluated the fit:

\`\`\`json
{
  "score": 72,
  "reason": "Strong React and TypeScript skills match. However, the role requires 5+ years experience which the candidate may not have."
}
\`\`\`

This score reflects the candidate's technical capabilities while accounting for the experience gap.`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(72);
      expect(result.reason).toContain("React and TypeScript");
    });

    it("should handle Claude-style response with thinking", () => {
      const input = `Let me evaluate this candidate against the job requirements.

{"score": 83, "reason": "Excellent frontend skills with React and modern tooling. Good culture fit based on startup experience."}`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(83);
    });

    it("should handle response with JSON5-style comments", () => {
      // Some models output JSON5-like syntax with comments
      const input = `{
  "score": 67, // Good but not great
  "reason": "Matches most requirements but lacks cloud experience"
}`;
      // This will fail standard parse but regex should catch it
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(67);
    });

    it("should handle response with extra properties", () => {
      const input =
        '{"score": 79, "reason": "Good match", "confidence": "high", "breakdown": {"skills": 25, "experience": 20}}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(79);
      expect(result.reason).toBe("Good match");
    });
  });
});

describe("salary penalty", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: true, default: true, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      capScoreOnDealBreakers: { value: true, default: true, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      scoringPromptTemplate: { value: "", default: "", override: null },
      rxresumeBaseResumeId: "base-resume-123",
    } as any);
    resolveLlmModelMock.mockResolvedValue("gpt-4.1-mini");
    callJsonMock.mockResolvedValue({
      success: true,
      data: { score: 80, reason: "Good match" },
    });
    createConfiguredLlmServiceMock.mockResolvedValue({
      callJson: callJsonMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isSalaryMissing detection", () => {
    it("should detect null salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70); // 80 - 10
      expect(result.reason).toContain(
        "Score reduced by 10 points due to missing salary information",
      );
    });

    it("should detect empty string salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70);
      expect(result.reason).toContain("missing salary information");
    });

    it("should detect whitespace-only salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "   ",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70);
      expect(result.reason).toContain("missing salary information");
    });

    it("should NOT penalize jobs with non-empty salary", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "Competitive",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty
      expect(result.reason).not.toContain("missing salary");
    });

    it("should NOT penalize jobs with actual salary value", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "£40,000 - £50,000",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty
      expect(result.reason).not.toContain("missing salary");
    });
  });

  describe("penalty application", () => {
    it("includes custom scoring instructions in the scorer prompt", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: {
          value:
            "Open to relocating, so do not mark down for location discrepancies.",
          default: "",
          override:
            "Open to relocating, so do not mark down for location discrepancies.",
        },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        title: "Software Engineer",
      });

      await scoreJobSuitability(job, {});

      expect(callJsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.stringContaining(
                "Open to relocating, so do not mark down for location discrepancies.",
              ),
            }),
          ],
        }),
      );
    });

    it("uses a custom scoring prompt template override", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: {
          value: "Prioritize backend work.",
          default: "",
          override: "Prioritize backend work.",
        },
        scoringPromptTemplate: {
          value:
            "Custom scoring {{jobTitle}} {{scoringInstructionsText}} {{unknownToken}}",
          default: "",
          override:
            "Custom scoring {{jobTitle}} {{scoringInstructionsText}} {{unknownToken}}",
        },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      await scoreJobSuitability(
        createJob({
          id: "test-job-custom-template",
          title: "Backend Engineer",
        }),
        {},
      );

      expect(callJsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.stringContaining(
                "Custom scoring Backend Engineer Prioritize backend work. {{unknownToken}}",
              ),
            }),
          ],
        }),
      );
    });

    it("should not apply penalty when disabled", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty when disabled
      expect(result.reason).not.toContain("missing salary");
    });

    it("should clamp score to minimum 0 (high penalty on medium score)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 100, default: 100, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 50, reason: "Average match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(0); // Clamped, not negative
      expect(result.reason).toContain("Score reduced by 100 points");
    });

    it("should clamp score to minimum 0 (low score with penalty)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 5, reason: "Weak match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(0); // 5 - 10 = -5, clamped to 0
      expect(result.reason).toContain("Score reduced by 10 points");
    });

    it("should handle penalty of 0", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 0, default: 0, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No change with 0 penalty
      expect(result.reason).toContain("Score reduced by 0 points");
    });

    it("should apply penalty with correct amount", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 25, default: 25, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 90, reason: "Excellent match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(65); // 90 - 25
      expect(result.reason).toContain(
        "Score reduced by 25 points due to missing salary information",
      );
    });
  });

  describe("dealbreaker score cap", () => {
    it("caps score to 50 when dealBreakers present and score exceeds cap", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 85,
          reason: "Strong technical fit",
          dealBreakers: ["No visa sponsorship — unrestricted work authorization required"],
        },
      });

      const job = createJob({
        id: "test-job-deal-1",
        title: "Engineer",
        salary: "Competitive", // avoid the shared beforeEach's salary penalty
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(50);
      expect(result.reason).toContain(
        "Score capped at 50 due to unresolved hard requirement(s)",
      );
      expect(result.reason).toContain("No visa sponsorship");
    });

    it("does NOT cap when dealBreakers is an empty array", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 85, reason: "Great fit", dealBreakers: [] },
      });

      const job = createJob({
        id: "test-job-deal-2",
        title: "Engineer",
        salary: "Competitive",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(85);
      expect(result.reason).not.toContain("capped");
    });

    it("does NOT cap when dealBreakers is absent (older/simpler model responses)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 85, reason: "Great fit" },
      });

      const job = createJob({
        id: "test-job-deal-3",
        title: "Engineer",
        salary: "Competitive",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(85);
      expect(result.reason).not.toContain("capped");
    });

    it("is a no-op when the score is already at or below the cap", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 40,
          reason: "Weak fit",
          dealBreakers: ["Missing required degree"],
        },
      });

      const job = createJob({
        id: "test-job-deal-4",
        title: "Engineer",
        salary: "Competitive",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(40);
      expect(result.reason).not.toContain("capped");
    });

    it("does not cap when capScoreOnDealBreakers setting is disabled", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        capScoreOnDealBreakers: { value: false, default: true, override: false },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 90,
          reason: "Great fit",
          dealBreakers: ["No visa sponsorship"],
        },
      });

      const job = createJob({ id: "test-job-deal-5", title: "Engineer" });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(90);
      expect(result.reason).not.toContain("capped");
    });

    it("does not throw when capScoreOnDealBreakers is absent from settings (falls back to enabled)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 90,
          reason: "Great fit",
          dealBreakers: ["No visa sponsorship"],
        },
      });

      const job = createJob({ id: "test-job-deal-6", title: "Engineer" });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(50);
    });

    it("applies the cap before the salary penalty, stacking both reductions", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        capScoreOnDealBreakers: { value: true, default: true, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 90,
          reason: "Great fit",
          dealBreakers: ["No visa sponsorship"],
        },
      });

      const job = createJob({
        id: "test-job-deal-7",
        title: "Engineer",
        salary: null,
      });
      const result = await scoreJobSuitability(job, {});

      // Capped 90 -> 50, then salary penalty 50 - 10 = 40
      expect(result.score).toBe(40);
      expect(result.reason).toContain("capped at 50");
      expect(result.reason).toContain("Score reduced by 10 points");
    });
  });

  describe("LLM failure handling", () => {
    it("throws LlmNotConfiguredError when LLM fails — pipeline must pause, never fake-score", async () => {
      const { scoreJobSuitability, LlmNotConfiguredError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: false,
        error: "API key not configured",
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });

      await expect(scoreJobSuitability(job, {})).rejects.toBeInstanceOf(
        LlmNotConfiguredError,
      );
    });

    it("throws LlmTransientError when LLM returns an invalid score payload (per-job parse problem, not config)", async () => {
      const { scoreJobSuitability, LlmTransientError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: "not-a-number", reason: "garbage" },
      });

      const job = createJob({ id: "test-job-2", title: "Anything" });

      // Invalid payload from the model is a per-response problem — the
      // caller (score-jobs step) skips this one job and continues, with
      // pipeline escalation only happening if the failure rate is high.
      await expect(scoreJobSuitability(job, {})).rejects.toBeInstanceOf(
        LlmTransientError,
      );
    });

    it("throws LlmTransientError on a transient upstream failure (5xx / rate-limit / network)", async () => {
      const { scoreJobSuitability, LlmTransientError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: false,
        error: "503 Service Unavailable",
      });

      const job = createJob({ id: "test-job-3", title: "Anything" });

      // A 503 must NOT pause the whole pipeline. score-jobs catches the
      // transient error and either skips this single job or, if too many
      // pile up, escalates to LlmNotConfiguredError separately.
      await expect(scoreJobSuitability(job, {})).rejects.toBeInstanceOf(
        LlmTransientError,
      );
    });
  });
});
