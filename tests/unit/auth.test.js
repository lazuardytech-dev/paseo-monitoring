import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("auth module", () => {
  let auth;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PASEO_MONITORING_PASSWORD = "test-password";
    process.env.PASEO_MONITORING_SESSION_SECRET = "a".repeat(32);
    auth = await import("../../server/auth");
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("constants", () => {
    it("exports session cookie name", () => {
      expect(auth.SESSION_COOKIE_NAME).toBe("paseo_monitoring_session");
    });

    it("exports session TTL of 24 hours", () => {
      expect(auth.SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe("parseCookies", () => {
    it("parses a single cookie", () => {
      const result = auth.parseCookies("key=value");
      expect(result).toEqual({ key: "value" });
    });

    it("parses multiple cookies", () => {
      const result = auth.parseCookies("a=1; b=2; c=3");
      expect(result).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("decodes URI-encoded values", () => {
      const result = auth.parseCookies("key=hello%20world");
      expect(result).toEqual({ key: "hello world" });
    });

    it("handles empty cookie header", () => {
      expect(auth.parseCookies("")).toEqual({});
    });

    it("handles null cookie header", () => {
      expect(auth.parseCookies(null)).toEqual({});
    });

    it("skips malformed entries (empty key)", () => {
      const result = auth.parseCookies("=value");
      expect(result).toEqual({});
    });

    it("skips entries without equals sign", () => {
      const result = auth.parseCookies("justkey");
      expect(result).toEqual({});
    });

    it("handles key=val=ue (multiple = signs)", () => {
      const result = auth.parseCookies("session=abc=def");
      expect(result).toEqual({ session: "abc=def" });
    });

    it("trims whitespace around keys and values", () => {
      const result = auth.parseCookies("  key  =  value  ");
      expect(result).toEqual({ key: "value" });
    });
  });

  describe("createSessionToken / verifySessionToken", () => {
    it("creates a valid session token", () => {
      const token = auth.createSessionToken();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(2);
    });

    it("verifies a valid token returns true", () => {
      const token = auth.createSessionToken();
      expect(auth.verifySessionToken(token)).toBe(true);
    });

    it("rejects a tampered token", () => {
      const token = auth.createSessionToken();
      const [payload] = token.split(".");
      const tampered = `${payload}.invalidsignature`;
      expect(auth.verifySessionToken(tampered)).toBe(false);
    });

    it("rejects null token", () => {
      expect(auth.verifySessionToken(null)).toBe(false);
    });

    it("rejects undefined token", () => {
      expect(auth.verifySessionToken(undefined)).toBe(false);
    });

    it("rejects non-string token", () => {
      expect(auth.verifySessionToken(123)).toBe(false);
    });

    it("rejects token without dot separator", () => {
      expect(auth.verifySessionToken("justapayload")).toBe(false);
    });

    it("rejects token with more than 2 parts", () => {
      expect(auth.verifySessionToken("a.b.c")).toBe(false);
    });
  });

  describe("isAuthenticatedRequest", () => {
    it("returns true for request with valid session cookie", () => {
      const token = auth.createSessionToken();
      const req = {
        headers: {
          cookie: `paseo_monitoring_session=${encodeURIComponent(token)}`,
        },
      };
      expect(auth.isAuthenticatedRequest(req)).toBe(true);
    });

    it("returns false for request without cookie", () => {
      const req = { headers: {} };
      expect(auth.isAuthenticatedRequest(req)).toBe(false);
    });

    it("returns false for request with invalid cookie", () => {
      const req = {
        headers: {
          cookie: "paseo_monitoring_session=invalidtoken",
        },
      };
      expect(auth.isAuthenticatedRequest(req)).toBe(false);
    });
  });

  describe("getAppPassword", () => {
    it("returns the password from env", () => {
      expect(auth.getAppPassword()).toBe("test-password");
    });

    it("throws if PASEO_MONITORING_PASSWORD is not set", () => {
      delete process.env.PASEO_MONITORING_PASSWORD;
      expect(() => auth.getAppPassword()).toThrow(
        "PASEO_MONITORING_PASSWORD is required",
      );
    });
  });
});
