# Job-Ops – Agent Instructions

> Applies to all AI agents (Claude Code, Gemini CLI, OpenCode, Cursor, Codex).

## Project Overview

Monorepo (orchestrator, shared, extractors, docs-site) for automated job search and application tracking. Node.js 22, Express, React, SQLite (Drizzle ORM), Docker. **Primary UI: Telegram bot.**

## Environment

- **No node/npm on host.** All commands run inside Docker.
- Docker image: `node:22-slim` for quick checks, `docker compose` for full stack.
- Corporate proxy: set `HTTP_PROXY` / `HTTPS_PROXY` in `.env` if needed (routed through a global undici dispatcher at startup — see `config/proxy.ts`). For TLS-intercepting proxies, mount a CA bundle and set `NODE_EXTRA_CA_CERTS`.
- **Windows path spaces**: prefix all docker commands with `MSYS_NO_PATHCONV=1`.

## Mandatory: No Personal or Sensitive Data in Commits

Never commit real email addresses, personal names, employer names, internal hostnames, API keys, tokens, or proxy URLs. Use generic placeholders (`your-email@example.com`, `set ENV_VAR`, `your company`, etc.). Test fixtures must use `"Jane Doe"` / `"Test User"` / `@example.com`. If you spot sensitive data already in tracked files, remove it before committing anything else.

## Mandatory: Validate Before Reporting Done

**Never report work as done without validation.** Run inside Docker:

```bash
# Type check
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo-path>:/app" -w /app node:22-slim \
  sh -c "npx tsc --noEmit -p shared/tsconfig.json && npx tsc --noEmit -p orchestrator/tsconfig.json"

# Unit tests
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo-path>:/app" -w /app node:22-slim \
  sh -c "./orchestrator/node_modules/.bin/vitest run"
```

Pre-existing errors in `linkedin-auto-apply` are known/acceptable. No new errors.

### Never Delete Tests

Never `git rm` or overwrite a `*.test.ts`/`*.spec.ts` unless the user explicitly approves. Fix code or update assertions instead. Ask before deleting a test for a removed feature.

### Dead Code Deletion: Always Verify by Exported Symbol, Not Filename

`git grep` for the *filename* misses imports by *symbol name* (e.g. a file exporting `isHttpUrl` is imported as `import { isHttpUrl } from "@infra/public-url"` — the path string may not appear in the importer). **Before deleting any source file as "dead":**

1. Run `graphify query "<exported symbol names from the file>"` to check for inbound semantic edges in the knowledge graph.
2. Then verify with `git grep "<symbol>"` as a backup.
3. Both must return zero hits outside the file itself before deleting.

This applies even when knip or other static tools claim the file is unused — they may not resolve path aliases or dynamic imports correctly. Deleting a file with hidden consumers breaks server startup and locks out all users.

### Pipeline Integrity Gate

If touching anything under `orchestrator/src/server/pipeline/`, `services/job-screening*`, `services/relocation-filter*`, or `services/resume-keywords-loader*`, also run:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo-path>:/app" -w /app node:22-slim \
  sh -c "cd orchestrator && ./node_modules/.bin/vitest run \
    src/server/pipeline/step-ordering.test.ts \
    src/server/services/job-screening.test.ts \
    src/server/services/relocation-filter.test.ts"
```

All three must pass. If you change the pipeline contract, update both the test AND `### Pipeline Step Ordering` below in the same commit.

## Mandatory: Changelog Notifications

After user-facing changes, ask: *"Should I add this to the changelog?"*. If yes, add to `orchestrator/src/server/services/telegram-bot/changelog.ts` (newest first): `version`, `date` (YYYY-MM-DD), `items[]` with `title` (emoji + name), `description` (plain language, 1–2 sentences), optional `tip`.

## Mandatory: Multi-User First Design

Every change must work for a different user with a different resume, city, language set, without code edits.

- **Never hardcode** candidate identity, languages, skills, or city. Read from: `candidate-profile.ts` (identity), `resume-keywords-loader.ts` (keywords/languages), `settings-registry.ts` via `getEffectiveSettings()` (preferences).
- **Test fixtures**: use `"Jane Doe"` / `"Test User"`, neutral skills, non-production city.
- **Filters must be `(job, candidateContext) → decision`**, not read module-scope constants.
- New geo/domain predicates: accept as arguments, add a `TODO(multi-tenant)` constant + unit test proving it inverts.

**Known debt — do NOT extend:** `ANTI_DOMAIN_PATTERNS` in `services/job-screening.ts` (single-tenant career filter). Relocation filter is already multi-tenant via settings.

## Architecture

### Telegram Bot

- Grammy, long-polling. Handlers in `telegram-bot/handlers/`.
- Callback prefixes: `j:` jobs, `p:` pipeline, `s:` stats, `x:` settings, `b:` boards, `m:` menu, `sa:` smart-apply, `g:` gmail.
- Main menu via single `sendMainMenu()` helper — do NOT add duplicate menu keyboards in other handlers.
- Auth via `/link <code>` with one-time codes.

### Smart Apply (Greenhouse + Ashby)

Server-side Playwright (headed Firefox on `:99`) → parses + pre-fills form → hands to user via noVNC.

**Safety invariants — preserve:**
- **Single-session guard**: `active: ActiveBrowserSession | null` in `session.ts`.
- **15-min viewer TTL** with auto-teardown; `expireStaleSessions()` on startup.
- **Token-scoped noVNC URLs** — never expose raw VNC port.
- **No captcha defeat** — detect and tell user to solve manually.
- **No auto-submit** — user submits manually; detect via URL transition to success route.
- Work-authorization questions are **never auto-answered** (legal risk).
- Visa sponsorship is **opt-in tri-state** (`null` = leave blank).
- Eligibility = source `greenhouse`/`ashby` OR URL matches regexes in `eligibility.ts`. New ATS = add parser + eligibility branch, don't touch `session.ts`.

### Answer Profile

Settings-backed (`apply*` keys in `settings-registry.ts`). `prefill.ts` calls `attachProfile()` after `attachResume`, before `attachBasic`. Multi-tenant safe — no defaults encode user data.

### Pipeline Step Ordering

Order: `discoverJobs` → `preImportLiveness` → `importJobs` → `filterRelocation` → `filterAppliedDuplicates` → `filterAntiDomain` → `filterGhostJobs` → `checkLiveness` → `scoreJobs` → `selectJobs` → `processJobs`.

- Auto-skip-below-threshold runs **inside** `scoreJobsStep` only. No second pass in `orchestrator.ts`.
- Insert new filter steps **before `scoreJobs`** (LLM is cost/rate bottleneck).
- **Do NOT silently remove filter steps.** Each gates a class of garbage; removal compiles clean but breaks the pipeline.
- Before deleting any file under `pipeline/` or `services/{job-screening,relocation-filter,resume-keywords-loader,scorer,llm-errors}.ts`: run `git grep -l <basename>` and redirect all importers.
- **If you add a pipeline step, update FOUR places:**
  1. `pipeline/steps/index.ts` (re-export)
  2. `pipeline/orchestrator.ts` (call site)
  3. `pipeline/step-ordering.test.ts` (add to `REQUIRED_ORDER`)
  4. `shared/src/types/pipeline.ts` (new counter if needed)

### LLM Error Contract

Two classes in `services/llm-errors.ts`:
- `LlmNotConfiguredError` — config problem; orchestrator pauses run.
- `LlmTransientError` — per-call failure; step skips that job and continues.

**Rules:**
- New LLM call sites MUST route failures through `classifyLlmError(rawError)`.
- Escalate to `LlmNotConfiguredError` only after transient failures exceed 30% of ≥5 attempts.
- **Never re-introduce a `mockScore` fallback.**

### Relocation Filter

`requiresRelocation(job, config)` — config built at runtime from `relocationHomeCities` + `relocationAccessibleRegions` settings. Already multi-tenant. Country-only locations with `isRemote=false` → treated as relocation.

### Applied-Duplicate Filter

`findAppliedDuplicateMatch(job, candidates, config?)` in `applied-duplicate-matching.ts`. Threshold (default 90) and window (default 30 days) from settings. Runs after relocation, before anti-domain. Beyond `appliedDuplicateWindowDays` a re-listing is treated as a new opening.

### Job Screening

Three gates in `screenJob(job, resumeKeywords)`:
1. **Anti-domain** (title regex) — wins over all other signals.
2. **Language gate** — hard-require language not in candidate's resume → skip. Soft mentions pass.
3. **Resume signal** — keep if ≥1 keyword overlap; falls open when resume is empty.

Resume is the source of truth for languages — do not add a separate setting.

### Candidate Identity

Single source of truth: uploaded design resume. Read via `getCandidateBasics()` / `getCandidateNameParts()` in `candidate-profile.ts` (60s cache). **Never** use `ctx.from.first_name` or env vars or hardcoded strings.

### Pipeline Scheduler

Periodic-check pattern (ticks every 60s, idempotent) — NOT a long `setTimeout`. Self-heals across restarts. Only the pipeline uses this loop; backups use the shared `Scheduler` abstraction.

### Stale Jobs Cleanup

Daily 3 AM UTC. Removes `discovered`/`skipped`/`expired` jobs older than 90 days. **Never touches** `applied`/`in_progress`/`ready` — preserve this invariant in all pruning logic.

### LLM Providers

9 providers in `services/llm/providers/`. Factory via `createProviderStrategy`. Per-purpose model mix resolved in `modelSelection.ts:resolveLlmModel()`.

**Claude via AWS Bedrock:** set `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` (optional `ANTHROPIC_MODEL`). This env toggle short-circuits the DB-backed provider/model settings in `createConfiguredLlmService()` and `resolveLlmModel()`. The `bedrock` provider is env-only — deliberately not selectable in the settings UI.

### Cost Guard Rails

- `pipelineMaxJobsToScore` (default 2000) caps LLM calls per run.
- Job description truncated at 8 KB (`JOB_DESCRIPTION_MAX_CHARS = 8000`) in `scorer.ts` and `summary.ts` — keep in sync.
- Watch the AWS Bedrock spend/quota for the account behind `AWS_BEARER_TOKEN_BEDROCK`.

### Extractors

- Each is a workspace package in `extractors/<name>/` exporting `ExtractorManifest` from `manifest.ts`.
- Register source IDs in `shared/src/extractors/index.ts`.
- **Adding a new extractor: also add it to the Dockerfile** (both build and production stages).

### Settings

Defined in `shared/src/settings-registry.ts` (Zod schemas). New settings must be registered there; `SettingKey` is derived from registry keys.

## Common Pitfalls

- **Docker path spaces**: `MSYS_NO_PATHCONV=1` on Windows/Git Bash for all docker commands.
- **New extractor not loading**: check Dockerfile AND `shared/src/extractors/index.ts`.
- **New setting not recognized**: must be in `shared/src/settings-registry.ts`.
- **`docker compose restart` does NOT pick up source changes** — rebuild or `docker cp` changed files.
- **Type errors in `Record<ExtractorSourceId, ...>`**: also update `demo-defaults.data.ts` and `extractor-health.ts`.
- **One-off DB scripts** (`scripts/*.cjs`): use `require("/app/orchestrator/node_modules/better-sqlite3")`, always back up first (`cp jobs.db jobs.db.bak-$(date +%Y%m%d-%H%M%S)`), **delete after applying** (one-shots only — tools/diagnostics stay).
- **Never delete `applied`/`in_progress`/`ready` jobs** — they represent user investment.

## Karpathy Coding Principles

1. **Think first**: state assumptions, surface tradeoffs, ask if ambiguous.
2. **Simplicity**: minimum code, nothing speculative, no unasked abstractions.
3. **Surgical changes**: touch only what the task requires.
4. **Goal-driven**: define success criteria before writing code; loop until verified.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
