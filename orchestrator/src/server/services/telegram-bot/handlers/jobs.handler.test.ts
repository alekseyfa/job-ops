/**
 * End-to-end-ish handler test for the Telegram jobs handlers, driven through a
 * REAL grammy Bot via `bot.handleUpdate(update)` with no networking (see
 * test-support/telegram-harness.ts). This exercises the full path a Telegram
 * tap takes: auth+tenant middleware (bot.ts) -> callbackQuery router
 * (handlers/jobs.ts) -> tenant-scoped repositories.
 *
 * Because the auth middleware is the ONE place the bot establishes a request
 * context (runWithRequestContext), a linked chat's handler calls reach the
 * repos with a tenant; an UNLINKED chat is rejected before any DB read.
 *
 * Module-reset discipline (mirrors fail-closed.test.ts / stale-jobs.test.ts):
 * createTestDb() runs vi.resetModules() + a fresh migrated temp DB. Everything
 * that must share the post-reset module graph (the DB singleton and the
 * request-context AsyncLocalStorage) — the bot, the handlers, and the repos —
 * is imported DYNAMICALLY inside beforeEach, AFTER the reset.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  type TestDbContext,
} from "@server/test-support/tenant-context";
import {
  createTelegramHarness,
  type TelegramHarness,
} from "@server/test-support/telegram-harness";

const TENANT_ID = "tenant_tg";
const USER_ID = "user_tg";
const LINKED_CHAT = 555_001;
const UNLINKED_CHAT = 999_002;

describe.sequential("telegram jobs handler", () => {
  let ctx: TestDbContext;
  let harness: TelegramHarness;
  let jobsRepo: typeof import("@server/repositories/jobs");
  let readyIds: string[];

  beforeEach(async () => {
    ctx = await createTestDb();

    // Tenant + owning user (neutral fixtures). FK enforcement is off on the
    // main connection, but seeding the real rows keeps the fixture honest.
    await ctx.createTenant(TENANT_ID, "Test Corp");
    await ctx.db
      .insert(ctx.schema.users)
      .values({
        id: USER_ID,
        username: "jane.doe@example.com",
        passwordHash: "test-hash",
        passwordSalt: "test-salt",
      })
      .onConflictDoNothing();

    // Bind the chat -> tenant. linkChat is intentionally NOT tenant-scoped
    // (it discovers the tenant), so it needs no request context.
    const links = await import("@server/repositories/telegram-links");
    await links.linkChat({
      chatId: LINKED_CHAT,
      userId: USER_ID,
      tenantId: TENANT_ID,
    });

    // Seed two READY jobs so an "apply" can advance to the next one.
    jobsRepo = await import("@server/repositories/jobs");
    readyIds = [];
    await ctx.withTenant(TENANT_ID, async () => {
      for (const n of [1, 2]) {
        const job = await jobsRepo.createJob({
          source: "manual",
          title: `Senior Widget Engineer ${n}`,
          employer: "Test Corp",
          jobUrl: `https://example.com/job/${n}`,
          location: "Remote City",
        });
        await jobsRepo.updateJob(job.id, {
          status: "ready",
          suitabilityScore: 90 - n,
        });
        readyIds.push(job.id);
      }
    });

    // Build the bot + register handlers AFTER the reset, then wrap it so its
    // outgoing API calls are captured instead of hitting the network.
    harness = await createTelegramHarness(async () => {
      const { createBot } = await import("@server/services/telegram-bot/bot");
      const { registerJobHandlers } = await import(
        "@server/services/telegram-bot/handlers/jobs"
      );
      const bot = createBot("test:test");
      registerJobHandlers(bot);
      return bot;
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("j:ready:0 renders the ready-jobs list screen", async () => {
    await harness.sendCallback(LINKED_CHAT, "j:ready:0");

    const edits = harness.find("editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    const text = harness.lastText() ?? "";
    // Header shows the status label + count, and the seeded jobs are listed.
    expect(text).toContain("Ready Jobs");
    expect(text).toContain("Senior Widget Engineer");
    // The list-item buttons route to the detail view.
    const kb = edits.at(-1)?.payload.reply_markup?.inline_keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined;
    const hasDetailButton = (kb ?? [])
      .flat()
      .some((b) => b.callback_data?.startsWith("j:d:"));
    expect(hasDetailButton).toBe(true);
  });

  it("j:d:<shortId> renders the job detail card", async () => {
    const shortId = readyIds[0].slice(0, 8);
    await harness.sendCallback(LINKED_CHAT, `j:d:${shortId}`);

    const text = harness.lastText() ?? "";
    expect(text).toContain("Senior Widget Engineer 1");
    expect(text).toContain("Test Corp");
    expect(text).toContain("Status: ready");
  });

  it("j:apply:<shortId> marks the job applied AND advances to the next ready job", async () => {
    const target = readyIds[0];
    const shortId = target.slice(0, 8);

    await harness.sendCallback(LINKED_CHAT, `j:apply:${shortId}`);

    // Repo state actually changed: the tapped job is now applied.
    const applied = await ctx.withTenant(TENANT_ID, () =>
      jobsRepo.getJobById(target),
    );
    expect(applied?.status).toBe("applied");
    expect(applied?.appliedAt).toBeTruthy();

    // The reply advanced the rapid-triage queue (one ready job remains).
    const text = harness.lastText() ?? "";
    expect(/Next up|queue cleared/.test(text)).toBe(true);

    // And the user got the toast confirmation.
    const answers = harness.find("answerCallbackQuery");
    expect(
      answers.some((a) => String(a.payload.text ?? "").includes("applied")),
    ).toBe(true);
  });

  it("rejects an UNLINKED chat before any handler runs", async () => {
    await harness.sendCallback(UNLINKED_CHAT, "j:ready:0");

    const texts = harness.texts();
    // The auth middleware replies with the not-authorized notice...
    expect(texts.some((t) => t.includes("Not authorized"))).toBe(true);
    // ...and the job-list screen is never rendered.
    expect(texts.some((t) => t.includes("Ready Jobs"))).toBe(false);
  });
});
