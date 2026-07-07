import { z } from "zod";
import {
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
} from "./location-preferences";
import { getDefaultPromptTemplate } from "./prompt-template-definitions";
import {
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
  type ChatStyleLanguageMode,
  type ChatStyleManualLanguage,
  PDF_RENDERER_VALUES,
  type PdfRenderer,
  type ResumeProjectsSettings,
} from "./types/settings";

function parseNonEmptyStringOrNull(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseJsonArrayOrNull(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseBitBoolOrNull(raw: string | undefined): boolean | null {
  if (!raw) return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function normalizeLlmProviderOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  return normalized ? normalized : null;
}

export const DEFAULT_GEMINI_MODEL = "google/gemini-3-flash-preview";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_CODEX_MODEL = "";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function getDefaultModelForProvider(
  provider: string | null | undefined,
  fallbackModel?: string | null,
): string {
  const trimmedFallback = fallbackModel?.trim();
  if (trimmedFallback) {
    return trimmedFallback;
  }

  const normalizedProvider = normalizeLlmProviderOrNull(provider ?? undefined);

  if (normalizedProvider === "openai") {
    return DEFAULT_OPENAI_MODEL;
  }

  if (normalizedProvider === "gemini") {
    return DEFAULT_GEMINI_MODEL;
  }

  if (normalizedProvider === "codex") {
    return DEFAULT_CODEX_MODEL;
  }
  if (normalizedProvider === "anthropic") {
    return DEFAULT_ANTHROPIC_MODEL;
  }
  return DEFAULT_GEMINI_MODEL;
}

function serializeNullableNumber(
  value: number | null | undefined,
): string | null {
  return value !== null && value !== undefined ? String(value) : null;
}

function serializeNullableJsonArray(
  value: string[] | null | undefined,
): string | null {
  return value !== null && value !== undefined ? JSON.stringify(value) : null;
}

function serializeBitBool(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "1" : "0";
}

function createEnumParser<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
): (raw: string | undefined) => TValues[number] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number] | null => {
    if (!raw) return null;
    return allowedValues.has(raw) ? (raw as TValues[number]) : null;
  };
}

function createEnumArrayParser<
  const TValues extends readonly [string, ...string[]],
>(values: TValues): (raw: string | undefined) => TValues[number][] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number][] | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;

      const out: TValues[number][] = [];
      const seen = new Set<string>();
      for (const value of parsed) {
        if (typeof value !== "string" || !allowedValues.has(value)) {
          return null;
        }
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value as TValues[number]);
      }
      if (out.length === 0) return null;
      return out;
    } catch {
      return null;
    }
  };
}

const parseChatStyleLanguageModeOrNull = createEnumParser(
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
);

const parseChatStyleManualLanguageOrNull = createEnumParser(
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
);
const parsePdfRendererOrNull = createEnumParser(PDF_RENDERER_VALUES);

const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;
const parseWorkplaceTypesOrNull = createEnumArrayParser(WORKPLACE_TYPE_VALUES);
const parseLocationSearchScopeOrNull = createEnumParser(
  LOCATION_SEARCH_SCOPE_VALUES,
);
const parseLocationMatchStrictnessOrNull = createEnumParser(
  LOCATION_MATCH_STRICTNESS_VALUES,
);

export const resumeProjectsSchema = z.object({
  maxProjects: z.number().int().min(0).max(100),
  lockedProjectIds: z.array(z.string().trim().min(1)).max(200),
  aiSelectableProjectIds: z.array(z.string().trim().min(1)).max(200),
});

export const settingsRegistry = {
  // --- Typed Settings ---
  model: {
    kind: "typed" as const,
    schema: z.string().trim().max(200),
    default: (): string =>
      typeof process !== "undefined"
        ? getDefaultModelForProvider(
            process.env.LLM_PROVIDER,
            process.env.MODEL,
          )
        : DEFAULT_GEMINI_MODEL,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmProvider: {
    kind: "typed" as const,
    envKey: "LLM_PROVIDER",
    schema: z.preprocess(
      (v) => (typeof v === "string" ? normalizeLlmProviderOrNull(v) : v),
      z
        .enum([
          "openrouter",
          "lmstudio",
          "ollama",
          "openai",
          "openai_compatible",
          "gemini",
          "codex",
          "anthropic",
        ])
        .nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined"
        ? normalizeLlmProviderOrNull(process.env.LLM_PROVIDER) || "openrouter"
        : "openrouter",
    parse: normalizeLlmProviderOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmBaseUrl: {
    kind: "typed" as const,
    envKey: "LLM_BASE_URL",
    schema: z.preprocess(
      (v) => (v === "" ? null : v),
      z.string().trim().url().max(2000).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined" ? process.env.LLM_BASE_URL || "" : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  pipelineWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.PIPELINE_WEBHOOK_URL || process.env.WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobCompleteWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOB_COMPLETE_WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  resumeProjects: {
    kind: "typed" as const,
    schema: resumeProjectsSchema,
    default: (): ResumeProjectsSettings => ({
      maxProjects: 20,
      lockedProjectIds: [],
      aiSelectableProjectIds: [],
    }),
    parse: (raw: string | undefined): ResumeProjectsSettings | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    serialize: (
      value: ResumeProjectsSettings | null | undefined,
    ): string | null => {
      return value ? JSON.stringify(value) : null;
    },
  },
  pdfRenderer: {
    kind: "typed" as const,
    schema: z.enum(PDF_RENDERER_VALUES),
    default: (): PdfRenderer => "rxresume",
    parse: parsePdfRendererOrNull,
    serialize: (value: PdfRenderer | null | undefined): string | null =>
      value ?? null,
  },
  ukvisajobsMaxJobs: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  adzunaMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.ADZUNA_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  gradcrackerMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  startupjobsMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.STARTUPJOBS_MAX_RESULTS || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  seekMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.SEEK_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  searchTerms: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(100),
    default: (): string[] =>
      (typeof process !== "undefined"
        ? process.env.JOBSPY_SEARCH_TERMS || "web developer"
        : "web developer"
      )
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean),
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  workplaceTypes: {
    kind: "typed" as const,
    schema: z.array(z.enum(WORKPLACE_TYPE_VALUES)).min(1).max(3),
    default: (): Array<(typeof WORKPLACE_TYPE_VALUES)[number]> => [
      "remote",
      "hybrid",
      "onsite",
    ],
    parse: parseWorkplaceTypesOrNull,
    serialize: serializeNullableJsonArray,
  },
  blockedCompanyKeywords: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(200),
    default: (): string[] => [],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  atsBoardSlugs: {
    kind: "typed" as const,
    schema: z.array(
      z.object({
        provider: z.enum(["greenhouse", "ashby", "lever", "workday", "smartrecruiters"]),
        slug: z.string().trim().min(1).max(100),
      }),
    ).max(100),
    default: (): Array<{ provider: string; slug: string }> => [],
    parse: (raw: string | undefined): Array<{ provider: string; slug: string }> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    serialize: (value: Array<{ provider: string; slug: string }> | null | undefined): string | null =>
      value !== null && value !== undefined ? JSON.stringify(value) : null,
  },
  // ATS Board Presets: user activates curated preset collections via preset IDs.
  // See shared/src/ats-board-presets.ts for the preset catalog (ATS_BOARD_PRESET_CATALOG).
  activeAtsBoardPresets: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(50)).max(20),
    default: (): string[] => [],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  scoringInstructions: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  ghostwriterSystemPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string =>
      getDefaultPromptTemplate("ghostwriterSystemPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  ghostwriterStopSlopEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  tailoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("tailoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  scoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("scoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  searchCities: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.SEARCH_CITIES || process.env.JOBSPY_LOCATION || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationSearchScope: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_SEARCH_SCOPE_VALUES),
    default: () => "selected_only" as const,
    parse: parseLocationSearchScopeOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationMatchStrictness: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_MATCH_STRICTNESS_VALUES),
    default: () => "exact_only" as const,
    parse: parseLocationMatchStrictnessOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobspyResultsWanted: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.JOBSPY_RESULTS_WANTED || "200"
          : "200",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  jobspyCountryIndeed: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOBSPY_COUNTRY_INDEED || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  // Relocation filter: locations the candidate calls home (city or suburb
  // keywords).  Used by `requiresRelocation` to keep on-site postings that
  // are commutable.  Empty list = no city is auto-allowed.
  //
  // Multi-tenant note: the default below encodes "Munich metro" today.
  // For a different city, the user edits this in Settings — no code change.
  relocationHomeCities: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(100)).max(200),
    default: (): string[] => [
      "munich",
      "münchen",
      "muenchen",
      "garching",
      "gräfelfing",
      "graefelfing",
      "unterföhring",
      "unterfoehring",
      "kirchheim",
      "germering",
      "aschheim",
      "ottobrunn",
      "planegg",
      "martinsried",
      "neubiberg",
      "haar",
      "ismaning",
      "oberhaching",
      "vaterstetten",
      "putzbrunn",
      "pullach",
      "taufkirchen",
    ],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  // Relocation filter: regions / countries the candidate can legally work
  // remotely from.  When a job's location string contains a remote marker
  // ("Remote", "Anywhere", "Worldwide", …) AND a known region tag (any
  // country name from the world atlas or any region marker like EMEA /
  // APAC), the region MUST be in this list — otherwise the posting is
  // region-locked to a place the candidate cannot work from.
  //
  // Multi-tenant note: the default below encodes "EU/EEA resident".
  // For a Tokyo-based candidate, the user replaces it with e.g.
  // ["japan", "asia pacific", "apac", "worldwide"].
  relocationAccessibleRegions: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(100)).max(200),
    default: (): string[] => [
      // Anchor country + alternate spellings
      "germany",
      "deutschland",
      "de",
      // Adjacent home-base country with mutual work agreements
      "netherlands",
      "holland",
      "nl",
      // Regional umbrellas
      "europe",
      "european union",
      "european",
      "eu",
      "emea",
      // Worldwide / no-region markers
      "worldwide",
      "anywhere",
      "global",
      "distributed",
      // EU27 + EEA (candidate has free movement / can be hired remote into)
      "austria",
      "belgium",
      "bulgaria",
      "croatia",
      "cyprus",
      "czech",
      "czechia",
      "denmark",
      "estonia",
      "finland",
      "france",
      "greece",
      "hungary",
      "italy",
      "latvia",
      "lithuania",
      "luxembourg",
      "malta",
      "poland",
      "portugal",
      "romania",
      "slovakia",
      "slovenia",
      "spain",
      "sweden",
      "switzerland",
      "norway",
      "iceland",
    ],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  showSponsorInfo: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  renderMarkdownInJobDescriptions: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  chatStyleTone: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_TONE || "professional"
        : "professional",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleFormality: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_FORMALITY || "medium"
        : "medium",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleConstraints: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_CONSTRAINTS || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleDoNotUse: {
    kind: "typed" as const,
    schema: z.string().trim().max(1000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_DO_NOT_USE || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleSummaryMaxWords: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(500).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleMaxKeywordsPerSkill: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(50).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleLanguageMode: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_LANGUAGE_MODE_VALUES),
    default: (): ChatStyleLanguageMode =>
      parseChatStyleLanguageModeOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_LANGUAGE_MODE
          : undefined,
      ) ?? "manual",
    parse: parseChatStyleLanguageModeOrNull,
    serialize: (
      value: ChatStyleLanguageMode | null | undefined,
    ): string | null => value ?? null,
  },
  chatStyleManualLanguage: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_MANUAL_LANGUAGE_VALUES),
    default: (): ChatStyleManualLanguage =>
      parseChatStyleManualLanguageOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_MANUAL_LANGUAGE
          : undefined,
      ) ?? "english",
    parse: parseChatStyleManualLanguageOrNull,
    serialize: (
      value: ChatStyleManualLanguage | null | undefined,
    ): string | null => value ?? null,
  },
  backupEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  gmailSyncEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  gmailSyncIntervalHours: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(24),
    default: (): number => 2,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(24, Math.max(1, parsed));
    },
    serialize: serializeNullableNumber,
  },
  gmailAutoLinkConfidence: {
    kind: "typed" as const,
    schema: z.number().int().min(50).max(100),
    default: (): number => 95,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(100, Math.max(50, parsed));
    },
    serialize: serializeNullableNumber,
  },
  gmailNotifyConfidence: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => 70,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(100, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  gmailNotificationsEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  backupHour: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(23),
    default: (): number => 2,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(23, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  backupMaxCount: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(5),
    default: (): number => 5,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(5, Math.max(1, parsed));
    },
    serialize: serializeNullableNumber,
  },
  penalizeMissingSalary: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => {
      if (typeof process === "undefined") return false;
      const v = process.env.PENALIZE_MISSING_SALARY || "0";
      return v === "1" || v.toLowerCase() === "true";
    },
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  missingSalaryPenalty: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => {
      if (typeof process === "undefined") return 10;
      const raw = process.env.MISSING_SALARY_PENALTY;
      if (!raw) return 10;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? 10 : Math.min(100, Math.max(0, parsed));
    },
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  autoSkipScoreThreshold: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number | null => null,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: (value: number | null | undefined): string | null => {
      return value === null || value === undefined ? null : String(value);
    },
  },

  // --- Phase-1 ATS tailoring + matching flags (every risky feature OFF by
  // default; each is a single-flip rollback) ---
  // WS1: render tailored JOB PDFs single-column for max ATS parseability. Does
  // NOT change the user's editable base/design resume rendering.
  tailoredPdfSingleColumn: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  // WS1: page budget for tailored PDFs (used by the one-page trim pass).
  maxResumePages: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(5),
    default: (): number => 1,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  // WS1: rewrite experience bullets per-vacancy (provenance-guarded). Risky —
  // OFF by default until validated.
  tailorExperienceBullets: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  // WS1: parse the rendered PDF back and compute a keyword-coverage report.
  atsCoverageReportEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  // WS1: bump to force re-tailoring of already-processed jobs after a prompt
  // improvement (feeds the tailoring_fingerprint).
  tailoringPromptVersion: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 1,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  // WS2: job selection mode. "threshold" = current hard minSuitabilityScore
  // cutoff; "rank" = take top-N by rank to resist scoring drift.
  selectionMode: {
    kind: "typed" as const,
    schema: z.enum(["threshold", "rank"]),
    default: (): "threshold" | "rank" => "threshold",
    parse: createEnumParser(["threshold", "rank"]),
    serialize: (value: "threshold" | "rank" | null | undefined): string | null =>
      value ?? null,
  },
  // WS3: allow the bot to AI-draft screening-essay answers for user review.
  screeningDraftEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },

  // --- Smart Apply Answer Profile ---
  // Reusable answers to the questions almost every application asks that are
  // NOT on the resume: profile links, notice period, salary, years of
  // experience, sponsorship, demographic (EEO) handling. Smart Apply's prefill
  // reads these so the user stops re-typing the same values on every form.
  //
  // Multi-tenant: all defaults are neutral/empty. Nothing here encodes the
  // production candidate — each user fills their own via Settings.
  applyLinkedinUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(300),
    default: (): string | null => null,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  applyGithubUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(300),
    default: (): string | null => null,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  applyPortfolioUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(300),
    default: (): string | null => null,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  applyNoticePeriod: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string | null => null,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  applyDesiredSalary: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string | null => null,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  applyYearsExperience: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(60),
    default: (): number | null => null,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(60, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  // Tri-state on purpose: null = leave blank (user reviews it per job), true =
  // "I need sponsorship", false = "I do not need sponsorship". Only opt in when
  // the answer is genuinely constant across your target market.
  applyRequiresVisaSponsorship: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean | null => null,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  // When true, demographic / EEO questions (gender, race, veteran, disability)
  // default to the "Decline to self-identify" option, which every compliant
  // ATS offers. The user can still change it in the browser before submitting.
  applyDeclineDemographics: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },

  // --- Applied-Duplicate Filter (auto-skip reposted jobs) ---
  // When true, a discovered job that matches a role the user already applied
  // to (or is in-progress on) is auto-skipped before scoring, so the same
  // vacancy reposted to another board (or re-listed weeks later) does not
  // flood the feed or burn LLM budget. Marked `skipped`, never deleted.
  skipAppliedDuplicates: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  // Minimum title AND employer similarity (0-100) for two postings to count as
  // the same vacancy. 90 is the proven high-precision default; lower it to
  // catch reworded reposts at some false-positive risk.
  appliedDuplicateThreshold: {
    kind: "typed" as const,
    schema: z.number().int().min(50).max(100),
    default: (): number => 90,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(50, parsed));
    },
    serialize: serializeNullableNumber,
  },
  // How many days after applying a repost still counts as a duplicate. Beyond
  // this, a re-listing is treated as a genuinely new opening (companies do
  // re-open roles), so it is scored normally.
  appliedDuplicateWindowDays: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(365),
    default: (): number => 30,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(365, Math.max(1, parsed));
    },
    serialize: serializeNullableNumber,
  },

  // --- Pipeline Scheduling ---
  pipelineScheduleEnabled: {
    kind: "typed" as const,
    schema: z.preprocess(
      (v) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : v),
      z.boolean(),
    ),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  pipelineScheduleHour: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(23),
    default: (): number => 8,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  pipelineTopN: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(100),
    default: (): number => 20,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  pipelineMinScore: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => 35,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  pipelineAutoSkipBelow: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number | null => null,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: (value: number | null | undefined): string | null => {
      return value === null || value === undefined ? null : String(value);
    },
  },
  // Hard cap on LLM scoring calls per pipeline run. Newer (more recent
  // `discovered_at`) jobs win when the queue is over the cap; the rest
  // remain in `status='discovered'` and get scored on the next run.
  // Default 2000 jobs ≈ ~$35 per run on Claude Sonnet 4.6 — well inside
  // the $80/day Anthropic budget even with retries.
  pipelineMaxJobsToScore: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(20000),
    default: (): number => 2000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },

  // --- Model Variants ---
  modelScorer: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelTailoring: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelProjectSelection: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },

  // --- Simple Strings ---
  rxresumeBaseResumeId: {
    kind: "string" as const,
    schema: z.string().trim().max(200),
  },
  onboardingBasicAuthDecision: {
    kind: "string" as const,
    schema: z.enum(["enabled", "skipped"]),
  },
  rxresumeUrl: {
    kind: "string" as const,
    envKey: "RXRESUME_URL",
    schema: z.preprocess(
      (value) => (value === "" ? null : value),
      z.string().trim().url().max(2000).nullable(),
    ),
  },
  ukvisajobsEmail: {
    kind: "string" as const,
    envKey: "UKVISAJOBS_EMAIL",
    schema: z.string().trim().max(200),
  },
  adzunaAppId: {
    kind: "string" as const,
    envKey: "ADZUNA_APP_ID",
    schema: z.string().trim().max(200),
  },
  basicAuthUser: {
    kind: "string" as const,
    envKey: "BASIC_AUTH_USER",
    schema: z.string().trim().max(200),
  },

  // --- Secrets ---
  llmApiKey: {
    kind: "secret" as const,
    envKey: "LLM_API_KEY",
    schema: z.string().trim().max(2000),
  },
  rxresumeApiKey: {
    kind: "secret" as const,
    envKey: "RXRESUME_API_KEY",
    schema: z.string().trim().max(2000),
  },
  ukvisajobsPassword: {
    kind: "secret" as const,
    envKey: "UKVISAJOBS_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  adzunaAppKey: {
    kind: "secret" as const,
    envKey: "ADZUNA_APP_KEY",
    schema: z.string().trim().max(2000),
  },
  apifyToken: {
    kind: "secret" as const,
    envKey: "APIFY_TOKEN",
    schema: z.string().trim().max(2000),
  },
  basicAuthPassword: {
    kind: "secret" as const,
    envKey: "BASIC_AUTH_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  webhookSecret: {
    kind: "secret" as const,
    envKey: "WEBHOOK_SECRET",
    schema: z.string().trim().max(2000),
  },

  userTimezone: {
    kind: "typed" as const,
    schema: z.string().trim().max(50),
    default: (): string => "Europe/Berlin",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },

  // --- Telegram Bot ---
  telegramBotToken: {
    kind: "secret" as const,
    envKey: "TELEGRAM_BOT_TOKEN",
    schema: z.string().trim().max(200),
  },
  telegramAuthorizedChatIds: {
    kind: "typed" as const,
    schema: z.string().trim().max(500),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  telegramNotificationsEnabled: {
    kind: "typed" as const,
    schema: z.preprocess(
      (v) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : v),
      z.boolean(),
    ),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  telegramChangelogLastSentVersion: {
    kind: "string" as const,
    schema: z.string().trim().max(20),
  },

  // --- Aliases ---
  jobspyLocation: {
    kind: "alias" as const,
    schema: z.string().trim().max(100),
    target: "searchCities" as const,
  },

  // --- Virtual ---
  enableBasicAuth: {
    kind: "virtual" as const,
    schema: z.boolean(),
  },
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingsRegistryKey = keyof SettingsRegistry;
