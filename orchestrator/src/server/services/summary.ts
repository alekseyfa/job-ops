/**
 * Service for generating tailored resume content (Summary, Headline, Skills).
 */

import { createHash } from "node:crypto";
import { logger } from "@infra/logger";
import type { JobMatchAnalysis, ResumeProfile } from "@shared/types";
import { extractWeightedJdKeywords } from "./jd-keywords";
import type { JsonSchemaDefinition } from "./llm/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";
import {
  getWritingLanguageLabel,
  resolveWritingOutputLanguage,
} from "./output-language";
import {
  getEffectivePromptTemplate,
  renderPromptTemplate,
} from "./prompt-templates";
import {
  getWritingStyle,
  stripKeywordLimitFromConstraints,
  stripLanguageDirectivesFromConstraints,
  stripWordLimitFromConstraints,
} from "./writing-style";

export interface TailoredExperienceEntry {
  company: string;
  position: string;
  bullets: string[];
}

export interface TailoredData {
  summary: string;
  headline: string;
  skills: Array<{ name: string; keywords: string[] }>;
  /** Provenance-safe rephrased experience bullets (WS1-T3). Optional — only
   * requested when the tailorExperienceBullets flag is on. */
  experience?: TailoredExperienceEntry[];
}

export interface TailoringResult {
  success: boolean;
  data?: TailoredData;
  error?: string;
}

/**
 * JSON schema for resume tailoring response. The experience field is added
 * only when experience-bullet tailoring is enabled (WS1-T3), so the default
 * request shape is unchanged when the flag is off.
 */
function buildTailoringSchema(includeExperience: boolean): JsonSchemaDefinition {
  const properties: Record<string, unknown> = {
    headline: {
      type: "string",
      description: "Job title headline matching the JD exactly",
    },
    summary: {
      type: "string",
      description: "Tailored resume summary paragraph",
    },
    skills: {
      type: "array",
      description: "Skills sections with keywords tailored to the job",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill category name (e.g., Frontend, Backend)",
          },
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "List of skills/technologies in this category",
          },
        },
        required: ["name", "keywords"],
        additionalProperties: false,
      },
    },
  };
  const required = ["headline", "summary", "skills"];

  if (includeExperience) {
    properties.experience = {
      type: "array",
      description:
        "Each existing experience entry with its bullets REPHRASED (never invented) to emphasize JD-relevant work.",
      items: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company name, copied verbatim from the profile",
          },
          position: {
            type: "string",
            description: "Position title, copied verbatim from the profile",
          },
          bullets: {
            type: "array",
            items: { type: "string" },
            description:
              "Rephrased bullet points — only rewordings of the candidate's existing bullets, no new skills/metrics/employers",
          },
        },
        required: ["company", "position", "bullets"],
        additionalProperties: false,
      },
    };
    required.push("experience");
  }

  return {
    name: "resume_tailoring",
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * Generate tailored resume content (summary, headline, skills) for a job.
 */
export async function generateTailoring(
  jobDescription: string,
  profile: ResumeProfile,
  matchAnalysis?: JobMatchAnalysis | null,
  options?: { includeExperience?: boolean },
): Promise<TailoringResult> {
  const includeExperience = options?.includeExperience ?? false;
  const [model, writingStyle] = await Promise.all([
    resolveLlmModel("tailoring"),
    getWritingStyle(),
  ]);
  const prompt = await buildTailoringPrompt(
    profile,
    jobDescription,
    writingStyle,
    matchAnalysis,
    includeExperience,
  );

  const llm = await createConfiguredLlmService();
  const result = await llm.callJson<TailoredData>({
    model,
    messages: [{ role: "user", content: prompt }],
    jsonSchema: buildTailoringSchema(includeExperience),
  });

  if (!result.success) {
    const context = `provider=${llm.getProvider()} baseUrl=${llm.getBaseUrl()}`;
    if (result.error.toLowerCase().includes("api key")) {
      const message = `LLM API key not set, cannot generate tailoring. (${context})`;
      logger.warn(message);
      return { success: false, error: message };
    }
    return {
      success: false,
      error: `${result.error} (${context})`,
    };
  }

  const { summary, headline, skills, experience } = result.data;

  // Basic validation
  if (!summary || !headline || !Array.isArray(skills)) {
    logger.warn("AI response missing required tailoring fields", result.data);
  }

  return {
    success: true,
    data: {
      summary: sanitizeText(summary || ""),
      headline: sanitizeText(headline || ""),
      skills: skills || [],
      // Only surface experience when it was requested AND well-formed; the
      // provenance guard (token-level no-fabrication) is enforced downstream
      // in applyTailoredExperience, which has the parsed base resume.
      experience:
        includeExperience && Array.isArray(experience)
          ? experience
              .filter(
                (e) =>
                  e &&
                  typeof e.company === "string" &&
                  typeof e.position === "string" &&
                  Array.isArray(e.bullets),
              )
              .map((e) => ({
                company: e.company,
                position: e.position,
                bullets: e.bullets
                  .filter((b): b is string => typeof b === "string")
                  .map((b) => sanitizeText(b)),
              }))
          : undefined,
    },
  };
}

/**
 * Backwards compatibility wrapper if needed, or alias.
 */
export async function generateSummary(
  jobDescription: string,
  profile: ResumeProfile,
): Promise<{ success: boolean; summary?: string; error?: string }> {
  // If we just need summary, we can discard the rest (or cache it? but here we just return summary)
  const result = await generateTailoring(jobDescription, profile);
  return {
    success: result.success,
    summary: result.data?.summary,
    error: result.error,
  };
}

// Cap mirrors scorer.ts — anything past 8 KB is almost always boilerplate
// and costs tokens without informing the resume rewrite.
const JOB_DESCRIPTION_MAX_CHARS = 8000;
const TRUNCATION_MARKER = "\n\n... [description truncated]";

function truncateJobDescription(raw: string | null | undefined): string {
  if (!raw) return "";
  if (raw.length <= JOB_DESCRIPTION_MAX_CHARS) return raw;
  const head = raw.slice(0, JOB_DESCRIPTION_MAX_CHARS);
  const lastBoundary = head.lastIndexOf(" ");
  const safeHead =
    lastBoundary > JOB_DESCRIPTION_MAX_CHARS * 0.9
      ? head.slice(0, lastBoundary)
      : head;
  return `${safeHead}${TRUNCATION_MARKER}`;
}

async function buildTailoringPrompt(
  profile: ResumeProfile,
  jd: string,
  writingStyle: Awaited<ReturnType<typeof getWritingStyle>>,
  matchAnalysis?: JobMatchAnalysis | null,
  includeExperience = false,
): Promise<string> {
  const resolvedLanguage = resolveWritingOutputLanguage({
    style: writingStyle,
    profile,
  });
  const outputLanguage = getWritingLanguageLabel(resolvedLanguage.language);
  let effectiveConstraints = stripLanguageDirectivesFromConstraints(
    writingStyle.constraints,
  );
  if (writingStyle.summaryMaxWords != null) {
    effectiveConstraints = stripWordLimitFromConstraints(effectiveConstraints);
  }
  if (writingStyle.maxKeywordsPerSkill != null) {
    effectiveConstraints =
      stripKeywordLimitFromConstraints(effectiveConstraints);
  }

  // Extract only needed parts of profile to save tokens
  const relevantProfile = {
    basics: {
      name: profile.basics?.name,
      label: profile.basics?.label, // Original headline
      summary: profile.basics?.summary,
    },
    skills: profile.sections?.skills,
    projects: profile.sections?.projects?.items?.map((p) => ({
      name: p.name,
      description: p.description,
      keywords: p.keywords,
    })),
    experience: profile.sections?.experience?.items?.map((e) => ({
      company: e.company,
      position: e.position,
      summary: e.summary,
    })),
  };

  const template = await getEffectivePromptTemplate("tailoringPromptTemplate");

  // WS1: feed the scorer's already-computed match analysis into tailoring so
  // the tailorer prioritizes the EXACT JD phrases the scorer identified instead
  // of re-deriving them. When no analysis is available these render empty, so
  // the prompt is byte-identical to the pre-WS1 baseline.
  const weightedKeywords = matchAnalysis
    ? extractWeightedJdKeywords(jd, matchAnalysis)
    : [];
  const priorityKeywords = weightedKeywords
    .filter((k) => k.class === "hard" || k.class === "title")
    .map((k) => k.term);
  const addToResumeKeywords =
    priorityKeywords.length > 0 ? priorityKeywords.join(", ") : "";
  const missingSkills = (matchAnalysis?.skills?.missing ?? []).join(", ");
  const tailoringTips = (matchAnalysis?.tailoringTips ?? []).join("; ");

  const rendered = renderPromptTemplate(template, {
    jobDescription: truncateJobDescription(jd),
    profileJson: JSON.stringify(relevantProfile, null, 2),
    addToResumeKeywords,
    missingSkills,
    tailoringTips,
    outputLanguage,
    tone: writingStyle.tone,
    formality: writingStyle.formality,
    summaryMaxWordsLine:
      writingStyle.summaryMaxWords != null
        ? ` Maximum ${writingStyle.summaryMaxWords} ${writingStyle.summaryMaxWords === 1 ? "word" : "words"}.`
        : "",
    maxKeywordsPerSkillLine:
      writingStyle.maxKeywordsPerSkill != null
        ? `\n   - Maximum ${writingStyle.maxKeywordsPerSkill} ${writingStyle.maxKeywordsPerSkill === 1 ? "keyword" : "keywords"} per category. If a category has more, keep only the most JD-relevant ones.`
        : "",
    constraintsBullet: effectiveConstraints
      ? `- Additional constraints: ${effectiveConstraints}`
      : "",
    avoidTermsBullet: writingStyle.doNotUse
      ? `- Avoid these words or phrases: ${writingStyle.doNotUse}`
      : "",
  });

  // WS1-T3: when experience-bullet tailoring is on, append a strict
  // rephrase-only instruction. Appended (not woven into the user-overridable
  // template) so the off-path prompt is unchanged. The model receives the
  // candidate's real experience entries above (relevantProfile.experience),
  // and the no-fabrication contract is additionally enforced in code by the
  // provenance guard in applyTailoredExperience.
  if (!includeExperience) return rendered;
  return `${rendered}

EXPERIENCE TAILORING (return an "experience" array):
- For each of MY existing experience entries, copy "company" and "position" VERBATIM and return a "bullets" array.
- Each bullet must be a REPHRASING of one of my existing bullets to emphasize JD-relevant work.
- NEVER invent a skill, technology, employer, metric, or responsibility that is not already in my profile. If a bullet has no JD-relevant angle, return it essentially unchanged.
- Keep the same number of bullets or fewer; do not pad.`;
}

function sanitizeText(text: string): string {
  return text
    .replace(/\*\*[\s\S]*?\*\*/g, "") // remove markdown bold
    .trim();
}

/**
 * Version of the tailoring logic/prompt. Bump this when a tailoring improvement
 * should force already-processed jobs to be re-tailored on their next run.
 * Folded into the tailoring fingerprint below.
 */
export const TAILORING_PROMPT_VERSION = 2;

/**
 * Fingerprint cached tailored content by job-description hash + the settings
 * that change the OUTPUT (prompt version + experience flag). When the stored
 * fingerprint differs, summarizeJob regenerates instead of serving stale
 * tailoring — so an edited JD or a bumped prompt version auto-refreshes.
 */
export function computeTailoringFingerprint(input: {
  jobDescription: string;
  includeExperience: boolean;
}): string {
  const hash = createHash("sha256");
  hash.update(`v${TAILORING_PROMPT_VERSION}`);
  hash.update("|exp:");
  hash.update(input.includeExperience ? "1" : "0");
  hash.update("|jd:");
  hash.update(input.jobDescription ?? "");
  return hash.digest("hex").slice(0, 16);
}
