/**
 * Settings repository - key/value storage for runtime configuration.
 */

import { openJson, sealJson } from "@infra/secret-box";
import { settingsRegistry } from "@shared/settings-registry";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index";
import { getActiveTenantId } from "../tenancy/context";

const { settings } = schema;

export type SettingKey = Exclude<
  {
    [K in keyof typeof settingsRegistry]: (typeof settingsRegistry)[K]["kind"] extends "virtual"
      ? never
      : K;
  }[keyof typeof settingsRegistry],
  undefined
>;

/**
 * Secret-kind settings (LLM/API keys, bot token, webhook secret, basic-auth
 * password) are envelope-encrypted at rest. The stored column is JSON text, so
 * a sealed value is the JSON of an envelope object; a plaintext string is a
 * legacy row that transparently upgrades on next write.
 */
function isSecretKey(key: SettingKey): boolean {
  const def = (settingsRegistry as Record<string, { kind?: string }>)[key];
  return def?.kind === "secret";
}

async function decodeStoredValue(
  key: SettingKey,
  raw: string | null,
): Promise<string | null> {
  if (raw === null) return null;
  if (!isSecretKey(key)) return raw;
  // Sealed values are stored as JSON of the envelope object.
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Legacy plaintext secret (not JSON) — return as-is.
    return raw;
  }
  const opened = await openJson<string>(parsed);
  return typeof opened === "string" ? opened : raw;
}

async function encodeStoredValue(
  key: SettingKey,
  value: string,
): Promise<string> {
  if (!isSecretKey(key)) return value;
  return JSON.stringify(await sealJson(value));
}

export async function getSetting(key: SettingKey): Promise<string | null> {
  const tenantId = getActiveTenantId();
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)));
  return decodeStoredValue(key, row?.value ?? null);
}

export async function getAllSettings(): Promise<
  Partial<Record<SettingKey, string>>
> {
  const tenantId = getActiveTenantId();
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.tenantId, tenantId));
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of rows) {
    const key = row.key as SettingKey;
    const decoded = await decodeStoredValue(key, row.value);
    if (decoded !== null) out[key] = decoded;
  }
  return out;
}

export async function setSetting(
  key: SettingKey,
  value: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const tenantId = getActiveTenantId();

  if (value === null) {
    await db
      .delete(settings)
      .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)));
    return;
  }

  const storedValue = await encodeStoredValue(key, value);

  const [existing] = await db
    .select({ key: settings.key })
    .from(settings)
    .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)));

  if (existing) {
    await db
      .update(settings)
      .set({ value: storedValue, updatedAt: now })
      .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)));
    return;
  }

  await db.insert(settings).values({
    tenantId,
    key,
    value: storedValue,
    createdAt: now,
    updatedAt: now,
  });
}
