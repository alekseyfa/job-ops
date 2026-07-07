/**
 * Smart Apply answer profile — the reusable, non-resume answers that almost
 * every application form asks for and that the user would otherwise re-type on
 * every single application: profile links, notice period, desired salary,
 * years of experience, visa sponsorship, and demographic (EEO) handling.
 *
 * This module is intentionally PURE (no DB, no IO, no LLM) so the field-mapping
 * heuristics can be unit-tested in isolation. `buildAnswerProfileFromSettings`
 * turns the loaded settings into an {@link AnswerProfile}; `resolveProfileField`
 * decides what — if anything — to put into a given parsed form field.
 *
 * Multi-tenant: everything is driven by the user's settings. There are NO
 * hardcoded candidate values here — a second user with different links, a
 * different notice period, or a different sponsorship need just changes their
 * settings and the same code produces different answers.
 *
 * Safety rules baked in:
 *   - Work-authorization ("are you authorized to work in <country>") is
 *     deliberately NOT auto-answered. On a worldwide search the answer is
 *     country-dependent, and a wrong blanket yes/no is a legal misrepresentation
 *     risk. Those stay review-required.
 *   - Visa sponsorship is only answered when the user has explicitly opted in
 *     (tri-state: null = leave blank). Polarity is detected per question so
 *     "do you require sponsorship?" and "are you authorized without
 *     sponsorship?" get opposite booleans.
 *   - Demographic / EEO questions default to "Decline to self-identify", which
 *     every compliant ATS offers, and only when the user leaves that enabled.
 */

import type { FormField, FieldValue } from "./types";

export interface AnswerProfile {
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  noticePeriod: string | null;
  desiredSalary: string | null;
  yearsExperience: number | null;
  /** null = leave blank; true = needs sponsorship; false = does not. */
  requiresVisaSponsorship: boolean | null;
  /** When true, EEO/demographic questions default to "decline to state". */
  declineDemographics: boolean;
}

/** Shape we read from `getEffectiveSettings()` — only the keys we care about. */
interface SettingsLike {
  applyLinkedinUrl?: { value?: unknown } | null;
  applyGithubUrl?: { value?: unknown } | null;
  applyPortfolioUrl?: { value?: unknown } | null;
  applyNoticePeriod?: { value?: unknown } | null;
  applyDesiredSalary?: { value?: unknown } | null;
  applyYearsExperience?: { value?: unknown } | null;
  applyRequiresVisaSponsorship?: { value?: unknown } | null;
  applyDeclineDemographics?: { value?: unknown } | null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

/**
 * Build an {@link AnswerProfile} from the effective settings object. Tolerant of
 * missing keys so it works before the user has filled anything in (everything
 * falls back to "unknown" and Smart Apply leaves those fields for review).
 */
export function buildAnswerProfileFromSettings(
  settings: SettingsLike,
): AnswerProfile {
  return {
    linkedinUrl: asString(settings.applyLinkedinUrl?.value),
    githubUrl: asString(settings.applyGithubUrl?.value),
    portfolioUrl: asString(settings.applyPortfolioUrl?.value),
    noticePeriod: asString(settings.applyNoticePeriod?.value),
    desiredSalary: asString(settings.applyDesiredSalary?.value),
    yearsExperience: asNumber(settings.applyYearsExperience?.value),
    requiresVisaSponsorship: asBoolOrNull(
      settings.applyRequiresVisaSponsorship?.value,
    ),
    // Default ON: absent setting means "decline demographics" (the safe choice).
    declineDemographics:
      asBoolOrNull(settings.applyDeclineDemographics?.value) ?? true,
  };
}

/** Empty profile — used as a safe fallback when settings can't be read. */
export const EMPTY_ANSWER_PROFILE: AnswerProfile = {
  linkedinUrl: null,
  githubUrl: null,
  portfolioUrl: null,
  noticePeriod: null,
  desiredSalary: null,
  yearsExperience: null,
  requiresVisaSponsorship: null,
  declineDemographics: true,
};

function labelHas(field: FormField, keywords: string[]): boolean {
  const label = field.normalizedLabel;
  if (!label) return false;
  return keywords.some((kw) => label.includes(kw));
}

/**
 * Decide whether a question about sponsorship, when answered "yes", means "I
 * need sponsorship" (positive polarity) or "I do NOT need sponsorship"
 * (negative polarity — e.g. "are you authorized to work without sponsorship?").
 *
 * Returns the boolean to select for a yes/no field given the user's
 * `requiresVisaSponsorship`, or null if we shouldn't answer.
 */
export function resolveSponsorshipAnswer(
  label: string,
  requiresVisaSponsorship: boolean | null,
): boolean | null {
  if (requiresVisaSponsorship === null) return null;
  const l = label.toLowerCase();

  // Only answer if the question is actually about sponsorship.
  if (!l.includes("sponsor")) return null;

  // Negative-polarity phrasings: "yes" means "does NOT need sponsorship".
  //   "authorized to work ... without sponsorship"
  //   "able to work without requiring sponsorship"
  //   "legally authorized ... not require sponsorship"
  const negativePolarity =
    /without (requiring |needing )?sponsor/.test(l) ||
    /not require sponsor/.test(l) ||
    /no sponsorship (required|needed)/.test(l);

  if (negativePolarity) {
    // "yes" == does not need sponsorship == !requiresVisaSponsorship
    return !requiresVisaSponsorship;
  }
  // Positive polarity: "do you require/need sponsorship?" → yes == requires.
  return requiresVisaSponsorship;
}

/**
 * From a set of {value,label} options, pick the one that best represents the
 * desired yes/no answer. Returns the option value, or null if no confident
 * match. Handles common ATS phrasings ("Yes"/"No", "I am"/"I am not", etc.).
 */
export function pickYesNoOption(
  options: Array<{ value: string; label: string }>,
  wantYes: boolean,
): string | null {
  const yesRe = /^(yes|y|true|i am|i do|i have|authorized|eligible)\b/i;
  const noRe = /^(no|n|false|i am not|i do not|i don't|not authorized|ineligible)\b/i;
  for (const opt of options) {
    const label = opt.label.trim();
    if (wantYes && yesRe.test(label)) return opt.value;
    if (!wantYes && noRe.test(label)) return opt.value;
  }
  // Fallback: exact "yes"/"no" match on the option value itself.
  for (const opt of options) {
    const v = opt.value.trim().toLowerCase();
    if (wantYes && (v === "yes" || v === "true" || v === "1")) return opt.value;
    if (!wantYes && (v === "no" || v === "false" || v === "0")) return opt.value;
  }
  return null;
}

/**
 * Pick the "decline to self-identify" option from a demographic dropdown.
 * Covers the standard EEO phrasings used by Greenhouse/Ashby/Lever/Workday.
 */
export function pickDeclineOption(
  options: Array<{ value: string; label: string }>,
): string | null {
  const declineRe =
    /(decline|prefer not|don'?t wish|do not wish|not to (answer|say|disclose|identify)|prefer not to say)/i;
  for (const opt of options) {
    if (declineRe.test(opt.label)) return opt.value;
  }
  return null;
}

/** Is this field one of the standard demographic / EEO questions? */
export function isDemographicField(field: FormField): boolean {
  return labelHas(field, [
    "gender",
    "race",
    "ethnic",
    "veteran",
    "disability",
    "hispanic",
    "latino",
    "sexual orientation",
    "identify as transgender",
  ]);
}

/**
 * Given a parsed form field and the user's answer profile, return the value to
 * fill — or null if this module has no opinion (caller falls back to its own
 * default-unfilled behaviour). This is the single decision point the prefill
 * engine consults for profile-backed answers.
 */
export function resolveProfileField(
  field: FormField,
  profile: AnswerProfile,
): { value: FieldValue; note: string } | null {
  // --- Profile links (text/url) ---
  if (labelHas(field, ["linkedin"]) && profile.linkedinUrl) {
    return {
      value: { kind: "text", value: profile.linkedinUrl },
      note: "LinkedIn from your Apply Profile.",
    };
  }
  if (
    labelHas(field, ["github", "git hub"]) &&
    profile.githubUrl
  ) {
    return {
      value: { kind: "text", value: profile.githubUrl },
      note: "GitHub from your Apply Profile.",
    };
  }
  if (
    labelHas(field, ["portfolio", "personal site", "personal website", "website", "web site"]) &&
    profile.portfolioUrl
  ) {
    return {
      value: { kind: "text", value: profile.portfolioUrl },
      note: "Portfolio from your Apply Profile.",
    };
  }

  // --- Notice period ---
  if (
    labelHas(field, ["notice period", "notice", "availability", "start date", "when can you start"]) &&
    profile.noticePeriod &&
    (field.type === "text" || field.type === "textarea")
  ) {
    return {
      value: { kind: "text", value: profile.noticePeriod },
      note: "Notice period from your Apply Profile.",
    };
  }

  // --- Desired salary / compensation ---
  if (
    labelHas(field, [
      "salary",
      "compensation",
      "expected pay",
      "desired pay",
      "salary expectation",
      "compensation expectation",
    ]) &&
    profile.desiredSalary &&
    (field.type === "text" || field.type === "textarea")
  ) {
    return {
      value: { kind: "text", value: profile.desiredSalary },
      note: "Desired salary from your Apply Profile.",
    };
  }

  // --- Years of experience (text/number) ---
  if (
    labelHas(field, ["years of experience", "years experience", "yrs experience", "how many years"]) &&
    profile.yearsExperience !== null &&
    (field.type === "text" || field.type === "textarea")
  ) {
    return {
      value: { kind: "text", value: String(profile.yearsExperience) },
      note: "Years of experience from your Apply Profile.",
    };
  }

  // --- Visa sponsorship (yes/no on select or radio) ---
  if (
    labelHas(field, ["sponsor", "sponsorship"]) &&
    (field.type === "select" || field.type === "radio") &&
    field.options &&
    field.options.length > 0
  ) {
    const wantYes = resolveSponsorshipAnswer(
      field.label,
      profile.requiresVisaSponsorship,
    );
    if (wantYes !== null) {
      const optionValue = pickYesNoOption(field.options, wantYes);
      if (optionValue !== null) {
        return {
          value: { kind: "choice", value: optionValue },
          note: "Sponsorship answer from your Apply Profile — verify before submitting.",
        };
      }
    }
  }

  // --- Demographic / EEO: default to "decline to self-identify" ---
  if (
    profile.declineDemographics &&
    isDemographicField(field) &&
    (field.type === "select" || field.type === "radio") &&
    field.options &&
    field.options.length > 0
  ) {
    const optionValue = pickDeclineOption(field.options);
    if (optionValue !== null) {
      return {
        value: { kind: "choice", value: optionValue },
        note: "Defaulted to 'Decline to self-identify' — change it in the browser if you prefer.",
      };
    }
  }

  return null;
}
