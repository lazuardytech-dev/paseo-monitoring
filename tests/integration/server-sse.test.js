// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

const ORIGINAL_ENV = { ...process.env };

let server;
let baseUrl;

beforeAll(async () => {
  process.env.PASEO_MONITORING_PASSWORD = "sse-test-password";
  process.env.PASEO_MONITORING_SESSION_SECRET = "s".repeat(32);
  process.env.NODE_ENV = "test";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";

  // Ensure dist directory
  const distDir = path.join(__dirname, "..", "..", "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), "<html><body>Test</body></html>");
  }

  const serverModule = await import("../../server/index");
  server = serverModule.default || serverModule;

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

async function loginAndGetCookie() {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "sse-test-password" }),
  });

  const setCookie = res.headers.get("set-cookie");
  return setCookie.split(";")[0];
}

describe("SSE Stream Endpoint", () => {
  it("returns 401 without auth cookie", async () => {
    const res = await fetch(`${baseUrl}/api/daemon/stream`);
    expect(res.status).toBe(401);
    const payload = await res.json();
    expect(payload.ok).toBe(false);
  });

  it("returns 200 with SSE headers when authenticated", async () => {
    const cookie = await loginAndGetCookie();

    const res = await fetch(`${baseUrl}/api/daemon/stream`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("connection")).toBe("keep-alive");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("sends retry directive immediately after connect", async () => {
    const cookie = await loginAndGetCookie();

    const res = await fetch(`${baseUrl}/api/daemon/stream`, {
      headers: { Cookie: cookie },
    });

    // Read initial chunks
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let data = "";

    while (data.length < 100) {
      const { done, value } = await reader.read();
      if (done) break;
      data += decoder.decode(value, { stream: true });
      if (data.includes("retry: 5000")) break;
    }

    reader.cancel();

    expect(data).toContain("retry: 5000");
  });

  it("includes ping heartbeat", async () => {
    const cookie = await loginAndGetCookie();

    const res = await fetch(`${baseUrl}/api/daemon/stream`, {
      headers: { Cookie: cookie },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let data = "";

    // Read for up to 3 seconds to catch a ping
    const timeout = setTimeout(() => {
      reader.cancel();
    }, 3000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        data += decoder.decode(value, { stream: true });
        if (data.includes(": ping")) break;
      }
    } finally {
      clearTimeout(timeout);
      reader.cancel();
    }

    expect(data).toContain(": ping");
  }, 10000);

  it("sends a status event after connection", async () => {
    const cookie = await loginAndGetCookie();

    const res = await fetch(`${baseUrl}/api/daemon/stream`, {
      headers: { Cookie: cookie },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let data = "";

    const timeout = setTimeout(() => {
      reader.cancel();
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        data += decoder.decode(value, { stream: true });
        // Look for a status event
        if (data.includes('event: status') && data.includes('"daemon"')) break;
      }
    } finally {
      clearTimeout(timeout);
      reader.cancel();
    }

    expect(data).toContain("event: status");
    expect(data).toContain('"daemon"');
    expect(data).toContain('"ok"');
  }, 10000);
});
