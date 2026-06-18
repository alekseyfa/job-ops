import { describe, expect, it } from "vitest";
import { computeAtsCoverage } from "./ats-coverage";
import type { WeightedJdKeyword } from "./jd-keywords";
import { buildProvenanceIndex } from "./tailoring-provenance";

const KW = (term: string, weight: number): WeightedJdKeyword => ({
  term,
  class: weight >= 3 ? "hard" : "soft",
  weight,
});

describe("computeAtsCoverage", () => {
  it("computes weight-weighted coverage of keywords present in the text", () => {
    // Python (3) present, Rust (3) absent => 3/6 = 50%.
    const report = computeAtsCoverage("Experienced in Python and Kubernetes.", [
      KW("Python", 3),
      KW("Rust", 3),
    ]);
    expect(report.coveragePct).toBe(50);
  });

  it("weights hard skills above soft ones", () => {
    // hard Python (3) present, soft AWS (1) absent => 3/4 = 75%.
    const report = computeAtsCoverage("Python developer.", [
      KW("Python", 3),
      KW("AWS", 1),
    ]);
    expect(report.coveragePct).toBe(75);
  });

  it("detects standard section headers", () => {
    const text = "EXPERIENCE\nAcme Corp\nSKILLS\nPython\nEDUCATION\nBSc";
    const report = computeAtsCoverage(text, []);
    expect(report.sectionsDetected).toEqual({
      experience: true,
      education: true,
      skills: true,
    });
  });

  it("flags a missing section (single-column regression catch)", () => {
    const report = computeAtsCoverage("EXPERIENCE only here", []);
    expect(report.sectionsDetected.skills).toBe(false);
  });

  it("only lists missing keywords the resume can truthfully support", () => {
    const index = buildProvenanceIndex({
      sections: { skills: { items: [{ name: "Backend", keywords: ["GraphQL"] }] } },
    });
    // Neither present in the rendered text; GraphQL is in the resume (suggest it),
    // Rust is not (never suggest fabricating it).
    const report = computeAtsCoverage(
      "Plain resume text with no keywords.",
      [KW("GraphQL", 3), KW("Rust", 3)],
      index,
    );
    expect(report.missingKeywords).toContain("GraphQL");
    expect(report.missingKeywords).not.toContain("Rust");
  });

  it("returns 0% coverage for an empty keyword set without dividing by zero", () => {
    const report = computeAtsCoverage("anything", []);
    expect(report.coveragePct).toBe(0);
  });
});
