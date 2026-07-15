import { describe, expect, it } from "vitest";
import {
  buildAnswerProfileFromSettings,
  isDemographicField,
  pickDeclineOption,
  pickYesNoOption,
  resolveProfileField,
  resolveSponsorshipAnswer,
  type AnswerProfile,
} from "./answer-profile";
import type { FormField } from "./types";

/**
 * The answer profile is the single biggest apply-speed lever: it stops the user
 * re-typing the same non-resume answers (links, notice period, salary, years,
 * sponsorship) on every application. These tests pin the tricky correctness
 * paths that a type-check can't catch:
 *   • sponsorship polarity — "require sponsorship?" vs "authorized WITHOUT
 *     sponsorship?" must produce opposite booleans for the same profile,
 *   • work-authorization is NEVER auto-answered (worldwide search → country
 *     dependent → legal-misrepresentation risk),
 *   • demographic questions default to "decline to self-identify" only when the
 *     option actually exists,
 *   • multi-tenant neutrality — a different user's settings drive different
 *     answers with no code change, and empty settings answer nothing.
 */

function field(over: Partial<FormField>): FormField {
  const label = over.label ?? "";
  return {
    selector: over.selector ?? "#f",
    label,
    normalizedLabel:
      over.normalizedLabel ?? label.toLowerCase().replace(/[* ]+/g, " ").trim(),
    type: over.type ?? "text",
    required: over.required ?? false,
    options: over.options,
    accept: over.accept,
    hint: over.hint,
  };
}

const FULL_PROFILE: AnswerProfile = {
  linkedinUrl: "https://linkedin.com/in/janedoe",
  githubUrl: "https://github.com/janedoe",
  portfolioUrl: "https://janedoe.dev",
  noticePeriod: "2 months",
  desiredSalary: "90000 EUR",
  yearsExperience: 8,
  requiresVisaSponsorship: false,
  declineDemographics: true,
};

describe("buildAnswerProfileFromSettings", () => {
  it("reads all fields from the settings shape", () => {
    const p = buildAnswerProfileFromSettings({
      applyLinkedinUrl: { value: "https://linkedin.com/in/x" },
      applyGithubUrl: { value: "https://github.com/x" },
      applyPortfolioUrl: { value: "https://x.dev" },
      applyNoticePeriod: { value: "1 month" },
      applyDesiredSalary: { value: "$120k" },
      applyYearsExperience: { value: 5 },
      applyRequiresVisaSponsorship: { value: true },
      applyDeclineDemographics: { value: false },
    });
    expect(p).toEqual({
      linkedinUrl: "https://linkedin.com/in/x",
      githubUrl: "https://github.com/x",
      portfolioUrl: "https://x.dev",
      noticePeriod: "1 month",
      desiredSalary: "$120k",
      yearsExperience: 5,
      requiresVisaSponsorship: true,
      declineDemographics: false,
    });
  });

  it("falls back to neutral values when settings are empty (multi-tenant safe)", () => {
    const p = buildAnswerProfileFromSettings({});
    expect(p.linkedinUrl).toBeNull();
    expect(p.yearsExperience).toBeNull();
    expect(p.requiresVisaSponsorship).toBeNull();
    // Absent demographic setting => decline is the safe default.
    expect(p.declineDemographics).toBe(true);
  });

  it("coerces bit-string booleans and numeric strings", () => {
    const p = buildAnswerProfileFromSettings({
      applyRequiresVisaSponsorship: { value: "1" },
      applyYearsExperience: { value: "12" },
      applyDeclineDemographics: { value: "0" },
    });
    expect(p.requiresVisaSponsorship).toBe(true);
    expect(p.yearsExperience).toBe(12);
    expect(p.declineDemographics).toBe(false);
  });
});

describe("resolveSponsorshipAnswer polarity", () => {
  it("answers positive-polarity 'do you require sponsorship?' as the raw flag", () => {
    expect(
      resolveSponsorshipAnswer("Do you now or in the future require sponsorship?", true),
    ).toBe(true);
    expect(
      resolveSponsorshipAnswer("Will you require visa sponsorship?", false),
    ).toBe(false);
  });

  it("inverts negative-polarity 'authorized WITHOUT sponsorship?'", () => {
    // User does NOT need sponsorship => "yes, authorized without sponsorship".
    expect(
      resolveSponsorshipAnswer(
        "Are you legally authorized to work without requiring sponsorship?",
        false,
      ),
    ).toBe(true);
    // User DOES need sponsorship => "no, not authorized without sponsorship".
    expect(
      resolveSponsorshipAnswer(
        "Are you able to work without needing sponsorship?",
        true,
      ),
    ).toBe(false);
  });

  it("returns null when the profile opts out (null) or the question isn't about sponsorship", () => {
    expect(resolveSponsorshipAnswer("Do you require sponsorship?", null)).toBeNull();
    expect(resolveSponsorshipAnswer("What is your name?", true)).toBeNull();
  });
});

describe("pickYesNoOption", () => {
  const opts = [
    { value: "1", label: "Yes" },
    { value: "0", label: "No" },
  ];
  it("selects yes/no by label", () => {
    expect(pickYesNoOption(opts, true)).toBe("1");
    expect(pickYesNoOption(opts, false)).toBe("0");
  });
  it("handles 'I am' / 'I am not' phrasing", () => {
    const phrased = [
      { value: "a", label: "I am authorized to work" },
      { value: "b", label: "I am not authorized to work" },
    ];
    expect(pickYesNoOption(phrased, true)).toBe("a");
    expect(pickYesNoOption(phrased, false)).toBe("b");
  });
  it("returns null when there's no matching option", () => {
    expect(pickYesNoOption([{ value: "x", label: "Maybe" }], true)).toBeNull();
  });
});

describe("pickDeclineOption", () => {
  it("finds the decline option across common phrasings", () => {
    expect(
      pickDeclineOption([
        { value: "m", label: "Male" },
        { value: "f", label: "Female" },
        { value: "d", label: "I don't wish to answer" },
      ]),
    ).toBe("d");
    expect(
      pickDeclineOption([
        { value: "1", label: "Yes" },
        { value: "2", label: "Prefer not to say" },
      ]),
    ).toBe("2");
    expect(
      pickDeclineOption([
        { value: "1", label: "Decline To Self Identify" },
      ]),
    ).toBe("1");
  });
  it("returns null when no decline option exists", () => {
    expect(
      pickDeclineOption([
        { value: "m", label: "Male" },
        { value: "f", label: "Female" },
      ]),
    ).toBeNull();
  });
});

describe("resolveProfileField", () => {
  it("fills LinkedIn / GitHub / portfolio URLs", () => {
    expect(
      resolveProfileField(field({ label: "LinkedIn Profile" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "https://linkedin.com/in/janedoe" });
    expect(
      resolveProfileField(field({ label: "GitHub URL" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "https://github.com/janedoe" });
    expect(
      resolveProfileField(field({ label: "Portfolio / personal website" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "https://janedoe.dev" });
  });

  it("fills notice period, desired salary, years of experience", () => {
    expect(
      resolveProfileField(field({ label: "Notice period" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "2 months" });
    expect(
      resolveProfileField(field({ label: "Salary expectation" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "90000 EUR" });
    expect(
      resolveProfileField(field({ label: "How many years of experience do you have?" }), FULL_PROFILE)?.value,
    ).toEqual({ kind: "text", value: "8" });
  });

  it("selects the sponsorship option using polarity", () => {
    const positive = field({
      label: "Do you require sponsorship?",
      type: "select",
      options: [
        { value: "y", label: "Yes" },
        { value: "n", label: "No" },
      ],
    });
    // requiresVisaSponsorship=false => answer "No".
    expect(resolveProfileField(positive, FULL_PROFILE)?.value).toEqual({
      kind: "choice",
      value: "n",
    });

    const negative = field({
      label: "Are you authorized to work without sponsorship?",
      type: "radio",
      options: [
        { value: "y", label: "Yes" },
        { value: "n", label: "No" },
      ],
    });
    // Does not need sponsorship => authorized-without-sponsorship = "Yes".
    expect(resolveProfileField(negative, FULL_PROFILE)?.value).toEqual({
      kind: "choice",
      value: "y",
    });
  });

  it("does NOT answer work-authorization questions (country-dependent, legal risk)", () => {
    const workAuth = field({
      label: "Are you legally authorized to work in the United States?",
      type: "select",
      options: [
        { value: "y", label: "Yes" },
        { value: "n", label: "No" },
      ],
    });
    // No 'sponsor' token => sponsorship branch doesn't fire; nothing else claims it.
    expect(resolveProfileField(workAuth, FULL_PROFILE)).toBeNull();
  });

  it("defaults demographic dropdowns to decline when enabled and option exists", () => {
    const gender = field({
      label: "Gender",
      type: "select",
      options: [
        { value: "m", label: "Male" },
        { value: "f", label: "Female" },
        { value: "d", label: "Decline to self-identify" },
      ],
    });
    expect(resolveProfileField(gender, FULL_PROFILE)?.value).toEqual({
      kind: "choice",
      value: "d",
    });
  });

  it("does not touch demographics when the user disabled the default", () => {
    const gender = field({
      label: "Gender",
      type: "select",
      options: [
        { value: "m", label: "Male" },
        { value: "d", label: "Decline to self-identify" },
      ],
    });
    expect(
      resolveProfileField(gender, { ...FULL_PROFILE, declineDemographics: false }),
    ).toBeNull();
  });

  it("returns null for unset profile values so the caller leaves them for review", () => {
    const empty: AnswerProfile = {
      linkedinUrl: null,
      githubUrl: null,
      portfolioUrl: null,
      noticePeriod: null,
      desiredSalary: null,
      yearsExperience: null,
      requiresVisaSponsorship: null,
      declineDemographics: true,
    };
    expect(resolveProfileField(field({ label: "LinkedIn" }), empty)).toBeNull();
    expect(resolveProfileField(field({ label: "Notice period" }), empty)).toBeNull();
    expect(
      resolveProfileField(
        field({
          label: "Do you require sponsorship?",
          type: "select",
          options: [{ value: "y", label: "Yes" }],
        }),
        empty,
      ),
    ).toBeNull();
  });

  it("is multi-tenant: a different profile drives different answers, no code change", () => {
    const tokyoUser: AnswerProfile = {
      ...FULL_PROFILE,
      linkedinUrl: "https://linkedin.com/in/taro",
      requiresVisaSponsorship: true,
    };
    expect(
      resolveProfileField(field({ label: "LinkedIn" }), tokyoUser)?.value,
    ).toEqual({ kind: "text", value: "https://linkedin.com/in/taro" });
    // Same negative-polarity question, opposite user => opposite answer.
    const negative = field({
      label: "Can you work without requiring sponsorship?",
      type: "select",
      options: [
        { value: "y", label: "Yes" },
        { value: "n", label: "No" },
      ],
    });
    expect(resolveProfileField(negative, tokyoUser)?.value).toEqual({
      kind: "choice",
      value: "n",
    });
  });
});

describe("isDemographicField", () => {
  it("flags EEO questions and ignores ordinary ones", () => {
    expect(isDemographicField(field({ label: "Veteran status" }))).toBe(true);
    expect(isDemographicField(field({ label: "Disability status" }))).toBe(true);
    expect(isDemographicField(field({ label: "First name" }))).toBe(false);
  });
});
