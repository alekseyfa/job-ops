import jsonwebtoken from "jsonwebtoken";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createTestDb,
  DEFAULT_TENANT_ID,
  type TestDbContext,
} from "@server/test-support/tenant-context";

/**
 * auth/jwt.ts contract:
 *   • signToken persists an auth_sessions row (jti) AND returns a signed HS256
 *     token carrying the caller's claims.
 *   • verifyToken re-checks BOTH the JWT signature/expiry AND the persisted
 *     session (must exist, not revoked, not expired, claims must match).
 *   • blacklistToken revokes the session so a still-cryptographically-valid
 *     token stops verifying.
 *
 * These tests pin that round-trip and every rejection path. A fresh migrated
 * temp DB comes from createTestDb(); the jwt module is imported dynamically in
 * beforeEach (after createTestDb's vi.resetModules) so it binds to the same db
 * instance the freshly-migrated auth-sessions repo uses, and so its cached JWT
 * secret starts clean each test.
 *
 * FKs ARE enforced on this connection: auth_sessions.tenant_id -> tenants.id
 * and auth_sessions.user_id -> users.id. Migration already seeds the default
 * tenant, but we must seed the user row so signToken's insert succeeds.
 */

// >= MIN_JWT_SECRET_LENGTH (32). Known value so tests can forge tokens.
const SECRET = "0123456789abcdef0123456789abcdef0123456789";

const BASE_CLAIMS = {
  sub: "user_jane",
  userId: "user_jane",
  tenantId: DEFAULT_TENANT_ID,
  username: "jane.doe",
  isSystemAdmin: false,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe.sequential("auth/jwt signToken + verifyToken", () => {
  let ctx: TestDbContext;
  let jwtAuth: typeof import("./jwt");

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  beforeEach(async () => {
    delete process.env.JWT_EXPIRY_SECONDS;
    ctx = await createTestDb();
    jwtAuth = await import("./jwt");

    // FK: auth_sessions.user_id -> users.id. Seed the referenced user so
    // signToken's session insert doesn't trip the FK constraint. (The default
    // tenant referenced by tenant_id is already seeded by the migration.)
    await ctx.db
      .insert(ctx.schema.users)
      .values({
        id: BASE_CLAIMS.userId,
        username: BASE_CLAIMS.username,
        passwordHash: "test-hash",
        passwordSalt: "test-salt",
      })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    delete process.env.JWT_EXPIRY_SECONDS;
    await ctx.cleanup();
  });

  async function countSessions(): Promise<number> {
    const rows = await ctx.db.select().from(ctx.schema.authSessions);
    return rows.length;
  }

  it("round-trips claims and persists a session row", async () => {
    const { token, expiresIn } = await jwtAuth.signToken({ ...BASE_CLAIMS });

    expect(typeof token).toBe("string");
    expect(expiresIn).toBeGreaterThan(0);

    // signToken persisted exactly one auth_sessions row.
    expect(await countSessions()).toBe(1);

    const claims = await jwtAuth.verifyToken(token);
    expect(claims.sub).toBe(BASE_CLAIMS.sub);
    expect(claims.userId).toBe(BASE_CLAIMS.userId);
    expect(claims.tenantId).toBe(BASE_CLAIMS.tenantId);
    expect(claims.username).toBe(BASE_CLAIMS.username);
    expect(claims.isSystemAdmin).toBe(false);
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(0);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The persisted row's id matches the token's jti.
    const [row] = await ctx.db.select().from(ctx.schema.authSessions);
    expect(row.id).toBe(claims.jti);
    expect(row.subject).toBe(BASE_CLAIMS.sub);
    expect(row.revokedAt).toBeNull();
  });

  it("preserves isSystemAdmin=true through the round-trip", async () => {
    const { token } = await jwtAuth.signToken({
      ...BASE_CLAIMS,
      isSystemAdmin: true,
    });
    const claims = await jwtAuth.verifyToken(token);
    expect(claims.isSystemAdmin).toBe(true);
  });

  it("rejects an expired token", async () => {
    process.env.JWT_EXPIRY_SECONDS = "1";
    const { token } = await jwtAuth.signToken({ ...BASE_CLAIMS });

    // Let the 1s expiry elapse; jwt.verify throws before the DB check.
    await sleep(1500);

    await expect(jwtAuth.verifyToken(token)).rejects.toThrow(/expired/i);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const wrongSecret = "wrong-wrong-wrong-wrong-wrong-wrong-1234";
    const forged = jsonwebtoken.sign(
      { ...BASE_CLAIMS },
      wrongSecret,
      { algorithm: "HS256", expiresIn: 3600, jwtid: "forged-jti" },
    );

    await expect(jwtAuth.verifyToken(forged)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const { token } = await jwtAuth.signToken({ ...BASE_CLAIMS });

    // Flip the final signature character so the HMAC no longer matches.
    const lastChar = token.slice(-1);
    const tampered = token.slice(0, -1) + (lastChar === "A" ? "B" : "A");
    expect(tampered).not.toBe(token);

    await expect(jwtAuth.verifyToken(tampered)).rejects.toThrow();
  });

  it("rejects a blacklisted (revoked) token", async () => {
    const { token } = await jwtAuth.signToken({ ...BASE_CLAIMS });

    // Valid before revocation.
    const claims = await jwtAuth.verifyToken(token);

    await jwtAuth.blacklistToken(claims.jti);

    await expect(jwtAuth.verifyToken(token)).rejects.toThrow(/revoked/i);
  });

  it("rejects a signature-valid token that is missing required claims", async () => {
    // Signed with the correct secret so jwt.verify passes, but userId is
    // absent -> the claim-presence guard must reject it.
    const missingUserId = jsonwebtoken.sign(
      {
        sub: BASE_CLAIMS.sub,
        tenantId: BASE_CLAIMS.tenantId,
        username: BASE_CLAIMS.username,
      },
      SECRET,
      { algorithm: "HS256", expiresIn: 3600, jwtid: "missing-claims-jti" },
    );

    await expect(jwtAuth.verifyToken(missingUserId)).rejects.toThrow(
      /missing required claims/i,
    );
  });

  it("rejects after __resetBlacklistForTests clears the session store", async () => {
    const { token } = await jwtAuth.signToken({ ...BASE_CLAIMS });
    expect(await countSessions()).toBe(1);

    await jwtAuth.__resetBlacklistForTests();

    // Session row is gone, so verifyToken can no longer confirm it.
    expect(await countSessions()).toBe(0);
    await expect(jwtAuth.verifyToken(token)).rejects.toThrow(/revoked/i);
  });
});
