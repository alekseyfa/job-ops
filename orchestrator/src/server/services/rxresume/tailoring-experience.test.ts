import { describe, expect, it } from "vitest";
import { buildProvenanceIndex } from "../tailoring-provenance";
import { applyTailoredExperience } from "./tailoring";

// Base resume the provenance index is built from.
const BASE_RESUME = {
  basics: { name: "Jane Doe", headline: "Backend Engineer" },
  sections: {
    skills: { items: [{ name: "Backend", keywords: ["Python", "Kubernetes", "APIs"] }] },
    experience: {
      items: [
        {
          company: "Acme Corp",
          position: "Backend Engineer",
          summary: "Built Python services on Kubernetes serving internal APIs.",
        },
      ],
    },
  },
};

function workingCopy() {
  return {
    sections: {
      experience: {
        items: [
          {
            company: "Acme Corp",
            position: "Backend Engineer",
            description: "<ul><li><p>Built Python services on Kubernetes.</p></li></ul>",
          },
        ],
      },
    },
  } as Record<string, unknown>;
}

describe("applyTailoredExperience", () => {
  const index = buildProvenanceIndex(BASE_RESUME);

  it("applies a provenance-safe rephrasing of an existing bullet", () => {
    const data = workingCopy();
    const diffs = applyTailoredExperience(
      data,
      [
        {
          company: "Acme Corp",
          position: "Backend Engineer",
          // Every token is supported by the base resume (python, kubernetes, apis).
          bullets: ["Built Python APIs on Kubernetes"],
        },
      ],
      index,
    );

    const item = (data.sections as any).experience.items[0];
    expect(item.description).toContain("Built Python APIs on Kubernetes");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].company).toBe("Acme Corp");
  });

  it("reverts a bullet that introduces an unsupported skill (no fabrication)", () => {
    const data = workingCopy();
    const original = (data.sections as any).experience.items[0].description;

    const diffs = applyTailoredExperience(
      data,
      [
        {
          company: "Acme Corp",
          position: "Backend Engineer",
          // "Rust" and "Terraform" are NOT in the base resume → bullet rejected.
          bullets: ["Led Rust migration with Terraform"],
        },
      ],
      index,
    );

    const item = (data.sections as any).experience.items[0];
    expect(item.description).toBe(original); // unchanged
    expect(diffs).toHaveLength(0);
  });

  it("does nothing when the entry doesn't match an existing experience item", () => {
    const data = workingCopy();
    const original = (data.sections as any).experience.items[0].description;
    const diffs = applyTailoredExperience(
      data,
      [{ company: "Other Co", position: "Frontend", bullets: ["Built Python things"] }],
      index,
    );
    expect((data.sections as any).experience.items[0].description).toBe(original);
    expect(diffs).toHaveLength(0);
  });

  it("returns an empty diff for null/empty tailored experience", () => {
    expect(applyTailoredExperience(workingCopy(), null, index)).toEqual([]);
    expect(applyTailoredExperience(workingCopy(), [], index)).toEqual([]);
  });
});
