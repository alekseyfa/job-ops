import { beforeEach, describe, expect, it, vi } from "vitest";

const getUnscoredDiscoveredJobs = vi.fn();
const getAppliedDuplicateMatchCandidates = vi.fn();
const markJobsSkippedWithReason = vi.fn();
const getEffectiveSettings = vi.fn();

vi.mock("@server/repositories/jobs", () => ({
  getUnscoredDiscoveredJobs: () => getUnscoredDiscoveredJobs(),
  getAppliedDuplicateMatchCandidates: () => getAppliedDuplicateMatchCandidates(),
  markJobsSkippedWithReason: (ids: string[], reason: string) =>
    markJobsSkippedWithReason(ids, reason),
}));

vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: () => getEffectiveSettings(),
}));

import {
  APPLIED_DUPLICATE_SKIP_REASON,
  filterAppliedDuplicatesStep,
} from "./filter-applied-duplicates";

/**
 * The applied-duplicate filter auto-skips reposts of roles the user already
 * applied to. These tests pin the behaviour that matters for accuracy and for
 * the "don't waste user attention / LLM budget" goal:
 *   • a genuine repost (same title+employer, within the window) is skipped,
 *   • a different role at the same company is NOT skipped,
 *   • a re-listing outside the recency window is treated as a new opening,
 *   • the feature is a no-op when disabled or when there's no applied history,
 *   • settings drive the threshold + window (multi-tenant safe).
 */

// A discovered job (the potential repost). discoveredAt drives the window check.
function discovered(over: Record<string, unknown> = {}) {
  return {
    id: "disc-1",
    title: "Backend Engineer",
    employer: "Acme Labs",
    status: "discovered",
    appliedAt: null,
    discoveredAt: "2026-04-15T10:00:00.000Z",
    ...over,
  };
}

// An already-applied historical job (a match candidate).
function applied(over: Record<string, unknown> = {}) {
  return {
    id: "applied-1",
    title: "Backend Engineer",
    employer: "Acme Labs",
    status: "applied",
    appliedAt: "2026-04-01T10:00:00.000Z", // 14 days before discovery
    discoveredAt: "2026-03-30T10:00:00.000Z",
    ...over,
  };
}

function settings(over: Record<string, unknown> = {}) {
  return {
    skipAppliedDuplicates: { value: true },
    appliedDuplicateThreshold: { value: 90 },
    appliedDuplicateWindowDays: { value: 30 },
    ...over,
  };
}

describe("filterAppliedDuplicatesStep", () => {
  beforeEach(() => {
    getUnscoredDiscoveredJobs.mockReset();
    getAppliedDuplicateMatchCandidates.mockReset();
    markJobsSkippedWithReason.mockReset();
    getEffectiveSettings.mockReset();
    markJobsSkippedWithReason.mockImplementation(
      async (ids: string[]) => ids.length,
    );
    getEffectiveSettings.mockResolvedValue(settings());
  });

  it("skips a repost of an applied job within the window", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([discovered()]);
    getAppliedDuplicateMatchCandidates.mockResolvedValue([applied()]);

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(1);
    expect(markJobsSkippedWithReason).toHaveBeenCalledWith(
      ["disc-1"],
      APPLIED_DUPLICATE_SKIP_REASON,
    );
  });

  it("does NOT skip a different role at the same company", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([
      discovered({ id: "disc-2", title: "Staff Data Scientist" }),
    ]);
    getAppliedDuplicateMatchCandidates.mockResolvedValue([applied()]);

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(0);
    expect(markJobsSkippedWithReason).not.toHaveBeenCalled();
  });

  it("does NOT skip a re-listing outside the recency window", async () => {
    // Discovered 60 days after applying, default window is 30 days.
    getUnscoredDiscoveredJobs.mockResolvedValue([
      discovered({ discoveredAt: "2026-06-01T10:00:00.000Z" }),
    ]);
    getAppliedDuplicateMatchCandidates.mockResolvedValue([applied()]);

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(0);
  });

  it("honours a widened window from settings", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([
      discovered({ discoveredAt: "2026-06-01T10:00:00.000Z" }),
    ]);
    getAppliedDuplicateMatchCandidates.mockResolvedValue([applied()]);
    getEffectiveSettings.mockResolvedValue(
      settings({ appliedDuplicateWindowDays: { value: 90 } }),
    );

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(1);
  });

  it("is a no-op when disabled", async () => {
    getEffectiveSettings.mockResolvedValue(
      settings({ skipAppliedDuplicates: { value: false } }),
    );

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(0);
    expect(getUnscoredDiscoveredJobs).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no applied history", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([discovered()]);
    getAppliedDuplicateMatchCandidates.mockResolvedValue([]);

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(0);
    expect(markJobsSkippedWithReason).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no discovered jobs", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([]);

    const result = await filterAppliedDuplicatesStep();

    expect(result.markedCount).toBe(0);
    expect(getAppliedDuplicateMatchCandidates).not.toHaveBeenCalled();
  });
});
