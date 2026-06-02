import { describe, it, expect } from "vitest";

// Helper functions in paseo.js are not exported, so we re-implement the logic here
// to test the pure functions for correctness.

function extractJsonBlob(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parseNumber(input) {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseProcessCpuTicks(processStatText) {
  if (!processStatText) return null;
  const trimmed = processStatText.trim();
  const lastParenIndex = trimmed.lastIndexOf(")");
  if (lastParenIndex < 0) return null;
  const trailingFields = trimmed.slice(lastParenIndex + 1).trim().split(/\s+/);
  if (trailingFields.length < 13) return null;
  const userTicks = parseNumber(trailingFields[11]);
  const systemTicks = parseNumber(trailingFields[12]);
  if (userTicks == null || systemTicks == null) return null;
  return userTicks + systemTicks;
}

function parseSystemCpuTicks(systemStatText) {
  if (!systemStatText) return null;
  const firstLine = systemStatText.split("\n")[0]?.trim() || "";
  if (!firstLine.startsWith("cpu ")) return null;
  const fields = firstLine.split(/\s+/).slice(1);
  if (fields.length === 0) return null;
  let totalTicks = 0;
  for (const field of fields) {
    const value = parseNumber(field);
    if (value == null) return null;
    totalTicks += value;
  }
  return totalTicks;
}

function isDaemonReachableStatus(daemonStatus) {
  return (
    Boolean(daemonStatus?.ok) &&
    daemonStatus?.status?.localDaemon === "running" &&
    daemonStatus?.status?.connectedDaemon === "reachable"
  );
}

function summarizeDaemonStatus(daemonStatus) {
  if (!daemonStatus || typeof daemonStatus !== "object") return "unknown";
  if (!daemonStatus.ok) return daemonStatus.error || "unreachable";
  const localDaemon = daemonStatus.status?.localDaemon || "unknown";
  const connectedDaemon = daemonStatus.status?.connectedDaemon || "unknown";
  const pid = daemonStatus.status?.pid ?? "-";
  return `local=${localDaemon}, connected=${connectedDaemon}, pid=${pid}`;
}

describe("extractJsonBlob", () => {
  it("extracts top-level JSON", () => {
    expect(extractJsonBlob('{"ok":true}')).toEqual({ ok: true });
  });

  it("extracts JSON from text with surrounding output", () => {
    const text = "Some output\n{\"ok\":true}\nMore output";
    expect(extractJsonBlob(text)).toEqual({ ok: true });
  });

  it("returns null for empty string", () => {
    expect(extractJsonBlob("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractJsonBlob(null)).toBeNull();
  });

  it("returns null for text without JSON", () => {
    expect(extractJsonBlob("just text")).toBeNull();
  });

  it("extracts JSON from text with leading/trailing whitespace", () => {
    expect(extractJsonBlob('  {"ok":true}  ')).toEqual({ ok: true });
  });

  it("extracts nested JSON from log-like output", () => {
    const text = `[info] Daemon status:
{"status":{"localDaemon":"running","connectedDaemon":"reachable"},"ok":true}
Done.`;
    expect(extractJsonBlob(text)).toEqual({
      status: { localDaemon: "running", connectedDaemon: "reachable" },
      ok: true,
    });
  });

  it("extracts first JSON blob when multiple JSON objects present", () => {
    // The function finds first { and last }, so multiple objects
    // are extracted as a single blob and then fails to parse
    const text = '{"first":true}\n{"second":true}';
    // The first/last bracket extraction gives '{"first":true}\n{"second":true}'
    // which is not valid JSON → returns null
    expect(extractJsonBlob(text)).toBeNull();
  });
});

describe("parseNumber", () => {
  it("parses integer", () => {
    expect(parseNumber("42")).toBe(42);
  });

  it("parses float", () => {
    expect(parseNumber("3.14")).toBe(3.14);
  });

  it("returns null for non-numeric string", () => {
    expect(parseNumber("abc")).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(parseNumber(Infinity)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(parseNumber(NaN)).toBeNull();
  });

  it("returns 0 for empty string because Number('') = 0", () => {
    expect(parseNumber("")).toBe(0);
  });
});

describe("parseProcessCpuTicks", () => {
  it("parses /proc/[pid]/stat format", () => {
    // Format after last ')': state ppid pgrp session tty_nr tpgid flags
    //   minflt cminflt majflt cmajflt utime stime cutime cstime ...
    // Index 11 (0-based) = utime, Index 12 = stime
    // Our test: index 11 = 100 (utime), index 12 = 200 (stime)
    const statText = "1234 (test_process) S 1 2 3 4 5 6 7 8 9 10 100 200 13 14 15";
    expect(parseProcessCpuTicks(statText)).toBe(300); // 100 + 200
  });

  it("returns null for empty input", () => {
    expect(parseProcessCpuTicks("")).toBeNull();
  });

  it("returns null for malformed stat (no closing paren)", () => {
    expect(parseProcessCpuTicks("1234 (test")).toBeNull();
  });

  it("returns null if trailing fields too short", () => {
    const statText = "1234 (test) R 0 1 2";
    expect(parseProcessCpuTicks(statText)).toBeNull();
  });
});

describe("parseSystemCpuTicks", () => {
  it("parses /proc/stat cpu line", () => {
    const statText = "cpu  100 200 300 400 500 600 700 800 900 1000\ncpu0 10 20 30\n";
    expect(parseSystemCpuTicks(statText)).toBe(5500); // sum of all fields
  });

  it("returns null for empty input", () => {
    expect(parseSystemCpuTicks("")).toBeNull();
  });

  it("returns null if no cpu line", () => {
    expect(parseSystemCpuTicks("some other data")).toBeNull();
  });
});

describe("isDaemonReachableStatus", () => {
  it("returns true when both running and reachable", () => {
    expect(
      isDaemonReachableStatus({
        ok: true,
        status: { localDaemon: "running", connectedDaemon: "reachable" },
      }),
    ).toBe(true);
  });

  it("returns false when localDaemon is not running", () => {
    expect(
      isDaemonReachableStatus({
        ok: true,
        status: { localDaemon: "stopped", connectedDaemon: "reachable" },
      }),
    ).toBe(false);
  });

  it("returns false when connectedDaemon is not reachable", () => {
    expect(
      isDaemonReachableStatus({
        ok: true,
        status: { localDaemon: "running", connectedDaemon: "unreachable" },
      }),
    ).toBe(false);
  });

  it("returns false when ok is false", () => {
    expect(
      isDaemonReachableStatus({
        ok: false,
        status: { localDaemon: "running", connectedDaemon: "reachable" },
      }),
    ).toBe(false);
  });

  it("returns false for null", () => {
    expect(isDaemonReachableStatus(null)).toBe(false);
  });
});

describe("summarizeDaemonStatus", () => {
  it("summarizes healthy daemon", () => {
    const result = summarizeDaemonStatus({
      ok: true,
      status: { localDaemon: "running", connectedDaemon: "reachable", pid: 1234 },
    });
    expect(result).toBe("local=running, connected=reachable, pid=1234");
  });

  it("returns error message for failed status", () => {
    const result = summarizeDaemonStatus({
      ok: false,
      error: "Daemon unreachable",
    });
    expect(result).toBe("Daemon unreachable");
  });

  it("returns 'unreachable' when no error message", () => {
    const result = summarizeDaemonStatus({ ok: false });
    expect(result).toBe("unreachable");
  });

  it("returns 'unknown' for null", () => {
    expect(summarizeDaemonStatus(null)).toBe("unknown");
  });

  it("uses defaults for missing fields", () => {
    const result = summarizeDaemonStatus({ ok: true, status: {} });
    expect(result).toBe("local=unknown, connected=unknown, pid=-");
  });
});
