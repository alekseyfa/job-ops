import { describe, expect, it } from "vitest";
import {
  buildProvenanceIndex,
  filterInjectedKeywords,
  isSupported,
} from "./tailoring-provenance";

// Neutral fixture resume: a generic backend engineer. No production-user data.
const JANE_DOE_RESUME = {
  basics: { name: "Jane Doe", headline: "Backend Engineer" },
  sections: {
    skills: {
      items: [
        { name: "Backend", keywords: ["Python", "Kubernetes"] },
        { name: "Distributed Systems", keywords: ["distributed systems"] },
      ],
    },
    experience: {
      items: [
        { company: "Acme Corp", position: "Backend Engineer", summary: "Built Python services on Kubernetes." },
      ],
    },
  },
};

describe("buildProvenanceIndex", () => {
  it("captures resume tokens and multi-word skill phrases", () => {
    const index = buildProvenanceIndex(JANE_DOE_RESUME);
    expect(index.empty).toBe(false);
    expect(index.tokens.has("python")).toBe(true);
    expect(index.tokens.has("kubernetes")).toBe(true);
    expect(index.phrases.has("distributed systems")).toBe(true);
  });

  it("flags an empty resume so the guard can fall open", () => {
    expect(buildProvenanceIndex({}).empty).toBe(true);
    expect(buildProvenanceIndex(null).empty).toBe(true);
  });
});

describe("isSupported", () => {
  const index = buildProvenanceIndex(JANE_DOE_RESUME);

  it("accepts a directly-present skill", () => {
    expect(isSupported("Python", index)).toBe(true);
  });

  it("accepts a synonym of a present skill (K8s -> Kubernetes)", () => {
    expect(isSupported("K8s", index)).toBe(true);
  });

  it("rejects a fabricated skill absent from the resume", () => {
    expect(isSupported("Rust", index)).toBe(false);
    expect(isSupported("Go", index)).toBe(false);
  });

  it("accepts a multi-word phrase present verbatim", () => {
    expect(isSupported("distributed systems", index)).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isSupported("  pYThOn ", index)).toBe(true);
  });

  it("falls open (accepts everything) on an empty resume", () => {
    const empty = buildProvenanceIndex({});
    expect(isSupported("Rust", empty)).toBe(true);
  });
});

describe("filterInjectedKeywords", () => {
  it("keeps supported keywords and drops fabricated ones", () => {
    const index = buildProvenanceIndex(JANE_DOE_RESUME);
    const { kept, dropped } = filterInjectedKeywords(
      ["Python", "Rust", "K8s", "Go"],
      index,
    );
    expect(kept).toEqual(["Python", "K8s"]);
    expect(dropped).toEqual(["Rust", "Go"]);
  });

  it("keeps everything when the resume is empty (degraded, fail-open)", () => {
    const empty = buildProvenanceIndex({});
    const { kept, dropped } = filterInjectedKeywords(["Rust", "Go"], empty);
    expect(kept).toEqual(["Rust", "Go"]);
    expect(dropped).toEqual([]);
  });
});
