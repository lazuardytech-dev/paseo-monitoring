// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Cookie parsing edge cases (via auth module)", () => {
  let auth;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PASEO_MONITORING_PASSWORD = "test";
    process.env.PASEO_MONITORING_SESSION_SECRET = "s".repeat(32);
    auth = await import("../../server/auth");
  });

  it("handles multiple consecutive semicolons", () => {
    const result = auth.parseCookies("a=1;;;b=2");
    expect(result).toEqual({ a: "1", b: "2" });
  });

  it("handles cookies with trailing semicolon", () => {
    const result = auth.parseCookies("a=1;");
    expect(result).toEqual({ a: "1" });
  });

  it("handles URI-encoded session token in cookie", () => {
    const token = "eyJpYXQiOjoxNzA1MDAwMDAwfQ.signature";
    const encodedToken = encodeURIComponent(token);
    const result = auth.parseCookies(
      `paseo_monitoring_session=${encodedToken}`,
    );
    expect(result.paseo_monitoring_session).toBe(token);
  });

  it("handles cookies with spaces around equals", () => {
    const result = auth.parseCookies(" key = value ");
    expect(result).toEqual({ key: "value" });
  });

  it("handles very long cookie value", () => {
    const longValue = "x".repeat(5000);
    const result = auth.parseCookies(`big=${longValue}`);
    expect(result.big).toBe(longValue);
    expect(result.big.length).toBe(5000);
  });
});

describe("Session token edge cases", () => {
  let auth;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PASEO_MONITORING_PASSWORD = "test";
    process.env.PASEO_MONITORING_SESSION_SECRET = "s".repeat(32);
    auth = await import("../../server/auth");
  });

  it("rejects expired token", () => {
    const token = auth.createSessionToken();
    const parts = token.split(".");
    const expiredPayload = Buffer.from(
      JSON.stringify({ iat: 0, exp: 1, nonce: "deadbeef" }),
    ).toString("base64url");
    const tampered = `${expiredPayload}.${parts[1]}`;
    expect(auth.verifySessionToken(tampered)).toBe(false);
  });

  it("rejects token with empty payload", () => {
    expect(auth.verifySessionToken(".signature")).toBe(false);
  });

  it("rejects token with empty signature", () => {
    const token = auth.createSessionToken();
    const [payload] = token.split(".");
    expect(auth.verifySessionToken(`${payload}.`)).toBe(false);
  });

  it("produces different tokens on each call (random nonce)", () => {
    const token1 = auth.createSessionToken();
    const token2 = auth.createSessionToken();
    expect(token1).not.toBe(token2);
  });

  it("token format is base64url.base64url", () => {
    const token = auth.createSessionToken();
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
