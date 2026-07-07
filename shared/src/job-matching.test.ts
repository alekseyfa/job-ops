import { describe, expect, it } from "vitest";
import type { CreateJobInput } from "./types";
import {
  crossPostingFingerprint,
  dedupeCrossPostings,
  isDirectAtsPosting,
} from "./job-matching";

// Neutral fixture builder — generic backend role at a generic employer.
function job(overrides: Partial<CreateJobInput>): CreateJobInput {
  return {
    source: "linkedin",
    title: "Backend Engineer",
    employer: "Test Corp",
    jobUrl: "https://example.com/job",
    location: "Berlin",
    ...overrides,
  } as CreateJobInput;
}

describe("crossPostingFingerprint", () => {
  it("matches the same role across boards (case/whitespace/suffix-insensitive)", () => {
    const a = crossPostingFingerprint(job({ employer: "Test Corp Ltd" }));
    const b = crossPostingFingerprint(
      job({ title: "  backend   engineer ", employer: "TEST CORP" }),
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("distinguishes different roles", () => {
    const a = crossPostingFingerprint(job({ title: "Backend Engineer" }));
    const b = crossPostingFingerprint(job({ title: "Frontend Engineer" }));
    expect(a).not.toBe(b);
  });

  it("returns null when title or employer is missing", () => {
    expect(crossPostingFingerprint(job({ title: "" }))).toBeNull();
    expect(crossPostingFingerprint(job({ employer: "" }))).toBeNull();
  });
});

describe("isDirectAtsPosting", () => {
  it("recognizes a direct-ATS source", () => {
    expect(isDirectAtsPosting(job({ source: "greenhouse" } as Partial<CreateJobInput>))).toBe(true);
  });
  it("recognizes a direct-ATS URL even when the source is an aggregator", () => {
    expect(
      isDirectAtsPosting(
        job({ source: "linkedin", jobUrl: "https://boards.greenhouse.io/acme/jobs/1" }),
      ),
    ).toBe(true);
  });
  it("returns false for a plain aggregator posting", () => {
    expect(isDirectAtsPosting(job({ source: "linkedin", jobUrl: "https://linkedin.com/jobs/1" }))).toBe(false);
  });
});

describe("dedupeCrossPostings", () => {
  it("collapses cross-posts of one role, preferring the direct-ATS URL", () => {
    const inputs = [
      job({ source: "linkedin", jobUrl: "https://linkedin.com/jobs/1" }),
      job({ source: "indeed", jobUrl: "https://indeed.com/jobs/2" }),
      job({ source: "greenhouse", jobUrl: "https://boards.greenhouse.io/acme/jobs/3" }),
    ];
    const { canonical, duplicatesRemoved } = dedupeCrossPostings(inputs);
    expect(canonical).toHaveLength(1);
    expect(duplicatesRemoved).toBe(2);
    expect(canonical[0].source).toBe("greenhouse");
  });

  it("keeps distinct roles separate", () => {
    const inputs = [
      job({ title: "Backend Engineer", jobUrl: "https://a.com/1" }),
      job({ title: "Frontend Engineer", jobUrl: "https://a.com/2" }),
    ];
    const { canonical, duplicatesRemoved } = dedupeCrossPostings(inputs);
    expect(canonical).toHaveLength(2);
    expect(duplicatesRemoved).toBe(0);
  });

  it("passes through jobs that cannot be fingerprinted (no employer)", () => {
    const inputs = [
      job({ employer: "", jobUrl: "https://a.com/1" }),
      job({ employer: "", jobUrl: "https://a.com/2" }),
    ];
    const { canonical, duplicatesRemoved } = dedupeCrossPostings(inputs);
    expect(canonical).toHaveLength(2);
    expect(duplicatesRemoved).toBe(0);
  });

  it("falls back to the first posting when no direct-ATS URL is present", () => {
    const inputs = [
      job({ source: "linkedin", jobUrl: "https://linkedin.com/jobs/1" }),
      job({ source: "indeed", jobUrl: "https://indeed.com/jobs/2" }),
    ];
    const { canonical, duplicatesRemoved } = dedupeCrossPostings(inputs);
    expect(canonical).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    expect(canonical[0].source).toBe("linkedin");
  });
});
