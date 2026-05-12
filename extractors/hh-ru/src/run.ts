/**
 * HeadHunter (hh.ru) extractor — public search API at api.hh.ru/vacancies.
 *
 * Targeted at Russian-speaking candidates in EU looking for remote roles.
 * Filter strategy: schedule=remote + only_with_salary=false + per_page=100,
 * search by `text` (search term).
 *
 * Per HH API guidelines, supply a polite User-Agent.
 */

import type { CreateJobInput } from "@shared/types/jobs";
import { createRateLimitedFetch } from "@shared/utils/rate-limited-fetch";

const HH_API_URL = "https://api.hh.ru/vacancies";
const HH_USER_AGENT = "JobOps/1.0 (+https://github.com/dakheera47/job-ops)";
const DEFAULT_MAX_PER_TERM = 50;

export type HhWorkplaceType = "remote" | "hybrid" | "onsite";

export type HhProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    };

export interface RunHhOptions {
  searchTerms?: string[];
  workplaceTypes?: HhWorkplaceType[];
  maxJobsPerTerm?: number;
  onProgress?: (event: HhProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface HhResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

interface HhVacancy {
  id?: unknown;
  name?: unknown;
  alternate_url?: unknown;
  apply_alternate_url?: unknown;
  area?: unknown;
  employer?: unknown;
  snippet?: unknown;
  schedule?: unknown;
  experience?: unknown;
  employment?: unknown;
  professional_roles?: unknown;
  salary?: unknown;
  published_at?: unknown;
}

interface HhResponse {
  items?: HhVacancy[];
  found?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function workplaceMatches(
  workplaceTypes: HhWorkplaceType[] | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

function getEmployer(vacancy: HhVacancy): string {
  if (vacancy.employer && typeof vacancy.employer === "object") {
    const candidate = vacancy.employer as Record<string, unknown>;
    return asString(candidate.name) ?? "Unknown Employer";
  }
  return "Unknown Employer";
}

function getEmployerLogo(vacancy: HhVacancy): string | undefined {
  if (vacancy.employer && typeof vacancy.employer === "object") {
    const candidate = vacancy.employer as Record<string, unknown>;
    if (candidate.logo_urls && typeof candidate.logo_urls === "object") {
      const urls = candidate.logo_urls as Record<string, unknown>;
      return (
        asString(urls["240"]) ?? asString(urls["90"]) ?? asString(urls.original)
      );
    }
  }
  return undefined;
}

function getAreaName(vacancy: HhVacancy): string | undefined {
  if (vacancy.area && typeof vacancy.area === "object") {
    const candidate = vacancy.area as Record<string, unknown>;
    return asString(candidate.name);
  }
  return undefined;
}

function isRemoteSchedule(vacancy: HhVacancy): boolean {
  if (vacancy.schedule && typeof vacancy.schedule === "object") {
    const candidate = vacancy.schedule as Record<string, unknown>;
    return asString(candidate.id) === "remote";
  }
  return false;
}

function getScheduleLabel(vacancy: HhVacancy): string | undefined {
  if (vacancy.schedule && typeof vacancy.schedule === "object") {
    return asString((vacancy.schedule as Record<string, unknown>).name);
  }
  return undefined;
}

function getExperienceLabel(vacancy: HhVacancy): string | undefined {
  if (vacancy.experience && typeof vacancy.experience === "object") {
    return asString((vacancy.experience as Record<string, unknown>).name);
  }
  return undefined;
}

function getProfessionalRoles(vacancy: HhVacancy): string | undefined {
  if (!Array.isArray(vacancy.professional_roles)) return undefined;
  const names: string[] = [];
  for (const role of vacancy.professional_roles) {
    if (role && typeof role === "object") {
      const candidate = role as Record<string, unknown>;
      const name = asString(candidate.name);
      if (name) names.push(name);
    }
  }
  return names.length > 0 ? names.join(", ") : undefined;
}

function getSalary(vacancy: HhVacancy): {
  display?: string;
  min?: number;
  max?: number;
  currency?: string;
} {
  if (!vacancy.salary || typeof vacancy.salary !== "object") return {};
  const candidate = vacancy.salary as Record<string, unknown>;
  const min = asNumber(candidate.from);
  const max = asNumber(candidate.to);
  const currency = asString(candidate.currency);
  if (!min && !max) return {};
  const formatted = [min ?? "", max ?? ""].filter(Boolean).join(" - ");
  return {
    display: currency ? `${formatted} ${currency.toUpperCase()}` : formatted,
    min,
    max,
    currency: currency?.toUpperCase(),
  };
}

function getDescription(vacancy: HhVacancy): string | undefined {
  if (!vacancy.snippet || typeof vacancy.snippet !== "object") return undefined;
  const candidate = vacancy.snippet as Record<string, unknown>;
  const requirement = asString(candidate.requirement);
  const responsibility = asString(candidate.responsibility);
  const parts: string[] = [];
  if (responsibility) parts.push(`Responsibilities:\n${responsibility}`);
  if (requirement) parts.push(`Requirements:\n${requirement}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function mapVacancy(vacancy: HhVacancy): CreateJobInput | null {
  const id = asString(vacancy.id);
  const title = asString(vacancy.name);
  const url = asString(vacancy.alternate_url);
  if (!id || !title || !url) return null;

  const employer = getEmployer(vacancy);
  const isRemote = isRemoteSchedule(vacancy);
  const area = getAreaName(vacancy) ?? "Remote";
  const location = isRemote ? "Remote" : area;
  const salary = getSalary(vacancy);

  return {
    source: "hhru",
    sourceJobId: id,
    title,
    employer,
    jobUrl: url,
    applicationLink: asString(vacancy.apply_alternate_url) ?? url,
    location,
    locationEvidence: { location, source: "hhru" },
    jobDescription: getDescription(vacancy),
    datePosted: asString(vacancy.published_at),
    jobLevel: getExperienceLabel(vacancy),
    jobFunction: getProfessionalRoles(vacancy),
    workFromHomeType: getScheduleLabel(vacancy),
    salary: salary.display,
    salaryMinAmount: salary.min,
    salaryMaxAmount: salary.max,
    salaryCurrency: salary.currency,
    companyLogo: getEmployerLogo(vacancy),
    isRemote,
  };
}

async function fetchPage(args: {
  fetchImpl: typeof fetch;
  searchTerm: string;
  perPage: number;
  remoteOnly: boolean;
}): Promise<HhVacancy[]> {
  const url = new URL(HH_API_URL);
  url.searchParams.set("text", args.searchTerm);
  url.searchParams.set("per_page", String(args.perPage));
  url.searchParams.set("page", "0");
  if (args.remoteOnly) {
    url.searchParams.set("schedule", "remote");
  }

  const response = await args.fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": HH_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`HH.ru request failed with ${response.status}`);
  }
  const payload = (await response.json()) as HhResponse;
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function runHhRu(
  options: RunHhOptions = {},
): Promise<HhResult> {
  if (!workplaceMatches(options.workplaceTypes)) {
    return { success: true, jobs: [] };
  }

  const fetchImpl = options.fetchImpl ?? createRateLimitedFetch("hhru");
  const searchTerms =
    options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms
      : ["software engineer"];
  const maxJobsPerTerm = Math.max(
    1,
    Math.min(100, options.maxJobsPerTerm ?? DEFAULT_MAX_PER_TERM),
  );
  const remoteOnly =
    options.workplaceTypes?.length === 1 &&
    options.workplaceTypes[0] === "remote";

  try {
    const jobs: CreateJobInput[] = [];
    const seen = new Set<string>();

    for (const [index, searchTerm] of searchTerms.entries()) {
      if (options.shouldCancel?.()) return { success: true, jobs };

      options.onProgress?.({
        type: "term_start",
        termIndex: index + 1,
        termTotal: searchTerms.length,
        searchTerm,
      });

      const fetched = await fetchPage({
        fetchImpl,
        searchTerm,
        perPage: maxJobsPerTerm,
        remoteOnly,
      });

      let jobsFoundTerm = 0;
      for (const vacancy of fetched) {
        if (options.shouldCancel?.()) return { success: true, jobs };
        if (jobsFoundTerm >= maxJobsPerTerm) break;
        const mapped = mapVacancy(vacancy);
        if (!mapped) continue;
        const dedupeKey = mapped.sourceJobId ?? mapped.jobUrl;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        jobs.push(mapped);
        jobsFoundTerm += 1;
      }

      options.onProgress?.({
        type: "term_complete",
        termIndex: index + 1,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm,
      });
    }

    return { success: true, jobs };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unexpected error while running HH.ru extractor.";
    return { success: false, jobs: [], error: message };
  }
}
