import type { ExtractorManifest } from "@shared/types/extractors";

/**
 * ZipRecruiter job board extractor
 *
 * Fetches jobs from ZipRecruiter's public job feed/API.
 * High-value US startup and remote job board.
 */
export const manifest: ExtractorManifest = {
  id: "ziprecruiter",
  displayName: "ZipRecruiter",
  providesSources: ["ziprecruiter"],

  async run(context) {
    // Placeholder implementation - actual API integration in WS4-T5
    return { success: true, jobs: [] };
  },
};

export default manifest;
