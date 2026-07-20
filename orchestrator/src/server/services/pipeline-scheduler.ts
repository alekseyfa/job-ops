/**
 * Pipeline scheduler — fires the daily run at the user-configured hour in
 * their local timezone.
 *
 * Architecture: a minute-by-minute tick instead of one big setTimeout.
 *
 * Why: setTimeout(longDelay) is fragile in containers — it doesn't survive
 * Docker pause/resume, the host going to sleep, or wall-clock changes.
 * We also miss the firing window entirely if the container was down at
 * exactly the scheduled time.
 *
 * The tick approach is naturally idempotent and self-healing:
 *   - Every minute we check "should this slot have fired by now?"
 *   - We anchor "fired today" to `pipeline_runs.started_at` so a server
 *     restart in the middle of the day doesn't re-trigger a run that has
 *     already happened.
 *   - If we miss the scheduled minute (e.g. container down), the next tick
 *     after the schedule time still picks it up — within 60 s.
 *
 * For backups and visa-sponsor refresh we keep the shared `Scheduler`
 * abstraction (different reliability needs — those are cheap idempotent
 * jobs).  This module owns the pipeline-specific lifecycle.
 */

import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { runPipeline } from "../pipeline/orchestrator";
import { getLatestPipelineRun } from "../repositories/pipeline";
import * as settingsRepo from "../repositories/settings";
import { listTenants } from "../repositories/tenants";

const TICK_INTERVAL_MS = 60_000;

interface SchedulerState {
  /** Periodic check timer.  Null when scheduler is off. */
  interval: ReturnType<typeof setInterval> | null;
  /** True while a tick is mid-execution (prevents reentrancy). */
  tickInFlight: boolean;
  /** Per-tenant guard: tenantIds whose runPipeline() is mid-execution. */
  runInFlight: Set<string>;
  /** ISO timestamp of the next expected firing across all tenants (informational). */
  nextFireAt: string | null;
  /** True while the periodic loop is active. */
  running: boolean;
}

const state: SchedulerState = {
  interval: null,
  tickInFlight: false,
  runInFlight: new Set(),
  nextFireAt: null,
  running: false,
};

/** Per-tenant schedule config, resolved inside the tenant's request context. */
interface TenantSchedule {
  enabled: boolean;
  hour: number;
  timezone: string;
  topN: number;
  minScore: number;
}

async function readTenantSchedule(): Promise<TenantSchedule> {
  const enabledRaw = await settingsRepo.getSetting("pipelineScheduleEnabled");
  const hourRaw = await settingsRepo.getSetting("pipelineScheduleHour");
  const hour = parseInt(hourRaw || "8", 10);
  const safeHour = Number.isNaN(hour) ? 8 : Math.min(23, Math.max(0, hour));
  const timezone =
    (await settingsRepo.getSetting("userTimezone")) || "Europe/Berlin";
  const topN = parseInt(
    (await settingsRepo.getSetting("pipelineTopN")) || "10",
    10,
  );
  const minScore = parseInt(
    (await settingsRepo.getSetting("pipelineMinScore")) || "50",
    10,
  );
  return {
    enabled: enabledRaw === "true" || enabledRaw === "1",
    hour: safeHour,
    timezone,
    topN: Number.isNaN(topN) ? 10 : topN,
    minScore: Number.isNaN(minScore) ? 50 : minScore,
  };
}

// ---------- Time helpers (mirrors utils/scheduler.ts) ----------

function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asIfUtc = Date.UTC(
    parseInt(map.year, 10),
    parseInt(map.month, 10) - 1,
    parseInt(map.day, 10),
    parseInt(map.hour, 10),
    parseInt(map.minute, 10),
    parseInt(map.second, 10),
  );
  return asIfUtc - date.getTime();
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const offset = getTimezoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

/** Today's firing instant in UTC for the configured hour in the configured tz. */
function todaysFireInstant(now: Date, hour: number, timezone: string): Date {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = dateStr.split("-").map((s) => parseInt(s, 10));
  return zonedWallTimeToUtc(y, m, d, hour, timezone);
}

function nextFireInstantAfter(
  now: Date,
  hour: number,
  timezone: string,
): Date {
  // Walk forward day-by-day until we find a fire instant strictly in the future.
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(probe);
    const [y, m, d] = dateStr.split("-").map((s) => parseInt(s, 10));
    const candidate = zonedWallTimeToUtc(y, m, d, hour, timezone);
    if (candidate > now) return candidate;
  }
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

// ---------- Main loop ----------

/**
 * Evaluate one tenant's schedule and fire its pipeline if due. Runs entirely
 * inside the tenant's request context so every settings read, pipeline-run
 * lookup, and runPipeline() call is scoped to that tenant.
 */
async function tickTenant(tenantId: string, now: Date): Promise<string | null> {
  return runWithRequestContext({ tenantId }, async () => {
    const schedule = await readTenantSchedule();
    if (!schedule.enabled) return null;

    const { hour, timezone } = schedule;
    const nextFireAt = nextFireInstantAfter(now, hour, timezone).toISOString();
    const todaysFireAt = todaysFireInstant(now, hour, timezone);

    // Not yet past today's firing instant.
    if (now < todaysFireAt) return nextFireAt;

    // Already fired today? Anchor to this tenant's latest pipeline run — the DB
    // row survives restarts, unlike any in-memory flag.
    const latestRun = await getLatestPipelineRun();
    if (latestRun && new Date(latestRun.startedAt) >= todaysFireAt) {
      return nextFireAt;
    }

    // Avoid stacking runs if this tenant's previous tick is still running.
    if (state.runInFlight.has(tenantId)) {
      logger.debug("Pipeline scheduler tick skipped: run already in flight", {
        tenantId,
      });
      return nextFireAt;
    }

    state.runInFlight.add(tenantId);
    logger.info("Pipeline scheduler firing scheduled run", {
      tenantId,
      scheduledFor: todaysFireAt.toISOString(),
      actualFireAt: now.toISOString(),
      driftMs: now.getTime() - todaysFireAt.getTime(),
    });

    try {
      await runWithRequestContext({ pipelineRunId: "scheduled" }, async () => {
        const result = await runPipeline({
          topN: schedule.topN,
          minSuitabilityScore: schedule.minScore,
        });
        if (result.success) {
          logger.info("Scheduled pipeline completed", {
            tenantId,
            jobsDiscovered: result.jobsDiscovered,
            jobsProcessed: result.jobsProcessed,
          });
        } else {
          logger.warn("Scheduled pipeline failed", {
            tenantId,
            error: result.error,
          });
        }
      });
    } catch (err) {
      logger.error("Scheduled pipeline threw", {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      state.runInFlight.delete(tenantId);
    }
    return nextFireAt;
  });
}

async function tick(): Promise<void> {
  if (state.tickInFlight) return;
  state.tickInFlight = true;
  try {
    const now = new Date();
    const tenants = await listTenants();
    let earliestNextFire: string | null = null;

    for (const tenant of tenants) {
      try {
        const nextFireAt = await tickTenant(tenant.id, now);
        if (
          nextFireAt &&
          (earliestNextFire === null || nextFireAt < earliestNextFire)
        ) {
          earliestNextFire = nextFireAt;
        }
      } catch (err) {
        logger.error("Pipeline scheduler tenant tick failed", {
          tenantId: tenant.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Informational: soonest upcoming fire across all enabled tenants.
    state.nextFireAt = earliestNextFire;
  } catch (err) {
    logger.error("Pipeline scheduler tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.tickInFlight = false;
  }
}

function clearTick(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
}

/**
 * Start the periodic loop. Schedules are now per-tenant (resolved inside each
 * tenant's context in tickTenant), so the loop always runs once started and each
 * tenant self-gates via its own pipelineScheduleEnabled setting. Idempotent:
 * safe to call repeatedly (e.g. after a settings change) — it never double-starts.
 */
export async function initializePipelineScheduler(): Promise<void> {
  if (state.interval) {
    // Already running — the per-tenant schedule is re-read every tick, so
    // there's nothing cached to refresh.
    return;
  }

  state.running = true;
  state.interval = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  // First check after 30s so initialization noise settles. The tick is
  // idempotent (anchored to each tenant's latest pipeline_runs row), so a
  // restart near a scheduled time won't double-fire.
  setTimeout(() => {
    void tick();
  }, 30_000);

  logger.info("Pipeline scheduler started (per-tenant)", {
    tickEveryMs: TICK_INTERVAL_MS,
  });
}

/** Stop the periodic loop (used by tests and shutdown). */
export function stopPipelineScheduler(): void {
  clearTick();
  state.running = false;
  state.nextFireAt = null;
}

export function getPipelineSchedulerStatus(): {
  enabled: boolean;
  nextRun: string | null;
} {
  return {
    enabled: state.interval !== null,
    nextRun: state.nextFireAt,
  };
}

/**
 * Resolve the CURRENT tenant's schedule status. Must be called inside a tenant
 * request context (reads that tenant's own schedule settings). Returns the
 * tenant's own next-fire instant, not the global-earliest across tenants.
 */
export async function getTenantScheduleStatus(): Promise<{
  enabled: boolean;
  nextRun: string | null;
}> {
  const schedule = await readTenantSchedule();
  if (!schedule.enabled) return { enabled: false, nextRun: null };
  const nextRun = nextFireInstantAfter(
    new Date(),
    schedule.hour,
    schedule.timezone,
  ).toISOString();
  return { enabled: true, nextRun };
}
