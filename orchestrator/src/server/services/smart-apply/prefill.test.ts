import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSchema } from "./types";

/**
 * Prefill integration: proves the Apply Profile actually flows through the full
 * buildPrefilledForm chain and converts fields that used to be review-required
 * (LinkedIn, salary, notice period, sponsorship) into pre-filled ones — the
 * core "applying is too slow" win. Also pins the safety contract: resume basics
 * still win for name/email, and unknown fields still fall through to review.
 *
 * candidate-profile + settings are mocked so this stays a pure unit test with
 * no DB.
 */

vi.mock("../candidate-profile", () => ({
  getCandidateBasics: vi.fn(),
  getCandidateNameParts: vi.fn(),
}));
vi.mock("../settings", () => ({
  getEffectiveSettings: vi.fn(),
}));

function schema(fields: FormSchema["fields"]): FormSchema {
  return { ats: "greenhouse", applyUrl: "https://x", fields, hasCaptcha: false };
}

function f(over: Partial<FormSchema["fields"][number]>): FormSchema["fields"][number] {
  const label = over.label ?? "";
  return {
    selector: over.selector ?? `#${label.replace(/\s+/g, "_") || "f"}`,
    label,
    normalizedLabel:
      over.normalizedLabel ?? label.toLowerCase().replace(/[* ]+/g, " ").trim(),
    type: over.type ?? "text",
    required: over.required ?? false,
    options: over.options,
  };
}

const JOB = {
  id: "job-1",
  employer: "Acme",
  title: "Engineer",
  pdfPath: null,
  coverLetterPdfPath: null,
};

describe("buildPrefilledForm with answer profile", () => {
  let mod: typeof import("./prefill");
  let candidateProfile: typeof import("../candidate-profile");
  let settings: typeof import("../settings");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../candidate-profile", () => ({
      getCandidateBasics: vi.fn(async () => ({
        name: "Jane Doe",
        email: "jane@example.com",
        phone: "+10000000000",
        location: "Berlin",
        headline: "Backend engineer",
      })),
      getCandidateNameParts: vi.fn(async () => ({
        firstName: "Jane",
        lastName: "Doe",
        fullName: "Jane Doe",
      })),
    }));
    vi.doMock("../settings", () => ({
      getEffectiveSettings: vi.fn(async () => ({
        applyLinkedinUrl: { value: "https://linkedin.com/in/janedoe" },
        applyGithubUrl: { value: "https://github.com/janedoe" },
        applyPortfolioUrl: { value: null },
        applyNoticePeriod: { value: "1 month" },
        applyDesiredSalary: { value: "95000 EUR" },
        applyYearsExperience: { value: 7 },
        applyRequiresVisaSponsorship: { value: false },
        applyDeclineDemographics: { value: true },
      })),
    }));
    candidateProfile = await import("../candidate-profile");
    settings = await import("../settings");
    mod = await import("./prefill");
    void candidateProfile;
    void settings;
  });

  afterEach(() => {
    vi.doUnmock("../candidate-profile");
    vi.doUnmock("../settings");
  });

  it("fills profile-backed fields that used to require review", async () => {
    const form = await mod.buildPrefilledForm({
      schema: schema([
        f({ label: "LinkedIn Profile" }),
        f({ label: "Salary expectation" }),
        f({ label: "Notice period" }),
      ]),
      job: JOB,
    });

    const byLabel = Object.fromEntries(form.fields.map((x) => [x.label, x]));
    expect(byLabel["LinkedIn Profile"].filled).toBe(true);
    expect(byLabel["LinkedIn Profile"].value).toEqual({
      kind: "text",
      value: "https://linkedin.com/in/janedoe",
    });
    expect(byLabel["Salary expectation"].value).toEqual({
      kind: "text",
      value: "95000 EUR",
    });
    expect(byLabel["Notice period"].value).toEqual({
      kind: "text",
      value: "1 month",
    });
    // None of these should be flagged for review anymore.
    expect(form.reviewRequiredCount).toBe(0);
  });

  it("keeps resume basics winning for name/email", async () => {
    const form = await mod.buildPrefilledForm({
      schema: schema([
        f({ label: "First name", required: true }),
        f({ label: "Email", type: "email", required: true }),
      ]),
      job: JOB,
    });
    const byLabel = Object.fromEntries(form.fields.map((x) => [x.label, x]));
    expect(byLabel["First name"].value).toEqual({ kind: "text", value: "Jane" });
    expect(byLabel["Email"].value).toEqual({
      kind: "text",
      value: "jane@example.com",
    });
  });

  it("selects the sponsorship option from the profile", async () => {
    const form = await mod.buildPrefilledForm({
      schema: schema([
        f({
          label: "Will you require visa sponsorship?",
          type: "select",
          options: [
            { value: "y", label: "Yes" },
            { value: "n", label: "No" },
          ],
        }),
      ]),
      job: JOB,
    });
    expect(form.fields[0].value).toEqual({ kind: "choice", value: "n" });
    expect(form.fields[0].filled).toBe(true);
  });

  it("leaves unknown/unfilled fields for review", async () => {
    const form = await mod.buildPrefilledForm({
      schema: schema([
        f({ label: "Why do you want to work here?", type: "textarea", required: true }),
      ]),
      job: JOB,
    });
    expect(form.fields[0].filled).toBe(false);
    expect(form.fields[0].requiresReview).toBe(true);
    expect(form.reviewRequiredCount).toBe(1);
  });
});
