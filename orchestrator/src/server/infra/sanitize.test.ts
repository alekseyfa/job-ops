import { describe, expect, it } from "vitest";
import { redactSensitivePath, sanitizeUnknown } from "./sanitize";

describe("redactSensitivePath", () => {
  it("redacts the tracer-link token segment", () => {
    expect(redactSensitivePath("/cv/acme-corp-ab3d9k2p")).toBe(
      "/cv/[REDACTED]",
    );
  });

  it("redacts the challenge-viewer session token but keeps the sub-path", () => {
    expect(
      redactSensitivePath(
        "/challenge-viewer/session/9f8e7d6c5b4a/vnc/index.html",
      ),
    ).toBe("/challenge-viewer/session/[REDACTED]/vnc/index.html");
  });

  it("leaves non-sensitive paths untouched", () => {
    expect(redactSensitivePath("/api/jobs")).toBe("/api/jobs");
    expect(redactSensitivePath("/")).toBe("/");
  });
});

describe("sanitizeUnknown key redaction (regression)", () => {
  it("still redacts sensitive object keys", () => {
    const out = sanitizeUnknown({
      apiKey: "sk-live-123",
      token: "abc",
      safe: "visible",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.safe).toBe("visible");
  });
});
