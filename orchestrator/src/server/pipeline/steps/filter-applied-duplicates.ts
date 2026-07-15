import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import {
  type AppliedDuplicateConfig,
  DEFAULT_APPLIED_DUPLICATE_CONFIG,
  findAppliedDuplicateMatch,
} from "@server/services/applied-duplicate-matching";
import { getEffectiveSettings } from "@server/services/settings";

export const APPLIED_DUPLICATE_SKIP_REASON =
  "Skipped — you already applied to this role (reposted / re-listed).";

/**
 * Auto-skip discovered jobs that are reposts of a role the user already
 * applied to (or is in-progress on).
 *
 * The same vacancy is routinely re-listed weeks later or cross-posted to a
 * board we crawl on a different day, so it slips past the exact-URL dedup and
 * shows up again in the feed. This step matches each discovered job against the
 * user's `applied` / `in_progress` history (title AND employer similarity above
 * a threshold, within a recency window of the original application) and demotes
 * matches to `skipped` — before scoring, so reposts never burn LLM budget.
 *
 * Runs after relocation, before anti-domain. Marks rather than deletes so the
 * user can still inspect skipped reposts in "All Jobs". Never touches
 * applied / in_progress / ready jobs (findAppliedDuplicateMatch only considers
 * `discovered` inputs and historical candidates).
 *
 * Fully settings-driven (`skipAppliedDuplicates`, `appliedDuplicateThreshold`,
 * `appliedDuplicateWindowDays`) — no hardcoded user data, so it behaves
 * correctly for any candidate.
 */
export async function filterAppliedDuplicatesStep(): Promise<{
  markedCount: number;
}> {
  const settings = await getEffectiveSettings();
  if (settings.skipAppliedDuplicates?.value === false) {
    return { markedCount: 0 };
  }

  const discovered = await jobsRepo.getUnscoredDiscoveredJobs();
  if (discovered.length === 0) return { markedCount: 0 };

  const candidates = await jobsRepo.getAppliedDuplicateMatchCandidates();
  if (candidates.length === 0) {
    // Nothing applied yet — nothing can be a repost.
    return { markedCount: 0 };
  }

  const config: AppliedDuplicateConfig = {
    threshold:
      settings.appliedDuplicateThreshold?.value ??
      DEFAULT_APPLIED_DUPLICATE_CONFIG.threshold,
    windowMs:
      (settings.appliedDuplicateWindowDays?.value ?? 30) *
      24 *
      60 *
      60 *
      1000,
  };

  const toSkip = discovered.filter(
    (job) => findAppliedDuplicateMatch(job, candidates, config) !== null,
  );
  if (toSkip.length === 0) {
    logger.info("Applied-duplicate filter: no reposts of applied jobs found", {
      candidates: discovered.length,
      appliedHistory: candidates.length,
    });
    return { markedCount: 0 };
  }

  const marked = await jobsRepo.markJobsSkippedWithReason(
    toSkip.map((j) => j.id),
    APPLIED_DUPLICATE_SKIP_REASON,
  );
  logger.info("Applied-duplicate filter: auto-skipped reposts of applied jobs", {
    candidates: discovered.length,
    appliedHistory: candidates.length,
    marked,
    threshold: config.threshold,
    windowDays: Math.round(config.windowMs / (24 * 60 * 60 * 1000)),
  });
  return { markedCount: marked };
}
