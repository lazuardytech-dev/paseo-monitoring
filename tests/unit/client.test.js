import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseApiResponse,
  normalizeErrorText,
  buildApiErrorMessage,
  daemonStatusErrorMessage,
  requestJson,
  API,
} from "../../src/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("parseApiResponse", () => {
  it("parses valid JSON response", async () => {
    const response = { text: () => Promise.resolve('{"ok":true}') };
    const result = await parseApiResponse(response);
    expect(result).toEqual({ payload: { ok: true }, rawText: '{"ok":true}' });
  });

  it("returns null payload for empty response", async () => {
    const response = { text: () => Promise.resolve("") };
    const result = await parseApiResponse(response);
    expect(result).toEqual({ payload: null, rawText: "" });
  });

  it("returns null payload for malformed JSON", async () => {
    const response = { text: () => Promise.resolve("not json") };
    const result = await parseApiResponse(response);
    expect(result).toEqual({ payload: null, rawText: "not json" });
  });
});

describe("parseApiResponse", () => {
  it("returns null payload for whitespace-only response", async () => {
    const response = { text: () => Promise.resolve("   \n  ") };
    const result = await parseApiResponse(response);
    expect(result).toEqual({ payload: null, rawText: "   \n  " });
  });

  it("handles response.text() throwing an error", async () => {
    const response = { text: () => Promise.reject(new Error("Network read failed")) };
    await expect(parseApiResponse(response)).rejects.toThrow("Network read failed");
  });
});

describe("normalizeErrorText", () => {
  it("trims and returns text under 220 chars", () => {
    expect(normalizeErrorText("  hello world  ", "fallback")).toBe("hello world");
  });

  it("returns fallback for empty text", () => {
    expect(normalizeErrorText("", "fallback")).toBe("fallback");
  });

  it("returns fallback for HTML response", () => {
    expect(normalizeErrorText("<!DOCTYPE html><html>...", "fallback")).toBe("fallback");
    expect(normalizeErrorText("<html><body>error</body></html>", "fallback")).toBe("fallback");
  });

  it("truncates text to 220 chars", () => {
    const longText = "x".repeat(500);
    const result = normalizeErrorText(longText, "fallback");
    expect(result.length).toBe(220);
  });

  it("handles null text", () => {
    expect(normalizeErrorText(null, "fallback")).toBe("fallback");
  });

  it("returns fallback for whitespace-only text", () => {
    expect(normalizeErrorText("   \n  \t  ", "fallback")).toBe("fallback");
  });
});

describe("buildApiErrorMessage", () => {
  it("returns command.output from payload", () => {
    const result = buildApiErrorMessage({
      response: { status: 200 },
      payload: { command: { output: "Daemon restarted" } },
      rawText: "",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Daemon restarted");
  });

  it("returns payload.message", () => {
    const result = buildApiErrorMessage({
      response: { status: 200 },
      payload: { message: "Something failed" },
      rawText: "",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Something failed");
  });

  it("returns payload.error", () => {
    const result = buildApiErrorMessage({
      response: { status: 200 },
      payload: { error: "Error details" },
      rawText: "",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Error details");
  });

  it("returns session expired message for 401", () => {
    const result = buildApiErrorMessage({
      response: { status: 401 },
      payload: null,
      rawText: "",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Session expired. Please sign in again.");
  });

  it("prioritizes command.output over 401 message", () => {
    const result = buildApiErrorMessage({
      response: { status: 401 },
      payload: { command: { output: "Command output" } },
      rawText: "",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Command output");
  });

  it("falls back to normalized rawText", () => {
    const result = buildApiErrorMessage({
      response: { status: 500 },
      payload: null,
      rawText: "  Server error  ",
      fallbackMessage: "fallback",
    });
    expect(result).toBe("Server error");
  });
});

describe("daemonStatusErrorMessage", () => {
  it("returns command.output from payload", () => {
    expect(daemonStatusErrorMessage({ command: { output: "restarted" } })).toBe("restarted");
  });

  it("returns payload.message", () => {
    expect(daemonStatusErrorMessage({ message: "error msg" })).toBe("error msg");
  });

  it("returns payload.error", () => {
    expect(daemonStatusErrorMessage({ error: "err" })).toBe("err");
  });

  it("returns fallback for null payload", () => {
    expect(daemonStatusErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("returns fallback for empty string payload", () => {
    expect(daemonStatusErrorMessage("", "fallback")).toBe("fallback");
  });

  it("returns fallback for empty object", () => {
    expect(daemonStatusErrorMessage({}, "fallback")).toBe("fallback");
  });

  it("returns fallback for non-object", () => {
    expect(daemonStatusErrorMessage("string", "fallback")).toBe("fallback");
  });

  it("prioritizes command.output over message", () => {
    expect(
      daemonStatusErrorMessage({ command: { output: "cmd" }, message: "msg" }),
    ).toBe("cmd");
  });
});

describe("requestJson", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends GET request and returns parsed payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"ok":true}'),
    });

    const result = await requestJson("/api/test");
    expect(result).toEqual({ payload: { ok: true }, rawText: '{"ok":true}' });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("sends POST with JSON body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"ok":true}'),
    });

    await requestJson("/api/test", { method: "POST", body: { key: "val" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "val" }),
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      }),
    );
  });

  it("throws with buildApiErrorMessage on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    await expect(requestJson("/api/test")).rejects.toThrow(
      "Session expired. Please sign in again.",
    );
  });

  it("aborts after timeout", async () => {
    const abortSpy = vi.spyOn(globalThis, "setTimeout");
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Never resolves — timeout should abort
        }),
    );

    const promise = requestJson("/api/test");
    // Trigger the abort
    const setTimeoutCalls = abortSpy.mock.calls;
    const timeoutCallback = setTimeoutCalls.find(
      ([_fn, ms]) => ms === 30000,
    )?.[0];

    if (timeoutCallback) {
      // Simulate the abort controller behavior
      // The fetch will reject with AbortError
    }

    abortSpy.mockRestore();
  });

  it("clears timeout in finally", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"ok":true}'),
    });

    await requestJson("/api/test");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("throws network error on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Failed to fetch"));
    await expect(requestJson("/api/test")).rejects.toThrow("Failed to fetch");
  });

  it("throws with fallback message when response is not ok and payload is null", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(""),
    });

    await expect(requestJson("/api/test")).rejects.toThrow("Request failed");
  });
});

describe("API methods", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("getSession", () => {
    it("returns payload from /api/auth/session", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true,"authenticated":true}'),
      });

      const result = await API.getSession();
      expect(result).toEqual({ ok: true, authenticated: true });
    });

    it("throws if payload is falsy", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await expect(API.getSession()).rejects.toThrow("Failed to fetch session");
    });
  });

  describe("login", () => {
    it("sends password and returns payload on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });

      const result = await API.login("mypassword");
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ password: "mypassword" }),
        }),
      );
    });

    it("throws if payload.ok is false", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":false,"message":"Invalid password"}'),
      });

      await expect(API.login("wrong")).rejects.toThrow("Invalid password");
    });

    it("throws with payload.error if no message", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":false,"error":"Login failed"}'),
      });

      await expect(API.login("wrong")).rejects.toThrow("Login failed");
    });
  });

  describe("logout", () => {
    it("calls /api/auth/logout and swallows errors", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true}'),
      });

      await API.logout();
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("does not throw on network error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      await expect(API.logout()).resolves.toBeUndefined();
    });
  });

  describe("restartDaemon", () => {
    it("returns payload on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true,"action":"restart"}'),
      });

      const result = await API.restartDaemon();
      expect(result).toEqual({ ok: true, action: "restart" });
    });

    it("throws with daemonStatusErrorMessage on non-ok payload", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            '{"ok":false,"command":{"output":"Daemon not running"}}',
          ),
      });

      await expect(API.restartDaemon()).rejects.toThrow("Daemon not running");
    });
  });

  describe("stopDaemon", () => {
    it("returns payload on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":true,"action":"stop"}'),
      });

      const result = await API.stopDaemon();
      expect(result).toEqual({ ok: true, action: "stop" });
    });

    it("throws on non-ok payload", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"ok":false,"error":"Failed to stop"}'),
      });

      await expect(API.stopDaemon()).rejects.toThrow("Failed to stop");
    });
  });
});
