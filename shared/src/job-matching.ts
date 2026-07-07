import {
  matchesRequestedCity,
  matchesRequestedCountry,
  shouldApplyStrictCityFilter,
} from "./search-cities.js";
import type { CreateJobInput } from "./types";
import type { LocationIntent } from "./types/location";
import { normalizeWhitespace } from "./utils/string";

const COMPANY_SUFFIXES = [
  "limited",
  "ltd",
  "llp",
  "plc",
  "inc",
  "incorporated",
  "corporation",
  "corp",
  "company",
  "co",
  "llc",
  "uk",
  "international",
  "intl",
  "group",
  "holdings",
  "t/a",
  "trading as",
  "&",
  "the",
];

function normalizeMatchText(value: string): string {
  const normalized = value.toLowerCase().trim();
  return normalizeWhitespace(
    normalized.replace(/[.,'"()[\]{}!?@#$%^&*+=|\\/<>:;`~_-]/g, " "),
  );
}

export function normalizeCompanyName(name: string): string {
  let normalized = normalizeMatchText(name);
  for (const suffix of COMPANY_SUFFIXES) {
    const regex = new RegExp(`\\b${suffix}\\b`, "gi");
    normalized = normalized.replace(regex, " ");
  }
  return normalizeWhitespace(normalized);
}

export function normalizeJobTitle(title: string): string {
  return normalizeMatchText(title);
}

export function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

  if (s1.includes(s2) || s2.includes(s1)) {
    const longerLen = Math.max(s1.length, s2.length);
    const shorterLen = Math.min(s1.length, s2.length);
    return Math.round((shorterLen / longerLen) * 100);
  }

  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = matrix[s1.length][s2.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.round(((maxLen - distance) / maxLen) * 100);
}

function normalizeLocationCandidate(value: string): string | null {
  const trimmed = normalizeWhitespace(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function getJobLocationCandidates(job: {
  location?: string | null;
  locationEvidence?:
    | Array<{
        value?: string | null;
      }>
    | {
        location?: string | null;
        country?: string | null;
        city?: string | null;
        workplaceType?: "remote" | "hybrid" | "onsite" | null;
      }
    | null;
}): string[] {
  const evidenceCandidates = Array.isArray(job.locationEvidence)
    ? job.locationEvidence.map((item) => item.value)
    : job.locationEvidence
      ? [
          job.locationEvidence.location,
          job.locationEvidence.country,
          job.locationEvidence.city,
          job.locationEvidence.workplaceType,
        ]
      : [];
  const candidates = [job.location, ...evidenceCandidates];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeLocationCandidate(candidate);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

export function matchJobLocationIntent(
  job: {
    location?: string | null;
    locationEvidence?: {
      location?: string | null;
      country?: string | null;
      city?: string | null;
      workplaceType?: "remote" | "hybrid" | "onsite" | null;
    } | null;
    isRemote?: boolean | null;
  },
  intent: LocationIntent,
): {
  matched: boolean;
  reasonCode: string;
  priority: 0 | 1;
} {
  const candidates = getJobLocationCandidates(job);
  const selectedCountry = intent.selectedCountry;

  if (!selectedCountry) {
    return { matched: true, reasonCode: "unfiltered", priority: 0 };
  }

  const countryMatched = candidates.some((candidate) =>
    matchesRequestedCountry(candidate, selectedCountry),
  );

  if (countryMatched) {
    if (intent.cityLocations.length === 0) {
      return { matched: true, reasonCode: "selected_location", priority: 1 };
    }

    const cityMatched = intent.cityLocations.some((requestedCity) => {
      const strict = shouldApplyStrictCityFilter(
        requestedCity,
        selectedCountry,
      );
      if (!strict) return true;
      return candidates.some((candidate) =>
        matchesRequestedCity(candidate, requestedCity),
      );
    });

    if (cityMatched || intent.matchStrictness === "flexible") {
      return { matched: true, reasonCode: "selected_location", priority: 1 };
    }
  }

  if (
    intent.workplaceTypes.includes("remote") &&
    intent.geoScope !== "selected_only" &&
    job.isRemote === true
  ) {
    return { matched: true, reasonCode: "remote_worldwide", priority: 0 };
  }

  return { matched: false, reasonCode: "no_match", priority: 0 };
}

// ---------------------------------------------------------------------------
// Cross-posting / near-duplicate detection (WS2)
//
// The same role is routinely posted to several boards at once (LinkedIn +
// Indeed + the company's Greenhouse page). Keyed only on the exact URL these
// become distinct jobs, so the same vacancy gets scored multiple times
// (wasted LLM budget) and floods the curated list. These helpers collapse
// such cross-posts to one canonical posting, preferring the direct-ATS URL.
// Pure and IO-free.
// ---------------------------------------------------------------------------

/** ATS sources whose URLs we prefer as the canonical posting (apply directly). */
const DIRECT_ATS_SOURCES = new Set<string>([
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "smartrecruiters",
]);

const ATS_URL_RE = /(greenhouse|ashby|lever|myworkdayjobs|smartrecruiters)\./i;

/**
 * Fingerprint a job by normalized title + employer + location. Two jobs with
 * the same fingerprint are treated as the same vacancy cross-posted to
 * different boards. Returns null when title or employer is missing — we never
 * collapse jobs we cannot confidently identify. Reuses normalizeJobTitle +
 * normalizeCompanyName so the fingerprint agrees with the rest of matching.
 */
export function crossPostingFingerprint(
  job: Pick<CreateJobInput, "title" | "employer" | "location">,
): string | null {
  const title = normalizeJobTitle(job.title ?? "");
  const employer = normalizeCompanyName(job.employer ?? "");
  if (!title || !employer) return null;
  const location = normalizeWhitespace((job.location ?? "").toLowerCase());
  return `${title}|${employer}|${location}`;
}

/** True if this job's URL points directly at an ATS application form. */
export function isDirectAtsPosting(job: CreateJobInput): boolean {
  if (job.source && DIRECT_ATS_SOURCES.has(job.source)) return true;
  return ATS_URL_RE.test(job.jobUrl ?? "");
}

export interface CrossPostingDedupResult {
  /** One canonical input per detected vacancy (direct-ATS URL preferred). */
  canonical: CreateJobInput[];
  /** How many inputs were dropped as cross-posting duplicates. */
  duplicatesRemoved: number;
}

/**
 * Collapse near-duplicate cross-postings in an input batch. Jobs that share a
 * fingerprint are reduced to one canonical posting (the first direct-ATS URL in
 * the group, else the first seen). Jobs with no fingerprint always pass through
 * untouched — we never silently drop something we can't confidently identify.
 */
export function dedupeCrossPostings(
  inputs: CreateJobInput[],
): CrossPostingDedupResult {
  const groups = new Map<string, CreateJobInput[]>();
  const passthrough: CreateJobInput[] = [];

  for (const input of inputs) {
    const fp = crossPostingFingerprint(input);
    if (!fp) {
      passthrough.push(input);
      continue;
    }
    const group = groups.get(fp);
    if (group) group.push(input);
    else groups.set(fp, [input]);
  }

  const canonical: CreateJobInput[] = [];
  let duplicatesRemoved = 0;

  for (const group of groups.values()) {
    if (group.length === 1) {
      canonical.push(group[0]);
      continue;
    }
    const preferred = group.find(isDirectAtsPosting) ?? group[0];
    canonical.push(preferred);
    duplicatesRemoved += group.length - 1;
  }

  return { canonical: [...passthrough, ...canonical], duplicatesRemoved };
}
