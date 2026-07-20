import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@server/auth/password";

/**
 * Locks the password primitive contract (scrypt + timingSafeEqual):
 *   - hashPassword yields a random salt AND a derived hash.
 *   - The correct password verifies true against its own salt+hash.
 *   - A wrong password verifies false.
 *   - Two hashes of the SAME password differ (random per-hash salt).
 *   - A malformed stored value resolves to false instead of throwing.
 *
 * Pure crypto: no DB, no tenant context.
 */
describe("auth/password", () => {
  const PASSWORD = "Jane-Doe-Test-Passw0rd!";

  it("hashPassword yields a non-empty salt and hash", async () => {
    const { passwordHash, passwordSalt } = await hashPassword(PASSWORD);
    expect(typeof passwordHash).toBe("string");
    expect(typeof passwordSalt).toBe("string");
    expect(passwordHash.length).toBeGreaterThan(0);
    expect(passwordSalt.length).toBeGreaterThan(0);
    // Salt and hash must be distinct values.
    expect(passwordHash).not.toBe(passwordSalt);
  });

  it("verifies the correct password as true", async () => {
    const { passwordHash, passwordSalt } = await hashPassword(PASSWORD);
    const ok = await verifyPassword({
      password: PASSWORD,
      passwordHash,
      passwordSalt,
    });
    expect(ok).toBe(true);
  });

  it("rejects a wrong password as false", async () => {
    const { passwordHash, passwordSalt } = await hashPassword(PASSWORD);
    const ok = await verifyPassword({
      password: "wrong-password",
      passwordHash,
      passwordSalt,
    });
    expect(ok).toBe(false);
  });

  it("produces a different salt and hash each time for the same password", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    // Random salt => salts differ and derived hashes differ.
    expect(first.passwordSalt).not.toBe(second.passwordSalt);
    expect(first.passwordHash).not.toBe(second.passwordHash);
    // Yet each still verifies against its own salt.
    await expect(
      verifyPassword({
        password: PASSWORD,
        passwordHash: first.passwordHash,
        passwordSalt: first.passwordSalt,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword({
        password: PASSWORD,
        passwordHash: second.passwordHash,
        passwordSalt: second.passwordSalt,
      }),
    ).resolves.toBe(true);
  });

  it("does not crash on a malformed stored hash and returns false", async () => {
    const { passwordSalt } = await hashPassword(PASSWORD);
    // A garbage hash decodes to a byte length that cannot match the
    // freshly derived key, so verify must resolve to false (never throw).
    await expect(
      verifyPassword({
        password: PASSWORD,
        passwordHash: "not-a-valid-scrypt-hash",
        passwordSalt,
      }),
    ).resolves.toBe(false);
  });

  it("does not crash when both stored fields are garbage", async () => {
    await expect(
      verifyPassword({
        password: PASSWORD,
        passwordHash: "totally-bogus-hash-value",
        passwordSalt: "totally-bogus-salt-value",
      }),
    ).resolves.toBe(false);
  });
});
