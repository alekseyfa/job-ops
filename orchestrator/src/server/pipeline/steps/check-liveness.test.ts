import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLivenessStep } from "./check-liveness";

vi.mock("@infra/logger", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock("@server/repositories/jobs", () => ({
  getAllJobs: vi.fn(),
  updateJob: vi.fn(),
}));

/**
 * Data-safety contract for the liveness step:
 *
 *   • A DEFINITIVE dead signal (HTTP 404/410, or an explicit "position closed"
 *     phrase in the body) expires a job of ANY status.
 *   • A HEURISTIC signal only (a thin <300-char body, or a "N jobs found"
 *     listing shell) expires ONLY `discovered` jobs. A curated `ready` job —
 *     which already has a tailored PDF and is later HARD-DELETED once expired —
 *     must survive a weak guess, because SPA/JS boards and transient soft-404s
 *     routinely serve a 200 with a thin/listing body.
 *
 * The regression this pins: liveness silently demoting a `ready` job to
 * `expired` on the length/listing heuristic, destroying user work.
 */
describe("checkLivenessStep — ready-job protection", () => {
  let jobsRepo: typeof import("@server/repositories/jobs");

  const mockFetch = (opts: { status?: number; ok?: boolean; body?: string }) => {
    global.fetch = vi.fn().mockResolvedValue({
      status: opts.status ?? 200,
      ok: opts.ok ?? true,
      text: async () => opts.body ?? "",
    } as unknown as Response);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    jobsRepo = await import("@server/repositories/jobs");
    vi.mocked(jobsRepo.updateJob).mockResolvedValue(null as never);
  });

  const readyJob = () =>
    createJob({
      id: "ready-1",
      source: "workingnomads",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/ready-1",
      status: "ready",
    });

  const discoveredJob = () =>
    createJob({
      id: "disc-1",
      source: "workingnomads",
      title: "Senior Engineer",
      employer: "Acme",
      jobUrl: "https://example.com/jobs/disc-1",
      status: "discovered",
    });

  it("does NOT expire a ready job on a thin-body heuristic", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([readyJob()]);
    mockFetch({ status: 200, ok: true, body: "tiny" }); // < 300 chars

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(0);
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("does NOT expire a ready job on a 'N jobs found' listing shell", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([readyJob()]);
    mockFetch({
      status: 200,
      ok: true,
      body: `<html><body>${"x".repeat(400)} 27 jobs found ${"y".repeat(400)}</body></html>`,
    });

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(0);
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });

  it("DOES expire a ready job on a definitive HTTP 404", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([readyJob()]);
    mockFetch({ status: 404, ok: false });

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(1);
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("ready-1", {
      status: "expired",
    });
  });

  it("DOES expire a ready job on an explicit 'position has been filled' phrase", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([readyJob()]);
    mockFetch({
      status: 200,
      ok: true,
      body: `<html><body>${"x".repeat(400)} This position has been filled. ${"y".repeat(400)}</body></html>`,
    });

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(1);
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("ready-1", {
      status: "expired",
    });
  });

  it("DOES expire a discovered job on the same thin-body heuristic (unchanged behavior)", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([discoveredJob()]);
    mockFetch({ status: 200, ok: true, body: "tiny" });

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(1);
    expect(jobsRepo.updateJob).toHaveBeenCalledWith("disc-1", {
      status: "expired",
    });
  });

  it("keeps a healthy ready job alive", async () => {
    vi.mocked(jobsRepo.getAllJobs).mockResolvedValue([readyJob()]);
    mockFetch({
      status: 200,
      ok: true,
      body: `<html><body>${"realistic job description ".repeat(50)}</body></html>`,
    });

    const result = await checkLivenessStep({});

    expect(result.expired).toBe(0);
    expect(jobsRepo.updateJob).not.toHaveBeenCalled();
  });
});
