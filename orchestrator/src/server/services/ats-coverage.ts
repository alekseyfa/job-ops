/**
 * Parse-back ATS coverage report (WS1-T5).
 *
 * After a tailored PDF is rendered we read its text back out and measure how
 * much of the job description's weighted keyword set actually made it into the
 * document. This is the closest honest proxy we have to "did the resume survive
 * an ATS parse" — it is computed from the RENDERED artifact, not the source
 * data, which is strictly more truthful than competitors who score source text.
 *
 * IMPORTANT: coveragePct is an INTERNAL HEURISTIC, not a real ATS score.
 * pdf-parse reconstructs reading order with its own rules, which do not match
 * Workday/Taleo/Greenhouse parsers. See orchestrator/docs/ats-calibration.md.
 *
 * `computeAtsCoverage` is pure (text in, report out) so it is fully unit
 * testable without rendering a real PDF; the pdf-parse extraction lives in a
 * thin separate function the caller invokes.
 */

import { readFile } from "node:fs/promises";
import { logger } from "@infra/logger";
import type { TailoringReport } from "@shared/types";
import type { WeightedJdKeyword } from "./jd-keywords";
import { isSupported, type ProvenanceIndex } from "./tailoring-provenance";

/** Standard ATS section headers we expect a parseable resume to expose. */
const SECTION_PATTERNS: Record<keyof TailoringReport["sectionsDetected"], RegExp> =
  {
    experience: /\b(experience|employment|work history)\b/i,
    education: /\b(education|academic)\b/i,
    skills: /\b(skills|technologies|competencies)\b/i,
  };

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Compute the coverage report from already-extracted resume text.
 *
 * coveragePct = sum(weight of keywords found in the text) / sum(all weights),
 * so hard-skill/title keywords (weight 3) move the number more than soft ones.
 * missingKeywords are the JD keywords NOT found in the text — and, when a
 * provenance index is supplied, restricted to those the candidate's resume
 * actually supports (the actionable "you have this, surface it" list, never a
 * "go fabricate this" list).
 */
export function computeAtsCoverage(
  resumeText: string,
  keywords: WeightedJdKeyword[],
  provenanceIndex?: ProvenanceIndex,
): TailoringReport {
  const haystack = normalizeForMatch(resumeText);

  let totalWeight = 0;
  let coveredWeight = 0;
  const missing: string[] = [];

  for (const kw of keywords) {
    totalWeight += kw.weight;
    const present = haystack.includes(normalizeForMatch(kw.term));
    if (present) {
      coveredWeight += kw.weight;
    } else if (!provenanceIndex || isSupported(kw.term, provenanceIndex)) {
      // Only suggest adding keywords the candidate can truthfully claim.
      missing.push(kw.term);
    }
  }

  const coveragePct =
    totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0;

  const sectionsDetected = {
    experience: SECTION_PATTERNS.experience.test(resumeText),
    education: SECTION_PATTERNS.education.test(resumeText),
    skills: SECTION_PATTERNS.skills.test(resumeText),
  };

  return {
    coveragePct,
    sectionsDetected,
    missingKeywords: missing.slice(0, 20),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Extract plain text from a rendered PDF. Uses pdf-parse via a lazy import so
 * a parse failure (or a missing dependency) is NON-FATAL — it returns null and
 * the caller simply skips the coverage report rather than failing PDF
 * generation. Imports the library entry directly to avoid pdf-parse's
 * debug-mode test-fixture read on import.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    // Computed specifier so the bundler/test transformer doesn't statically
    // resolve pdf-parse at load time (it's an optional runtime dependency).
    const moduleId = "pdf-parse/lib/pdf-parse.js";
    const mod = (await import(/* @vite-ignore */ moduleId)) as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const pdfParse = mod.default;
    const buffer = await readFile(pdfPath);
    const parsed = await pdfParse(buffer);
    return parsed.text ?? null;
  } catch (error) {
    logger.warn("ATS coverage: failed to extract PDF text (non-fatal)", {
      pdfPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
