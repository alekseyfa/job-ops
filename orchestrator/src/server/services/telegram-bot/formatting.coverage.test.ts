import { createJob } from "@shared/testing/factories";
import type { TailoringReport } from "@shared/types";
import { describe, expect, it } from "vitest";
import { formatJobCard } from "./formatting";

const report = (over: Partial<TailoringReport> = {}): TailoringReport => ({
  coveragePct: 78,
  sectionsDetected: { experience: true, education: true, skills: true },
  missingKeywords: ["GraphQL", "gRPC"],
  generatedAt: "2026-06-18T00:00:00Z",
  ...over,
});

describe("formatJobCard — ATS coverage block (WS1-T7)", () => {
  it("renders coverage % and truthful keywords-to-add when a report exists", () => {
    const card = formatJobCard(createJob({ tailoringReport: report() }));
    expect(card).toContain("ATS coverage:");
    expect(card).toContain("78%");
    expect(card).toContain("GraphQL");
  });

  it("labels coverage as an estimate (not a real ATS score)", () => {
    const card = formatJobCard(createJob({ tailoringReport: report() }));
    expect(card.toLowerCase()).toContain("estimate");
  });

  it("renders no coverage block when the report is null", () => {
    const card = formatJobCard(createJob({ tailoringReport: null }));
    expect(card).not.toContain("ATS coverage:");
  });

  it("omits the keywords line when there are no missing keywords", () => {
    const card = formatJobCard(
      createJob({ tailoringReport: report({ missingKeywords: [] }) }),
    );
    expect(card).toContain("ATS coverage:");
    expect(card).not.toContain("Truthful keywords to add");
  });
});
