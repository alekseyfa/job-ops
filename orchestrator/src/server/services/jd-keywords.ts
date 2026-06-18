/**
 * Weighted job-description keyword extraction (WS1).
 *
 * Pure, IO-free helper that turns a job description — plus the scorer's already
 * computed {@link JobMatchAnalysis} when available — into a weighted, classified
 * keyword list. It is the shared substrate for two things:
 *   1. the tailoring prompt (which JD phrases to prioritise), and
 *   2. the parse-back ATS coverage report (how much of the JD made it into the
 *      rendered PDF, weighted by importance).
 *
 * We prefer the scorer's structured signal (requirements/skills/keywords) over
 * raw tokenisation, mirroring the priority order ATS match-rate tools use:
 * hard skills > title > education > soft skills > other.
 *
 * No LLM call, no DB, no network — deterministic given its inputs.
 */

import type { JobMatchAnalysis } from "@shared/types";

export type JdKeywordClass = "hard" | "soft" | "title" | "education" | "other";

export interface WeightedJdKeyword {
  /** Normalised (lower-cased, trimmed) keyword phrase. */
  term: string;
  class: JdKeywordClass;
  weight: number;
}

/** Per-class weights. Hard skills + title terms matter most to ATS match rate. */
const CLASS_WEIGHT: Record<JdKeywordClass, number> = {
  hard: 3,
  title: 3,
  education: 2,
  soft: 1,
  other: 1,
};

const EDUCATION_RE =
  /\b(bachelor'?s?|master'?s?|phd|ph\.d|b\.?sc|m\.?sc|degree|diploma)\b/i;

// "a plus", "nice to have", "preferred", "bonus" => soft / nice-to-have signal.
const SOFT_CONTEXT_RE = /\b(a plus|nice to have|preferred|bonus|ideally)\b/i;

/** Normalise a phrase for case-insensitive comparison and dedup. */
function normalize(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Lightweight tokenizer that preserves the symbols common in tech terms
 * (c++, c#, ci/cd, node.js). Mirrors the job-screening tokenizer so the
 * provenance index and the coverage check agree on what a "token" is.
 */
function tokenizeJd(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "our", "are", "will", "this",
  "that", "have", "has", "from", "all", "any", "can", "who", "what", "they",
  "work", "team", "role", "job", "able", "must", "should", "would", "experience",
]);

/**
 * Build the weighted keyword set. When `matchAnalysis` is present, its
 * structured fields drive the classification; otherwise we fall back to a
 * shallow JD tokenisation so the function never throws on a missing analysis.
 */
export function extractWeightedJdKeywords(
  jobDescription: string,
  matchAnalysis?: JobMatchAnalysis | null,
): WeightedJdKeyword[] {
  const byTerm = new Map<string, WeightedJdKeyword>();

  // Highest-priority class wins if the same term appears in several buckets.
  const CLASS_RANK: Record<JdKeywordClass, number> = {
    hard: 5,
    title: 4,
    education: 3,
    soft: 2,
    other: 1,
  };
  const add = (raw: string, cls: JdKeywordClass): void => {
    const term = normalize(raw);
    if (!term || term.length < 2) return;
    const existing = byTerm.get(term);
    if (existing && CLASS_RANK[existing.class] >= CLASS_RANK[cls]) return;
    byTerm.set(term, { term, class: cls, weight: CLASS_WEIGHT[cls] });
  };

  if (matchAnalysis) {
    // Hard requirements + concrete skills the scorer identified.
    for (const s of matchAnalysis.requirements?.missing ?? []) add(s, "hard");
    for (const s of matchAnalysis.requirements?.met ?? []) add(s, "hard");
    for (const s of matchAnalysis.skills?.missing ?? []) add(s, "hard");
    for (const s of matchAnalysis.skills?.matched ?? []) add(s, "hard");
    // Exact JD phrases the scorer says to add verbatim — treat as title-class
    // (highest ATS signal) unless they read as soft/education.
    for (const k of matchAnalysis.keywords?.addToResume ?? []) {
      if (EDUCATION_RE.test(k)) add(k, "education");
      else if (SOFT_CONTEXT_RE.test(k)) add(k, "soft");
      else add(k, "title");
    }
    // Bonus / transferable skills => soft / nice-to-have.
    for (const s of matchAnalysis.skills?.bonus ?? []) add(s, "soft");
    for (const s of matchAnalysis.skills?.transferable ?? []) add(s, "soft");
  }

  // Always scan the JD itself for education signals (cheap, high precision).
  if (EDUCATION_RE.test(jobDescription)) {
    const m = jobDescription.match(EDUCATION_RE);
    if (m) add(m[0], "education");
  }

  // Fallback: if the scorer gave us nothing, derive "other" keywords from the
  // JD so the coverage report still has something to measure.
  if (byTerm.size === 0) {
    const seen = new Set<string>();
    for (const tok of tokenizeJd(jobDescription)) {
      if (TOKEN_STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      add(tok, "other");
    }
  }

  return [...byTerm.values()];
}
