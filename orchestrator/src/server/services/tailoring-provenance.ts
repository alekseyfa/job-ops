/**
 * Truthfulness / provenance guard (WS1).
 *
 * The single most important safety mechanism in the tailoring pipeline: it
 * guarantees the tailored resume can NEVER claim a skill or keyword that is not
 * already supported by the candidate's base resume. The market-wide "keyword
 * stuffing" behaviour (inserting JD keywords whether or not the candidate has
 * them) is exactly what this prevents — fabricated skills fail technical
 * screens and break trust.
 *
 * Pure and IO-free. The index is always derived from the resume JSON passed in
 * (never a module constant), so it is multi-user safe by construction.
 */

import { extractKeywordsFromResumeJson } from "./job-screening";

export interface ProvenanceIndex {
  /** Lower-cased single tokens drawn from the resume (skills, experience, …). */
  readonly tokens: ReadonlySet<string>;
  /** Multi-word skill/keyword phrases, lower-cased (e.g. "distributed systems"). */
  readonly phrases: ReadonlySet<string>;
  /** True when the resume yielded no tokens — the guard then "falls open". */
  readonly empty: boolean;
}

/**
 * Small, explicit synonym map so a candidate who lists "React" is credited for
 * a JD asking for "ReactJS". Bidirectional. Kept deliberately tiny and
 * hand-curated — we never expand it via an LLM.
 *
 * TODO(multi-tenant): if a future tenant needs domain-specific synonyms, load
 * these from a per-user setting rather than this module constant.
 */
const SYNONYM_GROUPS: string[][] = [
  ["react", "reactjs", "react.js"],
  ["kubernetes", "k8s"],
  ["javascript", "js"],
  ["typescript", "ts"],
  ["postgresql", "postgres"],
  ["nodejs", "node.js", "node"],
  ["ci/cd", "cicd", "continuous integration"],
  ["tdd", "test driven development", "unit testing"],
];

/** term -> set of all equivalent terms (including itself). */
const SYNONYM_LOOKUP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const set = new Set(group);
    for (const term of group) map.set(term, set);
  }
  return map;
})();

function normalize(term: string): string {
  return term.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build the provenance index from a resume JSON document. Reuses the
 * job-screening keyword walk so the provenance token set matches the screening
 * keyword set exactly (one definition of "what the resume contains").
 */
export function buildProvenanceIndex(resumeJson: unknown): ProvenanceIndex {
  const { tokens } = extractKeywordsFromResumeJson(resumeJson);

  // Capture multi-word skill phrases verbatim so "distributed systems" is
  // supported as a phrase even though its individual tokens are generic.
  const phrases = new Set<string>();
  collectSkillPhrases(resumeJson, phrases);

  return {
    tokens,
    phrases,
    empty: tokens.size === 0 && phrases.size === 0,
  };
}

/** Walk sections.skills[].{name,keywords} and basics.headline for phrases. */
function collectSkillPhrases(resumeJson: unknown, out: Set<string>): void {
  if (!resumeJson || typeof resumeJson !== "object") return;
  const resume = resumeJson as Record<string, unknown>;
  const sections = resume.sections as Record<string, unknown> | undefined;
  const skills = sections?.skills as { items?: unknown[] } | undefined;
  for (const item of skills?.items ?? []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name === "string") out.add(normalize(rec.name));
    if (Array.isArray(rec.keywords)) {
      for (const kw of rec.keywords) {
        if (typeof kw === "string") out.add(normalize(kw));
      }
    }
  }
}

function expandSynonyms(term: string): Set<string> {
  return SYNONYM_LOOKUP.get(term) ?? new Set([term]);
}

/**
 * Is `term` supported by the resume — directly, via a synonym, or because its
 * individual word-tokens are all present? An empty index falls open (returns
 * true) so a missing/unparseable resume never silently strips everything.
 */
export function isSupported(term: string, index: ProvenanceIndex): boolean {
  if (index.empty) return true;
  const norm = normalize(term);
  if (!norm) return false;

  // Direct phrase or token hit (incl. synonyms).
  for (const variant of expandSynonyms(norm)) {
    if (index.phrases.has(variant)) return true;
    if (index.tokens.has(variant)) return true;
  }

  // Multi-word term: supported only if every word-token is present in the
  // resume (e.g. "python automation" passes iff both "python" and "automation"
  // appear). This is conservative — it never invents a capability.
  const words = norm.split(" ").filter(Boolean);
  if (words.length > 1) {
    return words.every((w) =>
      [...expandSynonyms(w)].some((v) => index.tokens.has(v)),
    );
  }

  return false;
}

/**
 * Filter a list of LLM-proposed keywords down to those the resume supports.
 * Returns both the kept and dropped lists so callers can surface "JD wanted X
 * but it's not in your background" instead of silently fabricating it.
 */
export function filterInjectedKeywords(
  keywords: string[],
  index: ProvenanceIndex,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const kw of keywords) {
    if (isSupported(kw, index)) kept.push(kw);
    else dropped.push(kw);
  }
  return { kept, dropped };
}
