/**
 * Application-managed envelope encryption for secrets at rest.
 *
 * Third-party credentials (Gmail OAuth tokens, API keys, bot token) live in an
 * unencrypted SQLite file. Envelope-encrypting them means a stolen DB file or
 * backup yields ciphertext, not live credentials.
 *
 * Key management mirrors auth/jwt.ts: a 32-byte key from SECRET_BOX_KEY (base64
 * or hex) if set, else a persisted 0600 key file under the data dir, generated
 * on first run. AES-256-GCM provides confidentiality + integrity (the auth tag
 * detects tampering).
 *
 * Format (stored as a JSON object so it round-trips through Drizzle json cols):
 *   { v: 1, iv: <base64>, tag: <base64>, ct: <base64> }
 * Anything not matching that shape is treated as legacy plaintext on read, so
 * existing rows keep working until they're next written (transparent upgrade).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@infra/logger";
import { getDataDir } from "@server/config/dataDir";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const KEY_FILENAME = "secret-box-key";
const ENVELOPE_VERSION = 1;

let cachedKey: Buffer | null = null;

interface Envelope {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

function parseEnvKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Accept base64 or hex; must decode to exactly 32 bytes.
  for (const enc of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(trimmed, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      // try next encoding
    }
  }
  throw new Error(
    `SECRET_BOX_KEY must decode to ${KEY_BYTES} bytes (base64 or hex)`,
  );
}

async function readPersistedKey(path: string): Promise<Buffer | null> {
  try {
    const stored = (await readFile(path, "utf8")).trim();
    if (!stored) return null;
    const buf = Buffer.from(stored, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new Error(`Persisted secret-box key at ${path} is malformed`);
    }
    return buf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensurePersistedKey(): Promise<Buffer> {
  const dataDir = getDataDir();
  const keyPath = join(dataDir, KEY_FILENAME);
  await mkdir(dataDir, { recursive: true });

  const existing = await readPersistedKey(keyPath);
  if (existing) return existing;

  const generated = randomBytes(KEY_BYTES);
  try {
    await writeFile(keyPath, `${generated.toString("base64")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    logger.info("Generated local secret-box key", { path: keyPath });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readPersistedKey(keyPath);
    if (!raced) throw new Error(`Persisted secret-box key at ${keyPath} is malformed`);
    return raced;
  }
}

async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const explicit = process.env.SECRET_BOX_KEY;
  if (explicit) {
    const parsed = parseEnvKey(explicit);
    if (parsed) {
      cachedKey = parsed;
      return parsed;
    }
  }
  cachedKey = await ensurePersistedKey();
  return cachedKey;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Envelope).v === ENVELOPE_VERSION &&
    typeof (value as Envelope).iv === "string" &&
    typeof (value as Envelope).tag === "string" &&
    typeof (value as Envelope).ct === "string"
  );
}

/** Encrypt an arbitrary JSON-serializable value into an envelope object. */
export async function sealJson(value: unknown): Promise<Envelope> {
  const key = await getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

/**
 * Decrypt a value produced by sealJson. If the stored value is NOT an envelope
 * (legacy plaintext written before encryption shipped), it's returned as-is so
 * existing rows keep working and get upgraded on next write.
 */
export async function openJson<T = unknown>(stored: unknown): Promise<T | null> {
  if (stored === null || stored === undefined) return null;
  if (!isEnvelope(stored)) {
    // Legacy plaintext (or already-decoded value) — pass through.
    return stored as T;
  }
  const key = await getKey();
  const iv = Buffer.from(stored.iv, "base64");
  const tag = Buffer.from(stored.tag, "base64");
  const ct = Buffer.from(stored.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** True if a stored value is already an encryption envelope. */
export function isSealed(value: unknown): boolean {
  return isEnvelope(value);
}

/** Test-only: reset the cached key so a new data dir / env is picked up. */
export function __resetSecretBoxForTests(): void {
  cachedKey = null;
}
