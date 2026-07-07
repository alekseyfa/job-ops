import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { assessJobLegitimacy } from "@server/services/ghost-job-detector";

/** Reason recorded on jobs skipped for failing the ghost-job legitimacy check. */
export const GHOST_JOB_SKIP_REASON =
  "Skipped — flagged as a likely ghost / dead posting (no description, deadline passed, or evergreen repost)";

/**
 * Auto-skip discovered jobs the ghost-job detector rates as `red` (dead /
 * evergreen / no-description postings) BEFORE they reach the LLM scorer.
 *
 * The legitimacy heuristic is cheap and IO-free (no LLM, no network), so
 * running it here as a pre-filter saves scoring tokens on jobs the system
 * already knows are low-signal — previously these were assessed only AFTER
 * the (paid) scoring call and could still be surfaced to the user.
 *
 * Marks as `skipped` (never deletes) so the user can still inspect them in
 * "All Jobs". Only ever touches `discovered` jobs — applied/in_progress/ready
 * user-investment jobs are never considered (getUnscoredDiscoveredJobs scopes
 * to discovered + unscored).
 */
export async function filterGhostJobsStep(): Promise<{ markedCount: number }> {
  const discovered = await jobsRepo.getUnscoredDiscoveredJobs();
  if (discovered.length === 0) return { markedCount: 0 };

  const toSkip = discovered.filter(
    (job) => assessJobLegitimacy(job).tier === "red",
  );
  if (toSkip.length === 0) {
    return { markedCount: 0 };
  }

  const marked = await jobsRepo.markJobsSkippedWithReason(
    toSkip.map((j) => j.id),
    GHOST_JOB_SKIP_REASON,
  );
  logger.info("Ghost-job filter: auto-skipped likely dead postings", {
    candidates: discovered.length,
    marked,
  });
  return { markedCount: marked };
}
