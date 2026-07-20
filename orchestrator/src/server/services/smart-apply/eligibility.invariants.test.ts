import { describe, expect, it } from "vitest";
import {
  evaluateSmartApplyEligibility,
  isSmartApplyEligible,
} from "./eligibility";
import type { JobApplicabilityContext } from "./types";

/**
 * Smart Apply SAFETY invariants.
 *
 * Smart Apply opens a *real headed browser* on the candidate's behalf, parses
 * an apply form, and pre-fills it from the design resume before handing the
 * page to the user over noVNC. Because a session drives a live browser, the
 * set of pages we are willing to open must stay intentionally tiny and the
 * URL matching must be strict — opening an attacker-controlled or unsupported
 * page would let us auto-type PII into a form we cannot reason about.
 *
 * The existing `eligibility.test.ts` pins the happy-path allowlist. This file
 * pins the *security-relevant* edges that keep the allowlist a hard gate:
 *   • the allowlist is CLOSED — tempting-but-unsupported ATSes are rejected;
 *   • the ATS URL regexes are ANCHORED — lookalike / spoofed / redirect-style
 *     hostnames that merely *contain* an ATS domain must NOT be admitted;
 *   • the returned applyUrl is trimmed (it is fed straight to Playwright nav);
 *   • applicationLink wins over jobUrl, and an explicit source wins over URL;
 *   • `isSmartApplyEligible` is always consistent with the full verdict.
 *
 * GAPS (documented, not faked — see the report notes):
 *   • `isSuccessUrl(url, ats)` in `session.ts` is module-private and is only
 *     reachable through the Playwright submit-watcher, so the per-ATS
 *     success-URL detection cannot be unit-tested without launching a browser.
 *   • The single-session guard (`active` in `session.ts`) likewise requires a
 *     live browser session to exercise; it is not tested here rather than
 *     faked with a stub browser.
 */

function ctx(
  job: Partial<JobApplicabilityContext["job"]>,
): JobApplicabilityContext {
  return {
    job: {
      id: job.id ?? "test-id",
      // `source` is cast because callers legitimately pass crawl sources
      // (linkedin/indeed/…) that are not part of the ATS union.
      source: (job.source ?? "manual") as JobApplicabilityContext["job"]["source"],
      applicationLink: job.applicationLink ?? null,
      jobUrl: job.jobUrl ?? "",
    },
  };
}

describe("Smart Apply eligibility — closed allowlist", () => {
  // Every ATS below is a real applicant-tracking system we do NOT have a
  // parser for. Admitting one would open a form we cannot safely fill.
  it.each([
    ["workday", "https://testcorp.wd1.myworkdayjobs.com/TestCorp/job/123"],
    ["taleo", "https://testcorp.taleo.net/careersection/2/jobapply.ftl?job=1"],
    [
      "smartrecruiters",
      "https://jobs.smartrecruiters.com/TestCorp/743-engineer",
    ],
    ["icims", "https://careers-testcorp.icims.com/jobs/123/apply"],
    ["bamboohr", "https://testcorp.bamboohr.com/careers/42"],
    ["workable", "https://apply.workable.com/testcorp/j/ABC123/"],
    ["jobvite", "https://jobs.jobvite.com/testcorp/job/oABC123"],
    ["recruitee", "https://testcorp.recruitee.com/o/engineer/apply"],
    ["manual", "https://testcorp.example.com/careers/123"],
  ])(
    "rejects unsupported ATS %s with an explicit reason",
    (source, url) => {
      const v = evaluateSmartApplyEligibility(
        ctx({ source: source as never, applicationLink: url }),
      );
      expect(v.eligible).toBe(false);
      if (!v.eligible) {
        expect(v.reason).toMatch(/not (yet )?supported/i);
        // The rejected source name must surface so the UI can explain it.
        expect(v.reason).toContain(source);
      }
    },
  );
});

describe("Smart Apply eligibility — ATS URL matching is anchored", () => {
  // These URLs *contain* an ATS domain but are not actually hosted on it.
  // The regexes are anchored at `^https?://<domain>/`, so none may pass.
  // Source is a non-ATS crawl source so the URL is the ONLY signal.
  it.each([
    // Subdomain-suffix spoof: real domain becomes a label of an attacker host.
    "https://boards.greenhouse.io.evil.example/testcorp/jobs/1",
    "https://jobs.ashbyhq.com.evil.example/testcorp/abc",
    "https://jobs.lever.co.evil.example/testcorp/abc",
    // Domain embedded in the path / query of an attacker host.
    "https://evil.example/boards.greenhouse.io/testcorp/jobs/1",
    "https://evil.example/?next=https://jobs.ashbyhq.com/testcorp/abc",
    // Bare / wrong subdomain — not the exact allowlisted host.
    "https://greenhouse.io/testcorp/jobs/1",
    "https://careers.greenhouse.io/testcorp/jobs/1",
    "https://sub.boards.greenhouse.io/testcorp/jobs/1",
    "https://ashbyhq.com/testcorp/abc",
    "https://lever.co/testcorp/abc",
  ])("rejects lookalike/spoofed URL %s", (url) => {
    const v = evaluateSmartApplyEligibility(
      ctx({ source: "linkedin", applicationLink: url }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/not (yet )?supported/i);
  });

  // The genuine, exactly-matching hosts must still pass on URL alone,
  // including http:// and mixed-case (the regexes carry the /i flag).
  it.each([
    ["greenhouse", "https://boards.greenhouse.io/testcorp/jobs/1"],
    ["greenhouse", "https://job-boards.greenhouse.io/testcorp/jobs/1"],
    ["greenhouse", "http://boards.greenhouse.io/testcorp/jobs/1"],
    ["greenhouse", "HTTPS://BOARDS.GREENHOUSE.IO/testcorp/jobs/1"],
    ["ashby", "https://jobs.ashbyhq.com/testcorp/abc"],
    ["ashby", "HTTPS://Jobs.AshbyHQ.com/testcorp/abc"],
    ["lever", "https://jobs.lever.co/testcorp/abc"],
    ["lever", "http://jobs.lever.co/testcorp/abc"],
  ])(
    "admits genuine %s host on URL alone (source disagrees)",
    (ats, url) => {
      const v = evaluateSmartApplyEligibility(
        ctx({ source: "linkedin", applicationLink: url }),
      );
      expect(v.eligible).toBe(true);
      if (v.eligible) expect(v.ats).toBe(ats);
    },
  );
});

describe("Smart Apply eligibility — applyUrl hygiene", () => {
  it("trims surrounding whitespace before it reaches the browser", () => {
    const raw = "  https://boards.greenhouse.io/testcorp/jobs/1  ";
    const v = evaluateSmartApplyEligibility(
      ctx({ source: "greenhouse", applicationLink: raw }),
    );
    expect(v.eligible).toBe(true);
    if (v.eligible) {
      expect(v.applyUrl).toBe("https://boards.greenhouse.io/testcorp/jobs/1");
      expect(v.applyUrl).toBe(v.applyUrl.trim());
    }
  });

  it("rejects when the only apply URL is whitespace", () => {
    const v = evaluateSmartApplyEligibility(
      ctx({ source: "greenhouse", applicationLink: "   ", jobUrl: "  " }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/no apply url/i);
  });

  it("rejects when no apply URL is present at all", () => {
    const v = evaluateSmartApplyEligibility(
      ctx({ source: "greenhouse", applicationLink: null, jobUrl: "" }),
    );
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/no apply url/i);
  });
});

describe("Smart Apply eligibility — resolution precedence", () => {
  it("prefers applicationLink over jobUrl for the apply target", () => {
    const v = evaluateSmartApplyEligibility(
      ctx({
        source: "linkedin",
        applicationLink: "https://jobs.ashbyhq.com/testcorp/primary",
        jobUrl: "https://boards.greenhouse.io/testcorp/jobs/999",
      }),
    );
    expect(v.eligible).toBe(true);
    if (v.eligible) {
      expect(v.applyUrl).toBe("https://jobs.ashbyhq.com/testcorp/primary");
      expect(v.ats).toBe("ashby");
    }
  });

  it("falls back to jobUrl only when applicationLink is empty", () => {
    const v = evaluateSmartApplyEligibility(
      ctx({
        source: "linkedin",
        applicationLink: null,
        jobUrl: "https://jobs.lever.co/testcorp/fallback",
      }),
    );
    expect(v.eligible).toBe(true);
    if (v.eligible) {
      expect(v.applyUrl).toBe("https://jobs.lever.co/testcorp/fallback");
      expect(v.ats).toBe("lever");
    }
  });

  it("lets an explicit ATS source win over a differing ATS URL", () => {
    // source=greenhouse is checked first, so it decides the ats even though
    // the URL points at an Ashby host.
    const v = evaluateSmartApplyEligibility(
      ctx({
        source: "greenhouse",
        applicationLink: "https://jobs.ashbyhq.com/testcorp/abc",
      }),
    );
    expect(v.eligible).toBe(true);
    if (v.eligible) expect(v.ats).toBe("greenhouse");
  });
});

describe("isSmartApplyEligible mirrors the full verdict", () => {
  const cases: Array<{ label: string; c: JobApplicabilityContext }> = [
    {
      label: "greenhouse by source",
      c: ctx({
        source: "greenhouse",
        applicationLink: "https://boards.greenhouse.io/testcorp/jobs/1",
      }),
    },
    {
      label: "ashby by url",
      c: ctx({
        source: "linkedin",
        applicationLink: "https://jobs.ashbyhq.com/testcorp/abc",
      }),
    },
    {
      label: "unsupported source",
      c: ctx({
        source: "workday",
        applicationLink: "https://testcorp.wd1.myworkdayjobs.com/x",
      }),
    },
    {
      label: "spoofed greenhouse host",
      c: ctx({
        source: "linkedin",
        applicationLink: "https://boards.greenhouse.io.evil.example/x",
      }),
    },
    { label: "no url", c: ctx({ source: "greenhouse" }) },
  ];

  it.each(cases)(
    "boolean helper equals verdict.eligible for $label",
    ({ c }) => {
      expect(isSmartApplyEligible(c)).toBe(
        evaluateSmartApplyEligibility(c).eligible,
      );
    },
  );
});
