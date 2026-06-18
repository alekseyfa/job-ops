import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import type { CreateJobInput } from "@shared/types";
import { progressHelpers } from "../progress";

export async function importJobsStep(args: {
  discoveredJobs: CreateJobInput[];
}): Promise<{
  created: number;
  skipped: number;
  crossPostingDeduplicated: number;
}> {
  logger.info("Importing discovered jobs");
  const { created, skipped, crossPostingDeduplicated } =
    await jobsRepo.createJobs(args.discoveredJobs);
  logger.info("Import step complete", {
    created,
    skipped,
    crossPostingDeduplicated,
  });

  progressHelpers.importComplete(created, skipped);

  return { created, skipped, crossPostingDeduplicated };
}
