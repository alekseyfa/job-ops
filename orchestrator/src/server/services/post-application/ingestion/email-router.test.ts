import type {
  Job,
  PostApplicationMessageType,
  PostApplicationRouterStageTarget,
} from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The router calls the LLM via modelSelection. Mock the whole module so the
// unit test never touches a real provider (mirrors onboarding-search-terms.test.ts).
const { callJsonMock } = vi.hoisted(() => ({
  callJsonMock: vi.fn(),
}));

vi.mock("@server/services/modelSelection", () => ({
  createConfiguredLlmService: vi.fn().mockResolvedValue({
    callJson: callJsonMock,
  }),
  resolveLlmModel: vi.fn().mockResolvedValue("test-model"),
}));

import {
  ROUTER_EMAIL_CHAR_LIMIT,
  buildCompactActiveJobsList,
  buildIndexedActiveJobs,
  classifyWithSmartRouter,
  minifyActiveJobs,
  normalizeBestMatchIndex,
} from "./email-router";

type MinifiedJob = { id: string; company: string; title: string };

// Neutral, non-production fixtures (CLAUDE.md: never real employer/person names).
const ACTIVE_JOBS: MinifiedJob[] = [
  { id: "job-1", company: "Test Corp", title: "Backend Engineer" },
  { id: "job-2", company: "Globex Test", title: "Data Analyst" },
];

type LlmData = {
  bestMatchIndex: number | string | null;
  confidence: number | string;
  stageTarget: string;
  isRelevant: boolean;
  stageEventPayload: Record<string, unknown> | null;
  reason: string;
};

function llmSuccess(overrides: Partial<LlmData> = {}) {
  const data: LlmData = {
    bestMatchIndex: 1,
    confidence: 90,
    stageTarget: "no_change",
    isRelevant: true,
    stageEventPayload: null,
    reason: "ok",
    ...overrides,
  };
  return { success: true as const, data };
}

describe("classifyWithSmartRouter — label/confidence -> stage target & decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Core table: the LLM's stageTarget label must map to the derived messageType
  // (the "decision" surfaced downstream) and preserve the target verbatim.
  const labelToDecision: Array<{
    name: string;
    stageTarget: PostApplicationRouterStageTarget;
    expectedTarget: PostApplicationRouterStageTarget;
    expectedType: PostApplicationMessageType;
  }> = [
    {
      name: "rejection",
      stageTarget: "rejected",
      expectedTarget: "rejected",
      expectedType: "rejection",
    },
    {
      name: "withdrawn -> rejection",
      stageTarget: "withdrawn",
      expectedTarget: "withdrawn",
      expectedType: "rejection",
    },
    {
      name: "closed -> rejection",
      stageTarget: "closed",
      expectedTarget: "closed",
      expectedType: "rejection",
    },
    {
      name: "interview invite (technical_interview)",
      stageTarget: "technical_interview",
      expectedTarget: "technical_interview",
      expectedType: "interview",
    },
    {
      name: "assessment -> interview",
      stageTarget: "assessment",
      expectedTarget: "assessment",
      expectedType: "interview",
    },
    {
      name: "hiring_manager_screen -> interview",
      stageTarget: "hiring_manager_screen",
      expectedTarget: "hiring_manager_screen",
      expectedType: "interview",
    },
    {
      name: "onsite -> interview",
      stageTarget: "onsite",
      expectedTarget: "onsite",
      expectedType: "interview",
    },
    {
      name: "offer",
      stageTarget: "offer",
      expectedTarget: "offer",
      expectedType: "offer",
    },
    {
      name: "informational update (recruiter_screen)",
      stageTarget: "recruiter_screen",
      expectedTarget: "recruiter_screen",
      expectedType: "update",
    },
    {
      name: "applied -> update",
      stageTarget: "applied",
      expectedTarget: "applied",
      expectedType: "update",
    },
    {
      name: "no_change -> other",
      stageTarget: "no_change",
      expectedTarget: "no_change",
      expectedType: "other",
    },
  ];

  it.each(labelToDecision)(
    "maps $name",
    async ({ stageTarget, expectedTarget, expectedType }) => {
      callJsonMock.mockResolvedValue(
        llmSuccess({ stageTarget, confidence: 92, bestMatchIndex: 1 }),
      );

      const result = await classifyWithSmartRouter({
        emailText: "Re: your application",
        activeJobs: ACTIVE_JOBS,
      });

      expect(result.stageTarget).toBe(expectedTarget);
      expect(result.messageType).toBe(expectedType);
      expect(result.confidence).toBe(92);
      expect(result.bestMatchId).toBe("job-1");
    },
  );

  it("treats a false-positive/noise email (not relevant) as 'other' with no match", async () => {
    callJsonMock.mockResolvedValue(
      llmSuccess({
        stageTarget: "no_change",
        isRelevant: false,
        confidence: 8,
        bestMatchIndex: null,
        reason: "Newsletter, not a recruiting email.",
      }),
    );

    const result = await classifyWithSmartRouter({
      emailText: "Weekly product newsletter",
      activeJobs: ACTIVE_JOBS,
    });

    expect(result.isRelevant).toBe(false);
    expect(result.stageTarget).toBe("no_change");
    expect(result.messageType).toBe("other");
    expect(result.bestMatchId).toBeNull();
    expect(result.confidence).toBe(8);
  });

  it("falls back to no_change/other for an unknown stageTarget label", async () => {
    callJsonMock.mockResolvedValue(
      llmSuccess({ stageTarget: "totally-made-up-label", confidence: 70 }),
    );

    const result = await classifyWithSmartRouter({
      emailText: "Some email",
      activeJobs: ACTIVE_JOBS,
    });

    expect(result.stageTarget).toBe("no_change");
    expect(result.messageType).toBe("other");
  });

  // Low confidence is preserved (not zeroed) — gating happens downstream, the
  // router must faithfully surface the score it was given.
  it("preserves a low-confidence score verbatim without changing the decision", async () => {
    callJsonMock.mockResolvedValue(
      llmSuccess({ stageTarget: "technical_interview", confidence: 11 }),
    );

    const result = await classifyWithSmartRouter({
      emailText: "Possibly an interview email",
      activeJobs: ACTIVE_JOBS,
    });

    expect(result.confidence).toBe(11);
    expect(result.stageTarget).toBe("technical_interview");
    expect(result.messageType).toBe("interview");
  });

  const confidenceCases: Array<{
    name: string;
    input: number | string;
    expected: number;
  }> = [
    { name: "clamps above 100", input: 150, expected: 100 },
    { name: "clamps below 0", input: -30, expected: 0 },
    { name: "rounds a float", input: 87.6, expected: 88 },
    { name: "non-numeric string -> 0", input: "high", expected: 0 },
    { name: "numeric string parsed", input: "73", expected: 73 },
  ];

  it.each(confidenceCases)(
    "confidence $name",
    async ({ input, expected }) => {
      callJsonMock.mockResolvedValue(
        llmSuccess({ confidence: input, stageTarget: "offer" }),
      );

      const result = await classifyWithSmartRouter({
        emailText: "email",
        activeJobs: ACTIVE_JOBS,
      });

      expect(result.confidence).toBe(expected);
    },
  );

  const matchCases: Array<{
    name: string;
    bestMatchIndex: number | string | null;
    activeJobs: MinifiedJob[];
    expectedId: string | null;
  }> = [
    { name: "index 1 -> first job", bestMatchIndex: 1, activeJobs: ACTIVE_JOBS, expectedId: "job-1" },
    { name: "index 2 -> second job", bestMatchIndex: 2, activeJobs: ACTIVE_JOBS, expectedId: "job-2" },
    { name: "index out of range -> null", bestMatchIndex: 3, activeJobs: ACTIVE_JOBS, expectedId: null },
    { name: "index 0 -> null", bestMatchIndex: 0, activeJobs: ACTIVE_JOBS, expectedId: null },
    { name: "null index -> null", bestMatchIndex: null, activeJobs: ACTIVE_JOBS, expectedId: null },
    { name: "numeric string index -> job", bestMatchIndex: "2", activeJobs: ACTIVE_JOBS, expectedId: "job-2" },
    { name: "any index with empty job list -> null", bestMatchIndex: 1, activeJobs: [], expectedId: null },
  ];

  it.each(matchCases)(
    "bestMatchId: $name",
    async ({ bestMatchIndex, activeJobs, expectedId }) => {
      callJsonMock.mockResolvedValue(
        llmSuccess({ bestMatchIndex, stageTarget: "rejected" }),
      );

      const result = await classifyWithSmartRouter({
        emailText: "email",
        activeJobs,
      });

      expect(result.bestMatchId).toBe(expectedId);
    },
  );

  it("keeps an object stageEventPayload but nulls a non-object payload", async () => {
    callJsonMock.mockResolvedValue(
      llmSuccess({ stageEventPayload: { round: "final", when: "next week" } }),
    );
    const withObject = await classifyWithSmartRouter({
      emailText: "email",
      activeJobs: ACTIVE_JOBS,
    });
    expect(withObject.stageEventPayload).toEqual({
      round: "final",
      when: "next week",
    });

    callJsonMock.mockResolvedValue(
      llmSuccess({
        // LLM violated the schema and returned a string; must be coerced to null.
        stageEventPayload: "not-an-object" as unknown as Record<
          string,
          unknown
        >,
      }),
    );
    const withString = await classifyWithSmartRouter({
      emailText: "email",
      activeJobs: ACTIVE_JOBS,
    });
    expect(withString.stageEventPayload).toBeNull();
  });

  it("trims the reason and tolerates a missing reason", async () => {
    callJsonMock.mockResolvedValue(
      llmSuccess({ reason: "   Moving to next round.   " }),
    );
    const trimmed = await classifyWithSmartRouter({
      emailText: "email",
      activeJobs: ACTIVE_JOBS,
    });
    expect(trimmed.reason).toBe("Moving to next round.");

    callJsonMock.mockResolvedValue({
      success: true as const,
      data: {
        bestMatchIndex: null,
        confidence: 50,
        stageTarget: "no_change",
        isRelevant: true,
        stageEventPayload: null,
        // reason intentionally omitted
      },
    });
    const missing = await classifyWithSmartRouter({
      emailText: "email",
      activeJobs: ACTIVE_JOBS,
    });
    expect(missing.reason).toBe("");
  });

  it("throws when the LLM call fails (no silent fallback)", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      error: "provider unavailable",
    });

    await expect(
      classifyWithSmartRouter({
        emailText: "email",
        activeJobs: ACTIVE_JOBS,
      }),
    ).rejects.toThrow(/LLM classification failed: provider unavailable/);
  });

  it("passes the resolved model and truncates the email at the char limit", async () => {
    callJsonMock.mockResolvedValue(llmSuccess({ stageTarget: "offer" }));

    const sentinel = "SENTINEL_TAIL";
    const emailText = "x".repeat(ROUTER_EMAIL_CHAR_LIMIT) + sentinel;

    await classifyWithSmartRouter({ emailText, activeJobs: ACTIVE_JOBS });

    expect(callJsonMock).toHaveBeenCalledTimes(1);
    const callArg = callJsonMock.mock.calls[0]?.[0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArg.model).toBe("test-model");
    const userContent = callArg.messages[1]?.content ?? "";
    // Truncated slice must NOT include the tail sentinel, but must include the body.
    expect(userContent).not.toContain(sentinel);
    expect(userContent).toContain("x".repeat(100));
    // Compact job list is embedded so the LLM can pick an index.
    expect(userContent).toContain("1. Test Corp: Backend Engineer");
    expect(userContent).toContain("2. Globex Test: Data Analyst");
  });
});

describe("normalizeBestMatchIndex", () => {
  const cases: Array<{
    name: string;
    value: unknown;
    max: number;
    expected: number | null;
  }> = [
    { name: "null -> null", value: null, max: 5, expected: null },
    { name: "undefined -> null", value: undefined, max: 5, expected: null },
    { name: "above max -> null", value: 3, max: 2, expected: null },
    { name: "below 1 -> null", value: 0, max: 5, expected: null },
    { name: "rounds down", value: 2.4, max: 5, expected: 2 },
    { name: "rounds up", value: 2.6, max: 5, expected: 3 },
    { name: "numeric string", value: "2", max: 5, expected: 2 },
    { name: "non-numeric string -> null", value: "abc", max: 5, expected: null },
    { name: "max <= 0 -> null", value: 1, max: 0, expected: null },
    { name: "NaN -> null", value: Number.NaN, max: 5, expected: null },
    { name: "valid top of range", value: 5, max: 5, expected: 5 },
  ];

  it.each(cases)("$name", ({ value, max, expected }) => {
    expect(normalizeBestMatchIndex(value, max)).toBe(expected);
  });
});

describe("buildIndexedActiveJobs / buildCompactActiveJobsList", () => {
  it("assigns 1-based indexes and normalizes whitespace", () => {
    const indexed = buildIndexedActiveJobs([
      { id: "a", company: "  Test    Corp ", title: "Backend  Engineer" },
      { id: "b", company: "Globex Test", title: "Data Analyst" },
    ]);

    expect(indexed).toEqual([
      { index: 1, id: "a", company: "Test Corp", title: "Backend Engineer" },
      { index: 2, id: "b", company: "Globex Test", title: "Data Analyst" },
    ]);
  });

  it("falls back to Unknown company/title for blank values", () => {
    const indexed = buildIndexedActiveJobs([
      { id: "a", company: "", title: "" },
    ]);

    expect(indexed[0]).toEqual({
      index: 1,
      id: "a",
      company: "Unknown company",
      title: "Unknown title",
    });
  });

  it("renders a compact one-line-per-job list", () => {
    const indexed = buildIndexedActiveJobs([
      { id: "a", company: "Test Corp", title: "Backend Engineer" },
      { id: "b", company: "Globex Test", title: "Data Analyst" },
    ]);

    expect(buildCompactActiveJobsList(indexed)).toBe(
      "1. Test Corp: Backend Engineer\n2. Globex Test: Data Analyst",
    );
  });

  it("produces an empty list string for no jobs", () => {
    expect(buildCompactActiveJobsList(buildIndexedActiveJobs([]))).toBe("");
  });
});

describe("minifyActiveJobs", () => {
  it("maps employer -> company and keeps id/title", () => {
    const jobs = [
      {
        id: "job-1",
        employer: "Test Corp",
        title: "Backend Engineer",
      },
      {
        id: "job-2",
        employer: "Globex Test",
        title: "Data Analyst",
      },
    ] as unknown as Job[];

    expect(minifyActiveJobs(jobs)).toEqual([
      { id: "job-1", company: "Test Corp", title: "Backend Engineer" },
      { id: "job-2", company: "Globex Test", title: "Data Analyst" },
    ]);
  });
});
