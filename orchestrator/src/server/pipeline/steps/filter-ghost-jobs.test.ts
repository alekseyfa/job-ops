import { beforeEach, describe, expect, it, vi } from "vitest";

const getUnscoredDiscoveredJobs = vi.fn();
const markJobsSkippedWithReason = vi.fn();

vi.mock("@server/repositories/jobs", () => ({
  getUnscoredDiscoveredJobs: () => getUnscoredDiscoveredJobs(),
  markJobsSkippedWithReason: (ids: string[], reason: string) =>
    markJobsSkippedWithReason(ids, reason),
}));

import { filterGhostJobsStep, GHOST_JOB_SKIP_REASON } from "./filter-ghost-jobs";

// A neutral job that the ghost-job heuristic rates "red": no description AND a
// deadline already in the past. assessJobLegitimacy starts at 80, subtracts 25
// for the empty description, 25 for the passed deadline, and 3 for the missing
// company URL (~27), landing below the red threshold (<40).
function ghostJob(id: string) {
  return {
    id,
    title: "Backend Engineer",
    employer: "Test Corp",
    jobDescription: "",
    datePosted: null,
    deadline: "2020-01-01",
  };
}

// A healthy job with a substantive description and strong trust signals.
function healthyJob(id: string) {
  return {
    id,
    title: "Backend Engineer",
    employer: "Test Corp",
    jobDescription:
      "We are hiring a backend engineer. You will report to the hiring manager. " +
      "Our stack uses Python and Kubernetes. The interview process has three stages. " +
      "You will work with a small platform team building distributed systems and " +
      "internal APIs used across the company every single day to ship product.",
    datePosted: "2026-06-01",
    deadline: null,
  };
}

describe("filterGhostJobsStep", () => {
  beforeEach(() => {
    getUnscoredDiscoveredJobs.mockReset();
    markJobsSkippedWithReason.mockReset();
    markJobsSkippedWithReason.mockImplementation(async (ids: string[]) => ids.length);
  });

  it("skips only red-tier (likely ghost) jobs, leaving healthy ones", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([
      ghostJob("ghost-1"),
      healthyJob("healthy-1"),
      ghostJob("ghost-2"),
    ]);

    const { markedCount } = await filterGhostJobsStep();

    expect(markedCount).toBe(2);
    expect(markJobsSkippedWithReason).toHaveBeenCalledWith(
      ["ghost-1", "ghost-2"],
      GHOST_JOB_SKIP_REASON,
    );
  });

  it("marks nothing when there are no discovered jobs", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([]);
    const { markedCount } = await filterGhostJobsStep();
    expect(markedCount).toBe(0);
    expect(markJobsSkippedWithReason).not.toHaveBeenCalled();
  });

  it("marks nothing when every discovered job is healthy", async () => {
    getUnscoredDiscoveredJobs.mockResolvedValue([
      healthyJob("healthy-1"),
      healthyJob("healthy-2"),
    ]);
    const { markedCount } = await filterGhostJobsStep();
    expect(markedCount).toBe(0);
    expect(markJobsSkippedWithReason).not.toHaveBeenCalled();
  });
});
