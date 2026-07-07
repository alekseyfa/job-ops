/**
 * Smart Apply pre-fill engine.
 *
 * Maps the candidate's design-resume `basics` block onto an arbitrary form
 * schema using label-based heuristics.  For fields we cannot confidently map
 * (essay-style screening questions, unknown selects), we emit a "skip" value
 * with a human-readable reason — the user will see those flagged in the
 * preview panel and fill them in by hand in the browser.
 *
 * This module is intentionally LLM-free for the demo: we don't want to ship
 * auto-generated cover-letter answers that the user submits without reading.
 * The user reviews every screening question in the rendered browser before
 * clicking Submit.
 */

import { existsSync } from "node:fs";
import { logger } from "@infra/logger";
import { getCandidateBasics, getCandidateNameParts } from "../candidate-profile";
import { safeFilePart } from "../pdf-storage";
import { getEffectiveSettings } from "../settings";
import type { Job } from "@shared/types";
import {
  type AnswerProfile,
  buildAnswerProfileFromSettings,
  EMPTY_ANSWER_PROFILE,
  resolveProfileField,
} from "./answer-profile";
import {
  type FieldValue,
  type FormField,
  type FormSchema,
  type PrefilledField,
  type PrefilledForm,
} from "./types";

/** Match any of the supplied keywords against the field's normalised label. */
function labelMatches(field: FormField, keywords: string[]): boolean {
  const label = field.normalizedLabel;
  if (!label) return false;
  return keywords.some((kw) => label.includes(kw));
}

function pickFirstNonEmpty<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined && (typeof v !== "string" || v.length > 0)) {
      return v;
    }
  }
  return null;
}

function makeSkip(reason: string): FieldValue {
  return { kind: "skip", reason };
}

interface PrefillContext {
  job: Pick<Job, "id" | "employer" | "title" | "pdfPath" | "coverLetterPdfPath">;
  basics: Awaited<ReturnType<typeof getCandidateBasics>>;
  nameParts: Awaited<ReturnType<typeof getCandidateNameParts>>;
  profile: AnswerProfile;
}

/**
 * Map reusable, non-resume answers (profile links, notice period, salary,
 * years, sponsorship, EEO decline) from the user's Apply Profile. This is what
 * stops the user re-typing the same answers on every application. Returns null
 * when the profile has no confident answer for this field, so the caller falls
 * through to attachBasic / defaultUnfilled.
 */
function attachProfile(
  field: FormField,
  ctx: PrefillContext,
): PrefilledField | null {
  if (field.type === "file") return null;
  const resolved = resolveProfileField(field, ctx.profile);
  if (!resolved) return null;
  return {
    selector: field.selector,
    label: field.label,
    normalizedLabel: field.normalizedLabel,
    type: field.type,
    required: field.required,
    value: resolved.value,
    filled: true,
    // Sponsorship + demographic answers are pre-selected but the user should
    // still confirm them; the note tells them so. Links/salary/notice are safe.
    requiresReview: false,
    note: resolved.note,
  };
}

function attachResume(
  field: FormField,
  ctx: PrefillContext,
): PrefilledField | null {
  if (field.type !== "file") return null;
  const isResumeField = labelMatches(field, [
    "resume",
    "cv",
    "résumé",
    "curriculum",
    "lebenslauf",
  ]);
  const isCoverField = labelMatches(field, [
    "cover letter",
    "motivation",
    "cover_letter",
    "covering letter",
  ]);

  let path: string | null = null;
  let visibleSuffix = "CV";
  if (isResumeField) {
    path = ctx.job.pdfPath ?? null;
    visibleSuffix = "CV";
  } else if (isCoverField) {
    path = ctx.job.coverLetterPdfPath ?? null;
    visibleSuffix = "CoverLetter";
  }

  if (!path || !existsSync(path)) {
    return {
      selector: field.selector,
      label: field.label,
      normalizedLabel: field.normalizedLabel,
      type: field.type,
      required: field.required,
      value: makeSkip(
        isCoverField
          ? "Cover letter PDF not generated yet — generate it from the job card first."
          : "Resume PDF not available — move the job to Ready in the bot to render it.",
      ),
      filled: false,
      requiresReview: field.required,
    };
  }

  const safeName = ctx.basics.name ? safeFilePart(ctx.basics.name) : "";
  const safeEmployer = safeFilePart(ctx.job.employer);
  const visibleName =
    safeName && safeEmployer
      ? `${safeName}_${safeEmployer}_${visibleSuffix}.pdf`
      : safeName
        ? `${safeName}_${visibleSuffix}.pdf`
        : `${visibleSuffix}.pdf`;

  return {
    selector: field.selector,
    label: field.label,
    normalizedLabel: field.normalizedLabel,
    type: field.type,
    required: field.required,
    value: { kind: "file", path, visibleName },
    filled: true,
    requiresReview: false,
  };
}

function attachBasic(field: FormField, ctx: PrefillContext): PrefilledField | null {
  // Order matters: more-specific labels go first.
  if (labelMatches(field, ["first name", "given name", "vorname"])) {
    const value = ctx.nameParts.firstName;
    return makeText(field, value, "First name from your resume.");
  }
  if (labelMatches(field, ["last name", "family name", "surname", "nachname"])) {
    const value = ctx.nameParts.lastName;
    return makeText(field, value, "Last name from your resume.");
  }
  if (labelMatches(field, ["full name", "your name", "name"]) && field.type !== "file") {
    return makeText(
      field,
      pickFirstNonEmpty(ctx.basics.name, ctx.nameParts.fullName),
      "Full name from your resume.",
    );
  }
  if (labelMatches(field, ["email", "e-mail"]) || field.type === "email") {
    return makeText(field, ctx.basics.email, "Email from your resume.");
  }
  if (labelMatches(field, ["phone", "mobile", "telefon", "telephone"]) || field.type === "tel") {
    return makeText(field, ctx.basics.phone, "Phone from your resume.");
  }
  // LinkedIn / GitHub / portfolio links come from the Apply Profile
  // (attachProfile), not the resume — handled before this fallback.
  if (
    labelMatches(field, [
      "city",
      "location",
      "where are you based",
      "your location",
      "current location",
    ])
  ) {
    return makeText(field, ctx.basics.location, "Location from your resume.");
  }
  return null;
}

function makeText(
  field: FormField,
  value: string | null,
  note: string,
): PrefilledField {
  if (!value) {
    return {
      selector: field.selector,
      label: field.label,
      normalizedLabel: field.normalizedLabel,
      type: field.type,
      required: field.required,
      value: makeSkip(`We don't have a value for "${field.label}" yet.`),
      filled: false,
      requiresReview: field.required,
    };
  }
  return {
    selector: field.selector,
    label: field.label,
    normalizedLabel: field.normalizedLabel,
    type: field.type,
    required: field.required,
    value: { kind: "text", value },
    filled: true,
    requiresReview: false,
    note,
  };
}

function defaultUnfilled(field: FormField): PrefilledField {
  // The default "we don't know" path: tell the user to review.  For required
  // fields this is critical, for optionals it's a friendly nudge.
  return {
    selector: field.selector,
    label: field.label,
    normalizedLabel: field.normalizedLabel,
    type: field.type,
    required: field.required,
    value: makeSkip(
      field.type === "textarea"
        ? "Free-text answer — write your own (we don't auto-draft to avoid LLM mistakes you'd ship without noticing)."
        : field.type === "select" || field.type === "radio"
          ? "Choose the right option yourself."
          : "Not auto-fillable — review in the browser.",
    ),
    filled: false,
    requiresReview: field.required,
  };
}

export async function buildPrefilledForm(args: {
  schema: FormSchema;
  job: Pick<Job, "id" | "employer" | "title" | "pdfPath" | "coverLetterPdfPath">;
}): Promise<PrefilledForm> {
  const basics = await getCandidateBasics();
  const nameParts = await getCandidateNameParts();
  let profile: AnswerProfile;
  try {
    profile = buildAnswerProfileFromSettings(await getEffectiveSettings());
  } catch (err) {
    // Never let a settings read failure break prefill — degrade to resume-only.
    logger.warn("Smart Apply prefill: failed to load answer profile", {
      error: err instanceof Error ? err.message : String(err),
    });
    profile = EMPTY_ANSWER_PROFILE;
  }
  const ctx: PrefillContext = { job: args.job, basics, nameParts, profile };

  const fields: PrefilledField[] = args.schema.fields.map((field) => {
    const prefilled = (
      attachResume(field, ctx) ||
      attachProfile(field, ctx) ||
      attachBasic(field, ctx) ||
      defaultUnfilled(field)
    );
    // Preserve hint from the parsed schema for essay drafting.
    if (field.hint) {
      prefilled.hint = field.hint;
    }
    return prefilled;
  });

  const reviewRequiredCount = fields.filter((f) => f.requiresReview).length;
  const essayFields = fields.filter(
    (f) => f.type === "textarea" && f.requiresReview,
  );

  logger.info("Smart Apply prefill ready", {
    ats: args.schema.ats,
    fields: fields.length,
    autoFilled: fields.filter((f) => f.filled).length,
    requiresReview: reviewRequiredCount,
    essayFields: essayFields.length,
  });

  return {
    ats: args.schema.ats,
    applyUrl: args.schema.applyUrl,
    fields,
    reviewRequiredCount,
    essayFields,
  };
}
