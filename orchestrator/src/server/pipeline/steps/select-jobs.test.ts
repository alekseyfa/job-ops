import type { PipelineConfig } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { selectJobsStep } from "./select-jobs";

vi.mock("@server/repositories/settings", () => ({
  getAllSettings: vi.fn().mockResolvedValue({}),
}));

const baseConfig: PipelineConfig = {
  topN: 2,
  minSuitabilityScore: 50,
  sources: ["gradcracker"],
  outputDir: "./tmp",
  enableCrawling: true,
  enableScoring: true,
  enableImporting: true,
  enableAutoTailoring: true,
};

describe("selectJobsStep", () => {
  it("filters by min score, sorts descending, and limits topN", async () => {
    const jobs = [
      { id: "a", suitabilityScore: 90, suitabilityReason: "high" },
      { id: "b", suitabilityScore: 45, suitabilityReason: "low" },
      { id: "c", suitabilityScore: 80, suitabilityReason: "med" },
      { id: "d", suitabilityScore: 70, suitabilityReason: "ok" },
    ] as any;

    const selected = await selectJobsStep({
      scoredJobs: jobs,
      mergedConfig: baseConfig,
    });

    expect(selected.map((job) => job.id)).toEqual(["a", "c"]);
  });

  it("breaks score ties toward selected locations when requested", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      locationSearchScope: "remote_worldwide_prioritize_selected",
      jobspyCountryIndeed: "croatia",
      searchCities: "Zagreb",
    } as any);

    const jobs = [
      {
        id: "remote-anywhere",
        suitabilityScore: 80,
        suitabilityReason: "tie",
        location: "Remote - Worldwide",
      },
      {
        id: "zagreb",
        suitabilityScore: 80,
        suitabilityReason: "tie",
        location: null,
        locationEvidence: {
          location: "Zagreb, Croatia",
          country: "croatia",
        },
      },
    ] as any;

    const selected = await selectJobsStep({
      scoredJobs: jobs,
      mergedConfig: { ...baseConfig, topN: 1 },
    });

    expect(selected.map((job) => job.id)).toEqual(["zagreb"]);
  });

  // WS2-T3: selectionMode='rank' bypasses the hard score cutoff so calibration
  // drift can't empty the list — it returns the top-N by rank regardless.
  it("returns top-N by rank when selectionMode is 'rank' (ignores the cutoff)", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({
      selectionMode: "rank",
    } as any);

    // All jobs are BELOW the minSuitabilityScore (50) — under 'threshold' the
    // result would be empty; under 'rank' we still get the best two.
    const jobs = [
      { id: "a", suitabilityScore: 40, suitabilityReason: "best" },
      { id: "b", suitabilityScore: 20, suitabilityReason: "mid" },
      { id: "c", suitabilityScore: 10, suitabilityReason: "low" },
      { id: "unscored", suitabilityScore: null, suitabilityReason: null },
    ] as any;

    const selected = await selectJobsStep({
      scoredJobs: jobs,
      mergedConfig: baseConfig, // topN: 2, minSuitabilityScore: 50
    });

    expect(selected.map((job) => job.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for the same below-cutoff jobs under default 'threshold' mode", async () => {
    const settingsRepo = await import("@server/repositories/settings");
    vi.mocked(settingsRepo.getAllSettings).mockResolvedValue({} as any);

    const jobs = [
      { id: "a", suitabilityScore: 40, suitabilityReason: "best" },
      { id: "b", suitabilityScore: 20, suitabilityReason: "mid" },
    ] as any;

    const selected = await selectJobsStep({ scoredJobs: jobs, mergedConfig: baseConfig });
    expect(selected).toEqual([]);
  });
});
