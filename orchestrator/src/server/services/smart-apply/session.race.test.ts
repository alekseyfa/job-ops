import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: the single-session guard was a TOCTOU race. The guard read
 * `active`, but `active` is only assigned ~10-30s later (after the browser
 * launches, the form is parsed and filled). Two starts firing inside that
 * window both passed `if (active)` and spawned two headed Firefox instances on
 * the shared :99 display, orphaning one (its teardown never fires because
 * teardown keys off `active.sessionId`).
 *
 * The fix adds a synchronous `reserving` flag set before the first await, so
 * the second concurrent start returns ALREADY_ACTIVE. This test drives two
 * starts where the first is parked at the (mocked) browser launch, and asserts
 * the second bails without creating a second session row.
 */

// A launch we can hold open to keep the first start "in flight".
let releaseLaunch: (() => void) | null = null;
const launchGate = () =>
  new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });

const createSmartApplySession = vi.fn();

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@infra/sanitize", () => ({ sanitizeUnknown: (x: unknown) => x }));
vi.mock("@server/tenancy/context", () => ({
  getActiveTenantId: () => "tenant_default",
}));
vi.mock("../applicationTracking", () => ({ transitionStage: vi.fn() }));
vi.mock("../challenge-viewer", () => ({
  buildChallengeViewerUrl: vi.fn(() => "https://viewer.example/x"),
  createChallengeViewerSession: vi.fn(() => ({ token: "tok" })),
  ensureChallengeViewer: vi.fn(async () => ({ available: true })),
}));
vi.mock("../../repositories/jobs", () => ({
  getJobById: vi.fn(async () => ({
    id: "job-1",
    title: "Engineer",
    employer: "Acme",
    source: "greenhouse",
    jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
  })),
  updateJob: vi.fn(),
}));
vi.mock("../../repositories/smart-apply-sessions", () => ({
  createSmartApplySession: (...args: unknown[]) => createSmartApplySession(...args),
  expireStaleSessions: vi.fn(async () => 0),
  getActiveSmartApplySession: vi.fn(async () => null),
  getSmartApplySessionById: vi.fn(async () => null),
  updateSmartApplySession: vi.fn(async () => null),
}));
vi.mock("./eligibility", () => ({
  evaluateSmartApplyEligibility: vi.fn(() => ({
    eligible: true,
    ats: "greenhouse",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
  })),
  isSmartApplyEligible: vi.fn(() => true),
}));
vi.mock("./parsers/ashby", () => ({ parseAshbyForm: vi.fn() }));
vi.mock("./parsers/greenhouse", () => ({ parseGreenhouseForm: vi.fn() }));
vi.mock("./prefill", () => ({ buildPrefilledForm: vi.fn() }));

// Park the browser launch so the first start stays "in flight" with the
// reservation held. The second start must not reach here.
vi.mock("playwright", () => ({
  firefox: {
    launch: vi.fn(async () => {
      await launchGate();
      throw new Error("launch aborted by test"); // fail cleanly once released
    }),
  },
}));

describe("startSmartApplySession — single-session reservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseLaunch = null;
    createSmartApplySession.mockImplementation(async () => ({
      id: "session-1",
      jobId: "job-1",
      status: "preparing",
      applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    }));
  });

  it("rejects a concurrent second start with ALREADY_ACTIVE while the first is preparing", async () => {
    const { startSmartApplySession } = await import("./session");

    // First start — resolves fast (background browser task is parked at launch).
    const first = await startSmartApplySession({ jobId: "job-1" });
    expect(first.ok).toBe(true);

    // Second start fires while the first's background task holds the reservation.
    const second = await startSmartApplySession({ jobId: "job-1" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("ALREADY_ACTIVE");
    }

    // Only ONE session row was ever created — the second never got past the guard.
    expect(createSmartApplySession).toHaveBeenCalledTimes(1);

    // Release the parked launch so the first task unwinds cleanly.
    releaseLaunch?.();
  });
});
