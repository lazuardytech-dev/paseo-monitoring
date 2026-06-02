// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

const ORIGINAL_ENV = { ...process.env };

let server;
let baseUrl;

beforeAll(async () => {
  process.env.PASEO_MONITORING_PASSWORD = "integration-test-password";
  process.env.PASEO_MONITORING_SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";

  // Create minimal dist directory for static files
  const distDir = path.join(__dirname, "..", "..", "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html><body>Test</body></html>");
  }

  // Dynamic import the server
  const serverModule = await import("../../server/index");
  server = serverModule.default || serverModule;

  // Wait for server to start
  await new Promise((resolve) => {
    const check = () => {
      if (server && server.address()) {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
});

afterAll(() => {
  if (server) {
    server.close();
  }
  process.env = { ...ORIGINAL_ENV };
});

async function fetchJson(url, options = {}) {
  const { headers: optHeaders, ...rest } = options;
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...(optHeaders || {}),
  };
  const res = await fetch(url, { headers, ...rest });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // not json
  }
  return { status: res.status, payload, headers: res.headers };
}

describe("Server Auth Endpoints", () => {
  describe("GET /api/health", () => {
    it("returns ok and server info", async () => {
      const { status, payload } = await fetchJson(`${baseUrl}/api/health`);
      expect(status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.pid).toBeGreaterThan(0);
      expect(payload.uptime).toBeGreaterThan(0);
      expect(payload.timestamp).toBeTruthy();
    });
  });

  describe("POST /api/auth/login", () => {
    it("rejects missing password with 400", async () => {
      const { status, payload } = await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
      expect(payload.ok).toBe(false);
      expect(payload.message).toBe("Password is required");
    });

    it("rejects wrong password with 401", async () => {
      const { status, payload } = await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(status).toBe(401);
      expect(payload.ok).toBe(false);
      expect(payload.message).toBe("Invalid password");
    });

    it("returns session cookie on successful login", async () => {
      const { status, payload, headers } = await fetchJson(
        `${baseUrl}/api/auth/login`,
        {
          method: "POST",
          body: JSON.stringify({ password: "integration-test-password" }),
        },
      );
      expect(status).toBe(200);
      expect(payload.ok).toBe(true);

      const setCookie = headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("paseo_monitoring_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).not.toContain("Secure"); // Not production
    });
  });

  describe("GET /api/auth/session", () => {
    it("returns unauthenticated without cookie", async () => {
      const { status, payload } = await fetchJson(`${baseUrl}/api/auth/session`);
      expect(status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.authenticated).toBe(false);
    });

    it("returns authenticated with valid session cookie", async () => {
      const loginRes = await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "integration-test-password" }),
      });

      const cookie = loginRes.headers.get("set-cookie");
      const cookieValue = cookie.split(";")[0];

      const { status, payload } = await fetchJson(
        `${baseUrl}/api/auth/session`,
        { headers: { Cookie: cookieValue } },
      );
      expect(status).toBe(200);
      expect(payload.authenticated).toBe(true);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears session cookie", async () => {
      const loginRes = await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "integration-test-password" }),
      });

      const loginCookie = loginRes.headers.get("set-cookie");
      const cookieValue = loginCookie.split(";")[0];

      const { status, payload, headers } = await fetchJson(
        `${baseUrl}/api/auth/logout`,
        {
          method: "POST",
          headers: { Cookie: cookieValue },
        },
      );

      expect(status).toBe(200);
      expect(payload.ok).toBe(true);

      const setCookie = headers.get("set-cookie");
      expect(setCookie).toContain("paseo_monitoring_session=;");
    });
  });
});

describe("Server Auth-Protected Endpoints", () => {
  it("returns 401 for /api/daemon/status without auth", async () => {
    const { status, payload } = await fetchJson(`${baseUrl}/api/daemon/status`);
    expect(status).toBe(401);
    expect(payload.ok).toBe(false);
    expect(payload.message).toBe("Unauthorized");
  });

  it("returns 401 for /api/daemon/stream without auth", async () => {
    const { status, payload } = await fetchJson(`${baseUrl}/api/daemon/stream`);
    expect(status).toBe(401);
    expect(payload.ok).toBe(false);
  });

  it("returns 404 for unknown routes", async () => {
    const { status, payload } = await fetchJson(`${baseUrl}/api/nonexistent`);
    expect(status).toBe(404);
    expect(payload.ok).toBe(false);
    expect(payload.message).toBe("Not found");
  });

  it("serves index.html for /login and /dashboard routes", async () => {
    const loginRes = await fetch(`${baseUrl}/login`);
    expect(loginRes.status).toBe(200);
    const text = await loginRes.text();
    expect(text).toContain("<html");

    const dashboardRes = await fetch(`${baseUrl}/dashboard`);
    expect(dashboardRes.status).toBe(200);
  });
});

describe("Rate Limiting", () => {
  it("rate limits login endpoint after 10 attempts", async () => {
    for (let i = 0; i < 10; i++) {
      await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
      });
    }

    const { status, payload } = await fetchJson(`${baseUrl}/api/auth/login`, {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });

    expect(status).toBe(429);
    expect(payload.ok).toBe(false);
  });
});
