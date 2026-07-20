import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Secret-box envelope encryption contract:
 *   • round-trips arbitrary JSON,
 *   • output is NOT plaintext (a DB/backup leak yields ciphertext),
 *   • legacy plaintext (non-envelope) values pass through on read so existing
 *     rows keep working and upgrade transparently,
 *   • tampering with the ciphertext/tag is detected (AES-GCM auth).
 */
describe.sequential("secret-box", () => {
  let tempDir: string;
  let box: typeof import("./secret-box");

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-secret-box-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    delete process.env.SECRET_BOX_KEY;
    box = await import("./secret-box");
    box.__resetSecretBoxForTests();
  });

  afterEach(async () => {
    box.__resetSecretBoxForTests();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips an object through seal/open", async () => {
    const secret = { refreshToken: "rt-123", accessToken: "at-456" };
    const sealed = await box.sealJson(secret);
    expect(box.isSealed(sealed)).toBe(true);
    // Ciphertext must not contain the plaintext.
    expect(JSON.stringify(sealed)).not.toContain("rt-123");
    expect(JSON.stringify(sealed)).not.toContain("at-456");

    const opened = await box.openJson(sealed);
    expect(opened).toEqual(secret);
  });

  it("round-trips a plain string", async () => {
    const sealed = await box.sealJson("sk-live-abcdef");
    expect(JSON.stringify(sealed)).not.toContain("sk-live-abcdef");
    expect(await box.openJson<string>(sealed)).toBe("sk-live-abcdef");
  });

  it("passes legacy plaintext through unchanged", async () => {
    expect(await box.openJson("legacy-plaintext-key")).toBe(
      "legacy-plaintext-key",
    );
    expect(await box.openJson({ some: "object" })).toEqual({ some: "object" });
    expect(await box.openJson(null)).toBeNull();
  });

  it("detects tampering with the ciphertext", async () => {
    const sealed = await box.sealJson("top-secret");
    const tampered = { ...sealed, ct: Buffer.from("evil").toString("base64") };
    await expect(box.openJson(tampered)).rejects.toThrow();
  });

  it("accepts a base64 SECRET_BOX_KEY from env", async () => {
    vi.resetModules();
    process.env.SECRET_BOX_KEY = Buffer.alloc(32, 7).toString("base64");
    const envBox = await import("./secret-box");
    envBox.__resetSecretBoxForTests();
    const sealed = await envBox.sealJson("env-keyed");
    expect(await envBox.openJson<string>(sealed)).toBe("env-keyed");
  });
});
