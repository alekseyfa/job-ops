import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveScoringConcurrency, scoreJobsStep } from "./score-jobs";

vi.mock("@infra/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@server/repositories/jobs", () => ({
  getUnscoredDiscoveredJobs: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("@server/services/scorer", () => ({
  scoreJobSuitability: vi.fn(),
}));

vi.mock("@server/services/modelSelection", () => ({
  resolveLlmRuntimeSettings: vi.fn(),
}));

vi.mock("@server/services/ghost-job-detector", () => ({
  assessJobLegitimacy: vi.fn(() => ({
    tier: "green",
    score: 80,
    signals: [],
  })),
}));

vi.mock("@server/services/visa-sponsors/index", () => ({
  searchSponsors: vi.fn(),
  calculateSponsorMatchSummary: vi.fn(),
}));

vi.mock("../progress", () => ({
  updateProgress: vi.fn(),
  progressHelpers: {
    scoringJob: vi.fn(),
    scoringComplete: vi.fn(),
  },
}));

describe("scoreJobsStep auto-skip behavior", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const jobsRepo = await import("@server/repositories/jobs");
    const settingsRepo = await import("@server/repositories/settings");
    const scorer = await import("@server/services/scorer");
    const visaSponsors = await import("@server/services/visa-sponsors/index");
    const modelSelection = await import("@server/services/modelSelection");

    vi.mocked(modelSelection.resolveLlmRuntimeSettings).mockResolvedValue({
      provider: "openai",
      model: "gpt-4.1",
      baseUrl: null,
      apiKey: "sk-test",
    });

    vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
      createJob({
        title: "Software Engineer",
        employer: "Acme Corp",
        status: "discovered",
        suitabilityScore: null,
        suitabilityReason: null,
      }),
    ]);
    vi.mocked(jobsRepo.updateJob).mockResolvedValue(null);
    vi.mocked(settingsRepo.getSetting).mockResolvedValue(null);
    vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
      score: 40,
      reason: "Low fit",
    });
    vi.mocked(visaSponsors.searchSponsors).mockResolvedValue([]);
    vi.mocked(visaSponsors.calculateSponsorMatchSummary).mockReturnValue({
      sponsorMatchScore: 0,
      sponsorMatchNames: null,
    });
  });

  it("auto-skips jobs when score is below threshold", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    const jobsRepo = await import("@server/repositories/jobs");
    const { logger } = await import("@infra/logger");

    vi.mocked(settingsRepo.getSetting).mockResolvedValue("50");

    await scoreJobsStep({ profile: {} });

    expect(jobsRepo.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        suitabilityScore: 40,
        status: "skipped",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Auto-skipped job due to low score",
      expect.objectContaining({
        jobId: "job-1",
        score: 40,
        threshold: 50,
      }),
    );
  });

  it("does not auto-skip jobs when score equals threshold", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    const jobsRepo = await import("@server/repositories/jobs");
    const scorer = await import("@server/services/scorer");
    const { logger } = await import("@infra/logger");

    vi.mocked(settingsRepo.getSetting).mockResolvedValue("50");
    vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
      score: 50,
      reason: "At threshold",
    });

    await scoreJobsStep({ profile: {} });

    expect(jobsRepo.updateJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        suitabilityScore: 50,
      }),
    );
    const updatePayload = vi.mocked(jobsRepo.updateJob).mock.calls[0][1] as {
      status?: string;
    };
    expect(updatePayload).not.toHaveProperty("status");
    expect(logger.info).not.toHaveBeenCalledWith(
      "Auto-skipped job due to low score",
      expect.anything(),
    );
  });

  it("does not auto-skip when threshold setting is null", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    const jobsRepo = await import("@server/repositories/jobs");

    vi.mocked(settingsRepo.getSetting).mockResolvedValue(null);

    await scoreJobsStep({ profile: {} });

    const updatePayload = vi.mocked(jobsRepo.updateJob).mock.calls[0][1] as {
      status?: string;
    };
    expect(updatePayload).not.toHaveProperty("status");
  });

  it("does not auto-skip when threshold setting is NaN", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    const jobsRepo = await import("@server/repositories/jobs");

    vi.mocked(settingsRepo.getSetting).mockResolvedValue("not-a-number");

    await scoreJobsStep({ profile: {} });

    const updatePayload = vi.mocked(jobsRepo.updateJob).mock.calls[0][1] as {
      status?: string;
    };
    expect(updatePayload).not.toHaveProperty("status");
  });

  it("never auto-skips applied jobs even when score is below threshold", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    const jobsRepo = await import("@server/repositories/jobs");
    const { logger } = await import("@infra/logger");

    vi.mocked(settingsRepo.getSetting).mockResolvedValue("50");
    vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
      createJob({
        id: "job-applied",
        status: "applied",
        title: "Software Engineer",
        employer: "Acme Corp",
        suitabilityScore: null,
        suitabilityReason: null,
      }),
    ]);

    await scoreJobsStep({ profile: {} });

    expect(jobsRepo.updateJob).toHaveBeenCalledWith(
      "job-applied",
      expect.any(Object),
    );
    const updatePayload = vi.mocked(jobsRepo.updateJob).mock.calls[0][1] as {
      status?: string;
    };
    expect(updatePayload).not.toHaveProperty("status");
    expect(logger.info).not.toHaveBeenCalledWith(
      "Auto-skipped job due to low score",
      expect.objectContaining({ jobId: "job-applied" }),
    );
  });

  it("scores multiple jobs and reports completion progress", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const scorer = await import("@server/services/scorer");
    const { progressHelpers } = await import("../progress");

    vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
      createJob({
        id: "job-1",
        title: "First Role",
        employer: "Acme",
        suitabilityScore: null,
      }),
      createJob({
        id: "job-2",
        title: "Second Role",
        employer: "Beta",
        suitabilityScore: null,
      }),
    ]);

    vi.mocked(scorer.scoreJobSuitability)
      .mockResolvedValueOnce({ score: 61, reason: "First score" })
      .mockResolvedValueOnce({ score: 72, reason: "Second score" });

    const result = await scoreJobsStep({ profile: {} });

    expect(result.scoredJobs).toHaveLength(2);
    expect(vi.mocked(jobsRepo.updateJob)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(progressHelpers.scoringJob)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(progressHelpers.scoringComplete)).toHaveBeenCalledWith(2);
  });

  it("stops before processing when cancellation is requested", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const scorer = await import("@server/services/scorer");

    vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue([
      createJob({
        id: "job-1",
        title: "Cancelled Role",
        employer: "Acme",
        suitabilityScore: null,
      }),
    ]);

    const result = await scoreJobsStep({
      profile: {},
      shouldCancel: () => true,
    });

    expect(result.scoredJobs).toHaveLength(0);
    expect(vi.mocked(scorer.scoreJobSuitability)).not.toHaveBeenCalled();
    expect(vi.mocked(jobsRepo.updateJob)).not.toHaveBeenCalled();
  });

  describe("one bad job does not abort the batch", () => {
    const twoJobs = () => [
      createJob({
        id: "job-bad",
        title: "Bad Role",
        employer: "Acme",
        suitabilityScore: null,
        suitabilityReason: null,
      }),
      createJob({
        id: "job-good",
        title: "Good Role",
        employer: "Beta",
        suitabilityScore: null,
        suitabilityReason: null,
      }),
    ];

    it("keeps scoring when one job's sponsor lookup throws (enrichment degrades to 0)", async () => {
      const jobsRepo = await import("@server/repositories/jobs");
      const scorer = await import("@server/services/scorer");
      const visaSponsors = await import("@server/services/visa-sponsors/index");

      vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue(twoJobs());
      vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
        score: 70,
        reason: "ok",
      });
      // First job's employer lookup throws; second succeeds.
      vi.mocked(visaSponsors.searchSponsors)
        .mockRejectedValueOnce(new Error("sponsor index not loaded"))
        .mockResolvedValueOnce([]);

      const result = await scoreJobsStep({ profile: {} });

      // Both jobs still scored + persisted — the throw did not abort the run.
      expect(result.scoredJobs).toHaveLength(2);
      expect(vi.mocked(jobsRepo.updateJob)).toHaveBeenCalledTimes(2);
      // The job whose sponsor lookup failed still gets a sponsorMatchScore of 0.
      expect(vi.mocked(jobsRepo.updateJob)).toHaveBeenCalledWith(
        "job-bad",
        expect.objectContaining({ suitabilityScore: 70, sponsorMatchScore: 0 }),
      );
    });

    it("skips only the job whose persist fails and still scores the rest", async () => {
      const jobsRepo = await import("@server/repositories/jobs");
      const scorer = await import("@server/services/scorer");

      vi.mocked(jobsRepo.getUnscoredDiscoveredJobs).mockResolvedValue(twoJobs());
      vi.mocked(scorer.scoreJobSuitability).mockResolvedValue({
        score: 70,
        reason: "ok",
      });
      // The first persist throws (e.g. transient DB error), the second succeeds.
      vi.mocked(jobsRepo.updateJob)
        .mockRejectedValueOnce(new Error("db write failed"))
        .mockResolvedValue(null);

      // Must not throw — the batch survives the single failed write.
      const result = await scoreJobsStep({ profile: {} });

      expect(vi.mocked(jobsRepo.updateJob)).toHaveBeenCalledTimes(2);
      // Only the job that persisted successfully is counted as scored.
      expect(result.scoredJobs).toHaveLength(1);
      expect(result.scoredJobs[0].id).toBe("job-good");
    });
  });
});

describe("resolveScoringConcurrency", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("drops to 1 for local single-instance providers (lmstudio, ollama)", async () => {
    const modelSelection = await import("@server/services/modelSelection");

    for (const provider of ["lmstudio", "ollama"]) {
      vi.mocked(modelSelection.resolveLlmRuntimeSettings).mockResolvedValue({
        provider,
        model: "local-model",
        baseUrl: "http://localhost:1234",
        apiKey: null,
      });
      expect(await resolveScoringConcurrency()).toBe(1);
    }
  });

  it("stays at 8 for cloud providers", async () => {
    const modelSelection = await import("@server/services/modelSelection");

    vi.mocked(modelSelection.resolveLlmRuntimeSettings).mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      apiKey: "sk-ant-test",
    });
    expect(await resolveScoringConcurrency()).toBe(8);
  });
});
