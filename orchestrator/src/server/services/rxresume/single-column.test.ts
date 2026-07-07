import { describe, expect, it } from "vitest";
import { collapseToSingleColumn } from "./single-column";

function twoColumnDoc() {
  return {
    metadata: {
      layout: {
        sidebarWidth: 35,
        pages: [
          {
            fullWidth: false,
            main: ["profiles", "summary", "experience"],
            sidebar: ["skills", "languages"],
          },
        ],
      },
    },
  } as Record<string, unknown>;
}

describe("collapseToSingleColumn", () => {
  it("merges sidebar into main, clears sidebar, sets fullWidth", () => {
    const doc = twoColumnDoc();
    collapseToSingleColumn(doc);

    const page = (doc.metadata as any).layout.pages[0];
    expect(page.main).toEqual([
      "profiles",
      "summary",
      "experience",
      "skills",
      "languages",
    ]);
    expect(page.sidebar).toEqual([]);
    expect(page.fullWidth).toBe(true);
  });

  it("is idempotent (a second call is a no-op)", () => {
    const doc = twoColumnDoc();
    collapseToSingleColumn(doc);
    const afterFirst = JSON.parse(JSON.stringify((doc.metadata as any).layout.pages[0]));
    collapseToSingleColumn(doc);
    expect((doc.metadata as any).layout.pages[0]).toEqual(afterFirst);
  });

  it("dedups a section already present in main", () => {
    const doc = {
      metadata: {
        layout: {
          pages: [{ fullWidth: false, main: ["summary", "skills"], sidebar: ["skills", "awards"] }],
        },
      },
    } as Record<string, unknown>;
    collapseToSingleColumn(doc);
    const page = (doc.metadata as any).layout.pages[0];
    expect(page.main).toEqual(["summary", "skills", "awards"]);
  });

  it("tolerates a malformed/absent layout without throwing", () => {
    expect(() => collapseToSingleColumn({})).not.toThrow();
    expect(() => collapseToSingleColumn({ metadata: {} })).not.toThrow();
    expect(() =>
      collapseToSingleColumn({ metadata: { layout: { pages: "nope" } } }),
    ).not.toThrow();
  });
});
