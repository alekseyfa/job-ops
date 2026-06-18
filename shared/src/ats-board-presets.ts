/**
 * ATS Board Preset Catalog
 *
 * Curated collections of high-value remote-first company boards across
 * Greenhouse, Ashby, and Lever platforms. Presets are shared read-only
 * catalogs; users activate them via the `activeAtsBoardPresets` setting.
 *
 * Multi-tenant-safe: all entries are neutral (well-known public companies),
 * no single-user company preferences.
 */

export interface AtsBoardPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly entries: ReadonlyArray<{
    readonly provider: "greenhouse" | "ashby" | "lever";
    readonly slug: string;
  }>;
}

/**
 * Preset catalog: curated collections of high-value remote-first employers.
 * Ordered by relevance: top-remote-first (broadest), yc-unicorns (growth-stage),
 * dev-tools (infrastructure/developer tooling focus).
 */
export const ATS_BOARD_PRESET_CATALOG: ReadonlyArray<AtsBoardPreset> = [
  {
    id: "top-remote-first",
    name: "Top Remote-First Companies",
    description:
      "Leading remote-first employers across infrastructure, AI, productivity, and developer tools (~35 companies)",
    entries: [
      // Infrastructure & Cloud
      { provider: "greenhouse", slug: "stripe" },
      { provider: "greenhouse", slug: "datadog" },
      { provider: "greenhouse", slug: "hashicorp" },
      { provider: "lever", slug: "sentry" },
      { provider: "greenhouse", slug: "cloudflare" },
      { provider: "greenhouse", slug: "digitalocean" },
      { provider: "greenhouse", slug: "auth0" },

      // AI & Research
      { provider: "greenhouse", slug: "anthropic" },
      { provider: "greenhouse", slug: "openai" },
      { provider: "lever", slug: "huggingface" },
      { provider: "ashby", slug: "perplexity" },

      // Developer Tools & Platforms
      { provider: "greenhouse", slug: "vercel" },
      { provider: "greenhouse", slug: "gitlab" },
      { provider: "lever", slug: "github" },
      { provider: "greenhouse", slug: "netlify" },
      { provider: "greenhouse", slug: "planetscale" },
      { provider: "ashby", slug: "supabase" },
      { provider: "greenhouse", slug: "render" },

      // Productivity & Collaboration
      { provider: "greenhouse", slug: "notion" },
      { provider: "greenhouse", slug: "linear" },
      { provider: "greenhouse", slug: "miro" },
      { provider: "lever", slug: "figma" },
      { provider: "greenhouse", slug: "loom" },
      { provider: "lever", slug: "airtable" },

      // Remote-Native Pioneers
      { provider: "greenhouse", slug: "automattic" },
      { provider: "greenhouse", slug: "gitlab" },
      { provider: "lever", slug: "buffer" },
      { provider: "greenhouse", slug: "doist" },
      { provider: "greenhouse", slug: "zapier" },

      // Fintech & Payments
      { provider: "greenhouse", slug: "plaid" },
      { provider: "ashby", slug: "ramp" },
      { provider: "greenhouse", slug: "brex" },
      { provider: "greenhouse", slug: "mercury" },

      // Security & Infrastructure
      { provider: "greenhouse", slug: "1password" },
      { provider: "ashby", slug: "tailscale" },
    ],
  },
  {
    id: "yc-unicorns",
    name: "YC Unicorns",
    description:
      "Y Combinator-backed unicorns with strong engineering cultures (~15 companies)",
    entries: [
      { provider: "greenhouse", slug: "coinbase" },
      { provider: "greenhouse", slug: "stripe" },
      { provider: "greenhouse", slug: "airbnb" },
      { provider: "lever", slug: "doordash" },
      { provider: "greenhouse", slug: "instacart" },
      { provider: "greenhouse", slug: "faire" },
      { provider: "greenhouse", slug: "brex" },
      { provider: "lever", slug: "flexport" },
      { provider: "greenhouse", slug: "gusto" },
      { provider: "greenhouse", slug: "rippling" },
      { provider: "ashby", slug: "ramp" },
      { provider: "greenhouse", slug: "scale" },
      { provider: "greenhouse", slug: "lattice" },
      { provider: "lever", slug: "gitlab" },
      { provider: "greenhouse", slug: "checkr" },
    ],
  },
  {
    id: "dev-tools",
    name: "Developer Tools & Infrastructure",
    description:
      "Companies building tools for developers: observability, databases, CI/CD, IaC (~12 companies)",
    entries: [
      { provider: "greenhouse", slug: "datadog" },
      { provider: "lever", slug: "sentry" },
      { provider: "greenhouse", slug: "hashicorp" },
      { provider: "greenhouse", slug: "planetscale" },
      { provider: "ashby", slug: "supabase" },
      { provider: "greenhouse", slug: "vercel" },
      { provider: "greenhouse", slug: "netlify" },
      { provider: "greenhouse", slug: "render" },
      { provider: "greenhouse", slug: "gitlab" },
      { provider: "lever", slug: "github" },
      { provider: "greenhouse", slug: "launchdarkly" },
      { provider: "greenhouse", slug: "buildkite" },
    ],
  },
];

/**
 * Retrieve a preset by its ID.
 * @param id - Preset identifier (kebab-case)
 * @returns Preset object if found, null otherwise
 */
export function getPresetById(id: string): AtsBoardPreset | null {
  return ATS_BOARD_PRESET_CATALOG.find((preset) => preset.id === id) ?? null;
}
