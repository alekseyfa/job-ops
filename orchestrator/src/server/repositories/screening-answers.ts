/**
 * Screening answers repository - CRUD for reusable screening essay answers.
 *
 * When a user answers a free-text application question (e.g., "Why do you want
 * this role?"), we persist it keyed by the normalized question text + tenantId
 * so future applications to similar roles can reuse the same essay. This saves
 * the user from rewriting the same answer multiple times.
 *
 * Question normalization: lowercase + whitespace-collapsed. Two questions with
 * identical normalized form are treated as duplicates (acceptable trade-off —
 * collisions are rare and users can edit the draft if it doesn't fit).
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { getActiveTenantId } from "../tenancy/context";

const { screeningAnswers } = schema;

export interface ScreeningAnswerRecord {
  id: string;
  questionNormalized: string;
  questionLabel: string;
  answer: string;
  sourceJobId: string | null;
  timesUsed: number;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: typeof screeningAnswers.$inferSelect): ScreeningAnswerRecord {
  return {
    id: row.id,
    questionNormalized: row.questionNormalized,
    questionLabel: row.questionLabel,
    answer: row.answer,
    sourceJobId: row.sourceJobId,
    timesUsed: row.timesUsed ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Retrieve an existing answer by normalized question text.
 * Scoped to the active tenant.
 */
export async function getAnswerByNormalizedQuestion(
  questionNormalized: string,
): Promise<ScreeningAnswerRecord | null> {
  const tenantId = getActiveTenantId();
  const rows = await db
    .select()
    .from(screeningAnswers)
    .where(
      and(
        eq(screeningAnswers.tenantId, tenantId),
        eq(screeningAnswers.questionNormalized, questionNormalized),
      ),
    )
    .limit(1);

  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Create or update a screening answer (upsert).
 * - On first insert: sets answer, timesUsed=1, sourceJobId (if provided).
 * - On conflict (tenant + questionNormalized already exists): updates answer,
 *   increments timesUsed, bumps updatedAt.
 *
 * Returns the upserted record.
 *
 * Note: Drizzle SQLite doesn't have native upsert with returning, so we use
 * select-then-insert-or-update pattern (same as jobs.ts:createJobs).
 */
export async function createOrUpdateScreeningAnswer(input: {
  questionNormalized: string;
  questionLabel: string;
  answer: string;
  sourceJobId?: string | null;
}): Promise<ScreeningAnswerRecord> {
  const tenantId = getActiveTenantId();
  const existing = await getAnswerByNormalizedQuestion(input.questionNormalized);

  if (existing) {
    // Update existing: increment timesUsed, update answer + updatedAt.
    await db
      .update(screeningAnswers)
      .set({
        answer: input.answer,
        questionLabel: input.questionLabel, // update label in case wording evolved
        timesUsed: existing.timesUsed + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(screeningAnswers.tenantId, tenantId),
          eq(screeningAnswers.questionNormalized, input.questionNormalized),
        ),
      );

    // Re-fetch to get the updated row.
    const updated = await getAnswerByNormalizedQuestion(input.questionNormalized);
    if (!updated) {
      throw new Error("Failed to retrieve updated screening answer.");
    }
    return updated;
  }

  // Insert new.
  const id = randomUUID();
  await db.insert(screeningAnswers).values({
    id,
    tenantId,
    questionNormalized: input.questionNormalized,
    questionLabel: input.questionLabel,
    answer: input.answer,
    sourceJobId: input.sourceJobId ?? null,
    timesUsed: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const inserted = await getAnswerByNormalizedQuestion(input.questionNormalized);
  if (!inserted) {
    throw new Error("Failed to retrieve inserted screening answer.");
  }
  return inserted;
}
