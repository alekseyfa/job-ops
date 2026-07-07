import { createId } from "@paralleldrive/cuid2";
import type { ResumeProjectCatalogItem } from "@shared/types";
import { normalizeTextForATS } from "@shared/utils/normalize-ats-text.js";
import { stripHtmlTags } from "@shared/utils/string";
import {
  filterInjectedKeywords,
  isSupported,
  type ProvenanceIndex,
} from "../tailoring-provenance";

type RecordLike = Record<string, unknown>;

export type TailoredSkillsInput =
  | Array<{ name: string; keywords: string[] }>
  | string
  | null
  | undefined;

export type TailorChunkInput = {
  headline?: string | null;
  summary?: string | null;
  skills?: TailoredSkillsInput;
  experience?: TailoredExperienceEntryInput[] | null;
};

export type ResumeProjectSelectionItem = ResumeProjectCatalogItem & {
  summaryText: string;
};

export function cloneResumeData<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseTailoredSkills(
  skills: TailoredSkillsInput,
): Array<RecordLike> | null {
  if (!skills) return null;
  const parsed = Array.isArray(skills)
    ? skills
    : typeof skills === "string"
      ? (JSON.parse(skills) as unknown)
      : null;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (item) => item && typeof item === "object",
  ) as RecordLike[];
}

export function applyTailoredHeadline(
  resumeData: RecordLike,
  headline?: string | null,
): void {
  if (!headline) return;
  const basics = asRecord(resumeData.basics);
  if (!basics) return;
  basics.headline = headline;
  // Preserve current behavior for legacy consumers/templates that use label.
  basics.label = headline;
}

export function applyTailoredSummary(
  resumeData: RecordLike,
  summary?: string | null,
): void {
  if (!summary) return;
  const topSummary = asRecord(resumeData.summary);
  if (topSummary) {
    if (
      typeof topSummary.content === "string" ||
      topSummary.content === undefined
    ) {
      topSummary.content = summary;
      return;
    }
    if (
      typeof topSummary.value === "string" ||
      topSummary.value === undefined
    ) {
      topSummary.value = summary;
      return;
    }
  }

  const sections = asRecord(resumeData.sections);
  const summarySection = asRecord(sections?.summary);
  if (summarySection) {
    summarySection.content = summary;
    return;
  }
}

export function applyTailoredSkills(
  resumeData: RecordLike,
  tailoredSkills?: TailoredSkillsInput,
  provenanceIndex?: ProvenanceIndex,
): void {
  const skills = parseTailoredSkills(tailoredSkills);
  if (!skills) return;

  const sections = asRecord(resumeData.sections);
  const skillsSection = asRecord(sections?.skills);
  const existingItems = asArray(skillsSection?.items);
  if (!skillsSection || !existingItems) return;
  const existing = existingItems
    .map((item) => asRecord(item))
    .filter((item): item is RecordLike => Boolean(item));

  const template = existing[0] ?? null;
  if (!template) return;

  skillsSection.items = skills.map((newSkill) => {
    const match =
      existing.find((item) => item.name === newSkill.name) ?? template;
    const next: RecordLike = { ...match };

    if ("id" in next) {
      next.id =
        (typeof newSkill.id === "string" && newSkill.id) ||
        (typeof match.id === "string" ? match.id : "") ||
        createId();
    }
    if ("name" in next) {
      next.name =
        (typeof newSkill.name === "string" ? newSkill.name : "") ||
        (typeof match.name === "string" ? match.name : "");
    }
    if ("keywords" in next) {
      const proposed = Array.isArray(newSkill.keywords)
        ? newSkill.keywords.filter((k): k is string => typeof k === "string")
        : Array.isArray(match.keywords)
          ? match.keywords.filter((k): k is string => typeof k === "string")
          : [];
      // WS1 truthfulness guard: drop any keyword the base resume doesn't
      // support (directly, via synonym, or all word-tokens present). Falls
      // open when no index is supplied (backwards compatible) or the resume
      // is empty, so existing callers/tests are unaffected.
      next.keywords = provenanceIndex
        ? filterInjectedKeywords(proposed, provenanceIndex).kept
        : proposed;
    }

    if ("description" in next) {
      next.description =
        typeof newSkill.description === "string"
          ? newSkill.description
          : typeof match.description === "string"
            ? match.description
            : "";
    }
    if ("proficiency" in next) {
      next.proficiency =
        typeof newSkill.proficiency === "string"
          ? newSkill.proficiency
          : typeof newSkill.description === "string"
            ? newSkill.description
            : typeof match.proficiency === "string"
              ? match.proficiency
              : "";
    }
    if ("level" in next) {
      next.level =
        typeof newSkill.level === "number"
          ? newSkill.level
          : typeof match.level === "number"
            ? match.level
            : next.level;
    }
    if ("hidden" in next) {
      next.hidden =
        typeof newSkill.hidden === "boolean"
          ? newSkill.hidden
          : typeof match.hidden === "boolean"
            ? match.hidden
            : next.hidden;
    }

    return next;
  });
}

export interface TailoredExperienceEntryInput {
  company: string;
  position: string;
  bullets: string[];
}

export interface TailoredExperienceDiffEntry {
  company: string;
  position: string;
  before: string;
  after: string;
}

function normalizeMatchKey(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

function bulletsToHtml(bullets: string[]): string {
  const items = bullets
    .map((b) => normalizeTextForATS(b).trim())
    .filter((b) => b.length > 0)
    .map((b) => `<li><p>${b}</p></li>`)
    .join("");
  return items ? `<ul>${items}</ul>` : "";
}

/**
 * Apply provenance-safe tailored experience bullets onto the resume's
 * experience section (WS1-T3). Each tailored entry is matched to an existing
 * experience item by company + position (case/space-insensitive); its bullets
 * are rebuilt as an HTML <ul> from ONLY the words the base resume supports —
 * any bullet that introduces an unsupported token is reverted to the original.
 * Both renderers read sections.experience.items[].description, so writing here
 * covers the rxresume and LaTeX paths. Returns a before/after diff for audit.
 *
 * Fails closed: the provenanceIndex is mandatory (no compat bypass) so a
 * missing index can never let a fabricated bullet through.
 */
export function applyTailoredExperience(
  resumeData: RecordLike,
  tailoredExperience: TailoredExperienceEntryInput[] | null | undefined,
  provenanceIndex: ProvenanceIndex,
): TailoredExperienceDiffEntry[] {
  if (!tailoredExperience || tailoredExperience.length === 0) return [];

  const sections = asRecord(resumeData.sections);
  const experienceSection = asRecord(sections?.experience);
  const items = asArray(experienceSection?.items);
  if (!experienceSection || !items) return [];

  const diffs: TailoredExperienceDiffEntry[] = [];

  for (const rawItem of items) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const match = tailoredExperience.find(
      (t) =>
        normalizeMatchKey(t.company) === normalizeMatchKey(item.company) &&
        normalizeMatchKey(t.position) === normalizeMatchKey(item.position),
    );
    if (!match) continue;

    // Token-level provenance guard: a tailored bullet may only use words the
    // base resume already contains. Reject any bullet that introduces an
    // unsupported alphabetic token (numbers/punctuation are ignored) and keep
    // the original instead — this is the no-fabrication contract in code.
    const safeBullets = match.bullets.filter((bullet) => {
      const tokens = bullet
        .toLowerCase()
        .replace(/[^a-z0-9+#./\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => /[a-z]/.test(t) && t.length >= 3);
      return tokens.every((t) => isSupported(t, provenanceIndex));
    });

    if (safeBullets.length === 0) continue;

    const before = typeof item.description === "string" ? item.description : "";
    const after = bulletsToHtml(safeBullets);
    if (!after || after === before) continue;

    item.description = after;
    diffs.push({
      company: typeof item.company === "string" ? item.company : "",
      position: typeof item.position === "string" ? item.position : "",
      before: stripHtmlTags(before),
      after: stripHtmlTags(after),
    });
  }

  return diffs;
}

export function extractProjectsFromResume(resumeData: RecordLike): {
  catalog: ResumeProjectCatalogItem[];
  selectionItems: ResumeProjectSelectionItem[];
} {
  const sections = asRecord(resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!items) return { catalog: [], selectionItems: [] };

  const catalog: ResumeProjectCatalogItem[] = [];
  const selectionItems: ResumeProjectSelectionItem[] = [];

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    const name = typeof item.name === "string" ? item.name : id;
    const description =
      typeof item.description === "string" ? item.description : "";
    const date = typeof item.period === "string" ? item.period : "";

    const isVisibleInBase = !(typeof item.hidden === "boolean"
      ? item.hidden
      : false);

    const summaryRaw = description;

    const base: ResumeProjectCatalogItem = {
      id,
      name,
      description,
      date,
      isVisibleInBase,
    };
    catalog.push(base);
    selectionItems.push({
      ...base,
      summaryText: stripHtmlTags(summaryRaw),
    });
  }

  return { catalog, selectionItems };
}

export function applyProjectVisibility(args: {
  resumeData: RecordLike;
  selectedProjectIds: ReadonlySet<string>;
  forceVisibleProjectsSection?: boolean;
}): void {
  const sections = asRecord(args.resumeData.sections);
  const projectsSection = asRecord(sections?.projects);
  const items = asArray(projectsSection?.items);
  if (!projectsSection || !items) return;

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;

    if ("hidden" in item) {
      item.hidden = !args.selectedProjectIds.has(id);
    }
  }

  if (args.forceVisibleProjectsSection !== false) {
    if ("hidden" in projectsSection) {
      projectsSection.hidden = false;
    }
  }
}

export function applyTailoredChunks(args: {
  resumeData: RecordLike;
  tailoredContent: TailorChunkInput;
  /** When supplied, injected skill keywords are validated against the resume. */
  provenanceIndex?: ProvenanceIndex;
}): void {
  // Normalize AI-generated text for ATS compatibility before applying
  const normalized: TailorChunkInput = {
    headline: args.tailoredContent.headline
      ? normalizeTextForATS(args.tailoredContent.headline)
      : args.tailoredContent.headline,
    summary: args.tailoredContent.summary
      ? normalizeTextForATS(args.tailoredContent.summary)
      : args.tailoredContent.summary,
    skills: normalizeSkillsForATS(args.tailoredContent.skills),
  };

  applyTailoredSkills(args.resumeData, normalized.skills, args.provenanceIndex);
  applyTailoredSummary(args.resumeData, normalized.summary);
  applyTailoredHeadline(args.resumeData, normalized.headline);

  // WS1-T3: experience-bullet tailoring requires the provenance index (fails
  // closed — no index means we never touch experience).
  if (args.tailoredContent.experience && args.provenanceIndex) {
    applyTailoredExperience(
      args.resumeData,
      args.tailoredContent.experience,
      args.provenanceIndex,
    );
  }
}

function normalizeSkillsForATS(
  skills: TailoredSkillsInput,
): TailoredSkillsInput {
  if (!skills || typeof skills === "string") {
    return skills ? normalizeTextForATS(skills) : skills;
  }
  return skills.map((group) => ({
    name: normalizeTextForATS(group.name),
    keywords: group.keywords.map((kw) => normalizeTextForATS(kw)),
  }));
}
