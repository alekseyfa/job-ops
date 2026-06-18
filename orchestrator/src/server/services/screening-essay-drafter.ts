/**
 * Screening essay drafter - AI service for drafting screening question answers.
 *
 * When a Smart Apply session detects a free-text screening question (textarea),
 * this service drafts a brief, professional answer based on the candidate's
 * design resume + job context. The draft is shown to the user in Telegram for
 * editing before submission.
 *
 * Warm cache: checks the screening_answers table for an existing answer to the
 * same normalized question first. If found, reuses it (increments usedCount).
 * Otherwise, calls the LLM and persists the draft for future reuse.
 *
 * LLM error contract: throws LlmNotConfiguredError (config problem) or
 * LlmTransientError (per-call failure) on LLM failures, same as scorer.ts.
 */

import { logger } from "@infra/logger";
import type { Job } from "@shared/types";
import { getCandidateBasics } from "./candidate-profile";
import { getLatestDesignResumeDocument } from "../repositories/design-resume";
import {
  getAnswerByNormalizedQuestion,
  createOrUpdateScreeningAnswer,
} from "../repositories/screening-answers";
import {
  classifyLlmError,
  LlmNotConfiguredError,
  LlmTransientError,
} from "./llm-errors";
import type { JsonSchemaDefinition } from "./llm/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";

export { LlmNotConfiguredError, LlmTransientError };

export interface DraftAnswerInput {
  question: string;
  hint: string | undefined;
  job: Pick<Job, "id" | "title" | "employer" | "jobDescription">;
}

export interface DraftAnswerResult {
  success: boolean;
  answer?: string;
  fromCache: boolean;
  error?: string;
}

/**
 * Normalize a question for cache key matching.
 * Lowercase + whitespace-collapsed. Two questions with identical normalized
 * form are treated as duplicates.
 */
function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

const DRAFT_SCHEMA: JsonSchemaDefinition = {
  name: "screening_essay",
  schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "Essay answer, 2-4 sentences, professional tone",
      },
    },
    required: ["answer"],
    additionalProperties: false,
  },
};

/**
 * Draft a screening essay answer via LLM, with warm cache.
 *
 * Flow:
 * 1. Check screening_answers table for existing answer to this normalized question.
 * 2. If found, increment usedCount and return cached answer.
 * 3. Otherwise, load candidate basics + design resume.
 * 4. Call LLM with tailoring model (same quality level as cover letters).
 * 5. Persist draft to screening_answers and return.
 *
 * Throws:
 * - LlmNotConfiguredError: missing API key, 401/403, no provider configured.
 * - LlmTransientError: 5xx, 429, garbage JSON for this single call.
 */
export async function draftScreeningAnswer(
  input: DraftAnswerInput,
): Promise<DraftAnswerResult> {
  const normalized = normalizeQuestion(input.question);

  // Warm cache: check for existing answer.
  const existing = await getAnswerByNormalizedQuestion(normalized);
  if (existing) {
    logger.info("Screening essay: reusing cached answer", {
      questionNormalized: normalized,
      timesUsed: existing.timesUsed,
    });
    // Increment usedCount (upsert with same answer).
    await createOrUpdateScreeningAnswer({
      questionNormalized: normalized,
      questionLabel: input.question,
      answer: existing.answer,
    });
    return { success: true, answer: existing.answer, fromCache: true };
  }

  // Cold path: draft with LLM.
  const basics = await getCandidateBasics();
  const resumeDoc = await getLatestDesignResumeDocument();
  if (!resumeDoc) {
    return {
      success: false,
      error: "Design resume not found. Upload a resume to draft answers.",
      fromCache: false,
    };
  }

  const model = await resolveLlmModel("tailoring"); // Use tailoring model for quality.
  const llm = createConfiguredLlmService({ overrideModel: model });

  // Truncate resume JSON to 3000 chars to keep prompt lean + reduce hallucination.
  const resumeSnippet = JSON.stringify(resumeDoc.resumeJson).slice(0, 3000);

  const prompt = `You are drafting a screening question answer for a job application.

Question: "${input.question}"${input.hint ? `\nHint: ${input.hint}` : ""}

Job: ${input.job.title} at ${input.job.employer}
Candidate: ${basics.name ?? "Candidate"}${basics.headline ? `, ${basics.headline}` : ""}

Draft a brief (2-4 sentences), professional, truthful answer based ONLY on the candidate's resume. Do not invent skills or experience not present in the resume. If the resume doesn't contain relevant information for this question, draft a generic but professional answer that acknowledges interest in the role.

Resume (first 3000 chars):
${resumeSnippet}

Output only the answer text, no preamble or explanation.`;

  try {
    const resp = await llm.callJson({
      model,
      messages: [{ role: "user", content: prompt }],
      jsonSchema: DRAFT_SCHEMA,
      maxRetries: 1,
      jobId: input.job.id,
    });

    if (!resp.success) {
      const classified = classifyLlmError(new Error(resp.error ?? "LLM call failed"));
      throw classified;
    }

    const answer = resp.data.answer;

    // Persist draft for future reuse.
    await createOrUpdateScreeningAnswer({
      questionNormalized: normalized,
      questionLabel: input.question,
      answer,
      sourceJobId: input.job.id,
    });

    logger.info("Screening essay: drafted and persisted new answer", {
      questionNormalized: normalized,
      jobId: input.job.id,
    });

    return { success: true, answer, fromCache: false };
  } catch (err) {
    // Re-throw LlmNotConfiguredError / LlmTransientError as-is.
    if (
      err instanceof LlmNotConfiguredError ||
      err instanceof LlmTransientError
    ) {
      throw err;
    }
    // Unexpected error — wrap as transient.
    logger.error("Screening essay drafter: unexpected error", { error: err });
    throw new LlmTransientError(
      `Unexpected error drafting answer: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}
