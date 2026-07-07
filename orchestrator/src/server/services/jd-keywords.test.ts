import { describe, expect, it } from "vitest";
import type { JobMatchAnalysis } from "@shared/types";
import { extractWeightedJdKeywords } from "./jd-keywords";

// Neutral fixture: a generic backend role. No production-user data.
const BACKEND_JD =
  "Senior Backend Engineer. You must have strong Python and Kubernetes " +
  "experience. AWS is a plus. Bachelor's degree in Computer Science required.";

function analysis(partial: Partial<JobMatchAnalysis>): JobMatchAnalysis {
  return {
    requirements: { met: [], missing: [], partial: [] },
    skills: { matched: [], missing: [], transferable: [], bonus: [] },
    experience: { levelMatch: "unknown", yearsRequired: null, yearsApparent: null },
    keywords: { addToResume: [] },
    dealBreakers: [],
    tailoringTips: [],
    ...partial,
  };
}

describe("extractWeightedJdKeywords", () => {
  it("prefers matchAnalysis signal and tags hard skills with weight 3", () => {
    const kws = extractWeightedJdKeywords(
      BACKEND_JD,
      analysis({ skills: { matched: [], missing: ["Python", "Kubernetes"], transferable: [], bonus: [] } }),
    );
    const python = kws.find((k) => k.term === "python");
    expect(python).toBeDefined();
    expect(python?.class).toBe("hard");
    expect(python?.weight).toBe(3);
  });

  it("tags bonus skills as soft (nice-to-have) with weight 1", () => {
    const kws = extractWeightedJdKeywords(
      BACKEND_JD,
      analysis({ skills: { matched: [], missing: [], transferable: [], bonus: ["AWS"] } }),
    );
    const aws = kws.find((k) => k.term === "aws");
    expect(aws?.class).toBe("soft");
    expect(aws?.weight).toBe(1);
  });

  it("detects an education requirement from the JD text", () => {
    const kws = extractWeightedJdKeywords(BACKEND_JD, analysis({}));
    expect(kws.some((k) => k.class === "education")).toBe(true);
  });

  it("treats verbatim addToResume phrases as title-class (highest signal)", () => {
    const kws = extractWeightedJdKeywords(
      BACKEND_JD,
      analysis({ keywords: { addToResume: ["distributed systems"] } }),
    );
    const term = kws.find((k) => k.term === "distributed systems");
    expect(term?.class).toBe("title");
    expect(term?.weight).toBe(3);
  });

  it("dedupes case-insensitively, keeping the highest-priority class", () => {
    const kws = extractWeightedJdKeywords(
      BACKEND_JD,
      analysis({
        skills: { matched: ["Python"], missing: [], transferable: ["python"], bonus: [] },
      }),
    );
    const pythonEntries = kws.filter((k) => k.term === "python");
    expect(pythonEntries).toHaveLength(1);
    // matched => hard outranks transferable => soft
    expect(pythonEntries[0].class).toBe("hard");
  });

  it("returns [] for an empty JD with no analysis", () => {
    expect(extractWeightedJdKeywords("")).toEqual([]);
  });

  it("falls back to JD tokenization (other-class) when no analysis is given", () => {
    const kws = extractWeightedJdKeywords("Backend engineer with GraphQL skills");
    expect(kws.length).toBeGreaterThan(0);
    expect(kws.every((k) => k.class === "other" || k.class === "education")).toBe(true);
    // stopwords filtered out
    expect(kws.some((k) => k.term === "with")).toBe(false);
  });
});
