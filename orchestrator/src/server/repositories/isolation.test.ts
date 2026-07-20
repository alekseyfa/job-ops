import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  DEFAULT_TENANT_ID,
  type TestDbContext,
} from "@server/test-support/tenant-context";

/**
 * Cross-tenant isolation contract for the tenant-scoped repositories.
 *
 * These repos all read/write through getActiveTenantId() (fail-closed). This
 * suite locks three properties for each repo:
 *   1. Rows written under tenant A are NOT visible under tenant B.
 *   2. Each tenant's list/get endpoints return only that tenant's own rows,
 *      and the default tenant sees neither A's nor B's data.
 *   3. A call made WITHOUT any request context throws (never silently reads
 *      the default tenant).
 *
 * Non-default tenants are inserted via ctx.createTenant first so the
 * tenant-id FK on each table is satisfied. Fixtures are deliberately neutral
 * (Test Corp / generic questions / non-production cities).
 *
 * request-context / repos are imported AFTER createTestDb() (which does
 * vi.resetModules) so they share the same AsyncLocalStorage instance the
 * withTenant helper writes to — see test-support/tenant-context.ts.
 */
describe.sequential("cross-tenant repository isolation", () => {
  const TENANT_A = "tenant_a";
  const TENANT_B = "tenant_b";

  let ctx: TestDbContext;
  let settingsRepo: typeof import("./settings");
  let pipelineRepo: typeof import("./pipeline");
  let screeningRepo: typeof import("./screening-answers");
  let interviewRepo: typeof import("./interview-prep");

  beforeEach(async () => {
    ctx = await createTestDb();
    // Post-reset imports — bound to the same module graph as withTenant.
    settingsRepo = await import("./settings");
    pipelineRepo = await import("./pipeline");
    screeningRepo = await import("./screening-answers");
    interviewRepo = await import("./interview-prep");

    await ctx.createTenant(TENANT_A);
    await ctx.createTenant(TENANT_B);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ---------------------------------------------------------------- settings

  it("settings: a key set under tenant A is invisible to tenant B", async () => {
    await ctx.withTenant(TENANT_A, () =>
      settingsRepo.setSetting("userTimezone", "Europe/London"),
    );
    await ctx.withTenant(TENANT_B, () =>
      settingsRepo.setSetting("userTimezone", "America/New_York"),
    );

    // Same key, two tenants, two distinct values — no cross-read.
    expect(
      await ctx.withTenant(TENANT_A, () =>
        settingsRepo.getSetting("userTimezone"),
      ),
    ).toBe("Europe/London");
    expect(
      await ctx.withTenant(TENANT_B, () =>
        settingsRepo.getSetting("userTimezone"),
      ),
    ).toBe("America/New_York");

    // getAllSettings is scoped: each tenant sees only its own value.
    const allA = await ctx.withTenant(TENANT_A, () =>
      settingsRepo.getAllSettings(),
    );
    const allB = await ctx.withTenant(TENANT_B, () =>
      settingsRepo.getAllSettings(),
    );
    expect(allA.userTimezone).toBe("Europe/London");
    expect(allB.userTimezone).toBe("America/New_York");

    // The default tenant, which set nothing, sees neither.
    expect(
      await ctx.withTenant(DEFAULT_TENANT_ID, () =>
        settingsRepo.getSetting("userTimezone"),
      ),
    ).toBeNull();
    const allDefault = await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      settingsRepo.getAllSettings(),
    );
    expect(allDefault.userTimezone).toBeUndefined();
  });

  it("settings: deleting a key in tenant A does not touch tenant B", async () => {
    await ctx.withTenant(TENANT_A, () =>
      settingsRepo.setSetting("userTimezone", "Europe/London"),
    );
    await ctx.withTenant(TENANT_B, () =>
      settingsRepo.setSetting("userTimezone", "America/New_York"),
    );

    // setSetting(key, null) deletes — must be tenant-scoped.
    await ctx.withTenant(TENANT_A, () =>
      settingsRepo.setSetting("userTimezone", null),
    );

    expect(
      await ctx.withTenant(TENANT_A, () =>
        settingsRepo.getSetting("userTimezone"),
      ),
    ).toBeNull();
    expect(
      await ctx.withTenant(TENANT_B, () =>
        settingsRepo.getSetting("userTimezone"),
      ),
    ).toBe("America/New_York");
  });

  // ---------------------------------------------------------------- pipeline

  it("pipeline: runs created under one tenant are not listed for another", async () => {
    const runA = await ctx.withTenant(TENANT_A, () =>
      pipelineRepo.createPipelineRun(),
    );
    const runB = await ctx.withTenant(TENANT_B, () =>
      pipelineRepo.createPipelineRun(),
    );

    const recentA = await ctx.withTenant(TENANT_A, () =>
      pipelineRepo.getRecentPipelineRuns(),
    );
    const recentB = await ctx.withTenant(TENANT_B, () =>
      pipelineRepo.getRecentPipelineRuns(),
    );
    expect(recentA.map((r) => r.id)).toEqual([runA.id]);
    expect(recentB.map((r) => r.id)).toEqual([runB.id]);

    // getLatestPipelineRun is scoped to the active tenant.
    expect(
      (await ctx.withTenant(TENANT_A, () =>
        pipelineRepo.getLatestPipelineRun(),
      ))?.id,
    ).toBe(runA.id);

    // getPipelineRunById cannot reach across tenants: A cannot fetch B's run,
    // but B can fetch its own.
    expect(
      await ctx.withTenant(TENANT_A, () =>
        pipelineRepo.getPipelineRunById(runB.id),
      ),
    ).toBeNull();
    expect(
      (await ctx.withTenant(TENANT_B, () =>
        pipelineRepo.getPipelineRunById(runB.id),
      ))?.id,
    ).toBe(runB.id);

    // The default tenant created no runs.
    expect(
      await ctx.withTenant(DEFAULT_TENANT_ID, () =>
        pipelineRepo.getRecentPipelineRuns(),
      ),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------- screening answers

  it("screening answers: identical questions live in separate tenant rows", async () => {
    const QUESTION = "why do you want this role";

    await ctx.withTenant(TENANT_A, () =>
      screeningRepo.createOrUpdateScreeningAnswer({
        questionNormalized: QUESTION,
        questionLabel: "Why do you want this role?",
        answer: "Tenant A essay",
      }),
    );
    await ctx.withTenant(TENANT_B, () =>
      screeningRepo.createOrUpdateScreeningAnswer({
        questionNormalized: QUESTION,
        questionLabel: "Why do you want this role?",
        answer: "Tenant B essay",
      }),
    );

    const a = await ctx.withTenant(TENANT_A, () =>
      screeningRepo.getAnswerByNormalizedQuestion(QUESTION),
    );
    const b = await ctx.withTenant(TENANT_B, () =>
      screeningRepo.getAnswerByNormalizedQuestion(QUESTION),
    );

    expect(a?.answer).toBe("Tenant A essay");
    expect(b?.answer).toBe("Tenant B essay");

    // The upsert keys on (tenant, questionNormalized). B writing the same
    // normalized question must NOT increment A's timesUsed (would prove the
    // conflict lookup crossed tenants).
    expect(a?.timesUsed).toBe(1);
    expect(b?.timesUsed).toBe(1);
    expect(a?.id).not.toBe(b?.id);

    // Default tenant has no answer for this question.
    expect(
      await ctx.withTenant(DEFAULT_TENANT_ID, () =>
        screeningRepo.getAnswerByNormalizedQuestion(QUESTION),
      ),
    ).toBeNull();
  });

  // ----------------------------------------------------------- interview prep

  it("interview prep: stories & questions are isolated and non-deletable across tenants", async () => {
    const storyA = await ctx.withTenant(TENANT_A, () =>
      interviewRepo.createStory({ title: "A leadership story", tags: ["lead"] }),
    );
    const storyB = await ctx.withTenant(TENANT_B, () =>
      interviewRepo.createStory({ title: "B conflict story" }),
    );

    expect(
      (await ctx.withTenant(TENANT_A, () =>
        interviewRepo.listStories(),
      )).map((s) => s.title),
    ).toEqual(["A leadership story"]);
    expect(
      (await ctx.withTenant(TENANT_B, () =>
        interviewRepo.listStories(),
      )).map((s) => s.title),
    ).toEqual(["B conflict story"]);

    // getStoryById is tenant-scoped: A cannot read B's story.
    expect(
      await ctx.withTenant(TENANT_A, () =>
        interviewRepo.getStoryById(storyB.id),
      ),
    ).toBeNull();

    // deleteStory is tenant-scoped: A deleting B's id changes nothing, and
    // B's row survives.
    expect(
      await ctx.withTenant(TENANT_A, () =>
        interviewRepo.deleteStory(storyB.id),
      ),
    ).toBe(false);
    expect(
      await ctx.withTenant(TENANT_B, () =>
        interviewRepo.getStoryById(storyB.id),
      ),
    ).not.toBeNull();

    // updateStory across tenants is a no-op (returns null — the row isn't
    // visible to tenant A) and must not mutate B's story.
    expect(
      await ctx.withTenant(TENANT_A, () =>
        interviewRepo.updateStory(storyB.id, { title: "hijacked" }),
      ),
    ).toBeNull();
    expect(
      (await ctx.withTenant(TENANT_B, () =>
        interviewRepo.getStoryById(storyB.id),
      ))?.title,
    ).toBe("B conflict story");
    // Sanity: storyA still belongs to A only.
    expect(
      (await ctx.withTenant(TENANT_A, () =>
        interviewRepo.getStoryById(storyA.id),
      ))?.title,
    ).toBe("A leadership story");

    // Questions: same question text in both tenants -> two isolated rows.
    await ctx.withTenant(TENANT_A, () =>
      interviewRepo.createQuestion({
        question: "Tell me about yourself",
        answer: "A answer",
      }),
    );
    await ctx.withTenant(TENANT_B, () =>
      interviewRepo.createQuestion({
        question: "Tell me about yourself",
        answer: "B answer",
      }),
    );
    expect(
      (await ctx.withTenant(TENANT_A, () =>
        interviewRepo.listQuestions(),
      )).map((q) => q.answer),
    ).toEqual(["A answer"]);
    expect(
      (await ctx.withTenant(TENANT_B, () =>
        interviewRepo.listQuestions(),
      )).map((q) => q.answer),
    ).toEqual(["B answer"]);

    // Default tenant sees no interview content.
    expect(
      await ctx.withTenant(DEFAULT_TENANT_ID, () =>
        interviewRepo.listStories(),
      ),
    ).toHaveLength(0);
    expect(
      await ctx.withTenant(DEFAULT_TENANT_ID, () =>
        interviewRepo.listQuestions(),
      ),
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------- fail-closed

  it("context-less repository calls throw for every repo (fail-closed)", async () => {
    // No withTenant wrapper -> no request context -> getActiveTenantId throws.
    await expect(settingsRepo.getAllSettings()).rejects.toThrow(/tenant/i);
    await expect(pipelineRepo.getRecentPipelineRuns()).rejects.toThrow(
      /tenant/i,
    );
    await expect(
      screeningRepo.getAnswerByNormalizedQuestion("anything"),
    ).rejects.toThrow(/tenant/i);
    await expect(interviewRepo.listStories()).rejects.toThrow(/tenant/i);
    await expect(interviewRepo.listQuestions()).rejects.toThrow(/tenant/i);
  });
});
