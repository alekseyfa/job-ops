import { describe, expect, it } from "vitest";
import { buildProvenanceIndex } from "../tailoring-provenance";
import { applyTailoredSkills } from "./tailoring";

// Minimal v5-style resume data with a skills section the tailorer rewrites.
function resumeWithSkills() {
  return {
    sections: {
      skills: {
        items: [
          { id: "s1", name: "Backend", keywords: ["Python", "Kubernetes"], level: 4 },
        ],
      },
    },
  } as Record<string, unknown>;
}

// Base resume the provenance index is built from (what the candidate actually has).
const BASE_RESUME = {
  basics: { name: "Jane Doe", headline: "Backend Engineer" },
  sections: {
    skills: { items: [{ name: "Backend", keywords: ["Python", "Kubernetes"] }] },
  },
};

describe("applyTailoredSkills provenance guard (WS1-T2 wiring)", () => {
  it("drops a fabricated keyword the base resume does not support", () => {
    const data = resumeWithSkills();
    const index = buildProvenanceIndex(BASE_RESUME);

    applyTailoredSkills(
      data,
      [{ name: "Backend", keywords: ["Python", "Rust", "K8s"] }],
      index,
    );

    const items = (data.sections as any).skills.items;
    // Rust is absent from the base resume → dropped. K8s ~ Kubernetes → kept.
    expect(items[0].keywords).toEqual(["Python", "K8s"]);
  });

  it("is backwards compatible: no index => keywords pass through unchanged", () => {
    const data = resumeWithSkills();
    applyTailoredSkills(data, [{ name: "Backend", keywords: ["Python", "Rust"] }]);
    const items = (data.sections as any).skills.items;
    expect(items[0].keywords).toEqual(["Python", "Rust"]);
  });

  it("falls open when the base resume is empty (degraded, keeps all)", () => {
    const data = resumeWithSkills();
    const emptyIndex = buildProvenanceIndex({});
    applyTailoredSkills(data, [{ name: "Backend", keywords: ["Rust", "Go"] }], emptyIndex);
    const items = (data.sections as any).skills.items;
    expect(items[0].keywords).toEqual(["Rust", "Go"]);
  });
});
