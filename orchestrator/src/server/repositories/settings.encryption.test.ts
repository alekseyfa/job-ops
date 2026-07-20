import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createTestDb,
  DEFAULT_TENANT_ID,
  type TestDbContext,
} from "@server/test-support/tenant-context";

/**
 * Secret-kind settings must be encrypted at rest: the row in the DB is NOT the
 * plaintext, but getSetting returns the plaintext. Non-secret settings stay
 * plaintext (so existing reads/tests are unaffected).
 */
describe.sequential("settings secret encryption at rest", () => {
  let ctx: TestDbContext;
  let settingsRepo: typeof import("./settings");

  beforeEach(async () => {
    ctx = await createTestDb();
    settingsRepo = await import("./settings");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function rawStoredValue(key: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ value: ctx.schema.settings.value })
      .from(ctx.schema.settings)
      .where(
        and(
          eq(ctx.schema.settings.tenantId, DEFAULT_TENANT_ID),
          eq(ctx.schema.settings.key, key),
        ),
      );
    return row?.value ?? null;
  }

  it("stores a secret setting encrypted but reads it back in plaintext", async () => {
    await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      settingsRepo.setSetting("llmApiKey", "sk-super-secret-123"),
    );

    const stored = await rawStoredValue("llmApiKey");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("sk-super-secret-123");
    // Stored as an envelope JSON object.
    expect(JSON.parse(stored as string)).toMatchObject({ v: 1 });

    const read = await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      settingsRepo.getSetting("llmApiKey"),
    );
    expect(read).toBe("sk-super-secret-123");
  });

  it("leaves non-secret settings as plaintext", async () => {
    await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      settingsRepo.setSetting("userTimezone", "Europe/London"),
    );
    expect(await rawStoredValue("userTimezone")).toBe("Europe/London");
  });

  it("reads a legacy plaintext secret written before encryption", async () => {
    // Simulate a pre-encryption row by inserting plaintext directly.
    await ctx.db.insert(ctx.schema.settings).values({
      tenantId: DEFAULT_TENANT_ID,
      key: "llmApiKey",
      value: "legacy-plain-key",
    });
    const read = await ctx.withTenant(DEFAULT_TENANT_ID, () =>
      settingsRepo.getSetting("llmApiKey"),
    );
    expect(read).toBe("legacy-plain-key");
  });
});
