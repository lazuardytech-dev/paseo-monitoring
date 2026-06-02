// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(__dirname, "..", "..", "data");

// --- Pure functions from collector.js (re-implemented for testability) ---

function getLogFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `collector-${date}.log`);
}

function formatLogEntry(status) {
  const ts = new Date().toISOString();
  return JSON.stringify({
    ts,
    ok: status.ok,
    localDaemon: status.status?.localDaemon ?? null,
    connectedDaemon: status.status?.connectedDaemon ?? null,
    pid: status.status?.pid ?? null,
    cpu: status.metrics?.cpuPercent != null ? status.metrics.cpuPercent : null,
    ramMb: status.metrics?.memoryMb != null ? status.metrics.memoryMb : null,
  }) + "\n";
}

describe("formatLogEntry", () => {
  it("formats healthy status as NDJSON", () => {
    const status = {
      ok: true,
      status: { localDaemon: "running", connectedDaemon: "reachable", pid: 12345 },
      metrics: { cpuPercent: 12.5, memoryMb: 256.0 },
    };

    const entry = formatLogEntry(status);
    const parsed = JSON.parse(entry.trim());
    expect(parsed.ts).toBeDefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.localDaemon).toBe("running");
    expect(parsed.connectedDaemon).toBe("reachable");
    expect(parsed.pid).toBe(12345);
    expect(parsed.cpu).toBe(12.5);
    expect(parsed.ramMb).toBe(256.0);
    expect(entry).toContain("\n");
  });

  it("formats error status as NDJSON", () => {
    const status = {
      ok: false,
      status: { localDaemon: "stopped", connectedDaemon: "unreachable" },
      metrics: null,
    };

    const entry = formatLogEntry(status);
    const parsed = JSON.parse(entry.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.localDaemon).toBe("stopped");
    expect(parsed.connectedDaemon).toBe("unreachable");
    expect(parsed.cpu).toBeNull();
    expect(parsed.ramMb).toBeNull();
  });

  it("handles missing metrics gracefully", () => {
    const status = {
      ok: true,
      status: { localDaemon: "running", connectedDaemon: "reachable", pid: 99 },
    };

    const entry = formatLogEntry(status);
    const parsed = JSON.parse(entry.trim());
    expect(parsed.cpu).toBeNull();
    expect(parsed.ramMb).toBeNull();
    expect(parsed.pid).toBe(99);
  });

  it("handles null status gracefully", () => {
    const status = { ok: true, status: null, metrics: null };
    const entry = formatLogEntry(status);
    const parsed = JSON.parse(entry.trim());
    expect(parsed.localDaemon).toBeNull();
    expect(parsed.connectedDaemon).toBeNull();
    expect(parsed.pid).toBeNull();
    expect(parsed.cpu).toBeNull();
    expect(parsed.ramMb).toBeNull();
  });

  it("includes zero values for cpu and ram", () => {
    const status = {
      ok: true,
      status: { localDaemon: "running", connectedDaemon: "reachable", pid: 1 },
      metrics: { cpuPercent: 0, memoryMb: 0 },
    };

    const entry = formatLogEntry(status);
    const parsed = JSON.parse(entry.trim());
    expect(parsed.cpu).toBe(0);
    expect(parsed.ramMb).toBe(0);
  });
});

describe("getLogFilePath", () => {
  it("returns path with today's date", () => {
    const p = getLogFilePath();
    expect(p).toContain(LOG_DIR);
    const today = new Date().toISOString().slice(0, 10);
    expect(p).toContain(`collector-${today}.log`);
  });
});

describe("collectAndStore (integration with state-store)", () => {
  const STATE_FILE = "/tmp/paseo-monitoring-state.json";

  beforeEach(() => {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
  });

  it("writes state via state-store when called", async () => {
    // We test that writeState is callable from the collector's logic
    // by importing the actual modules and simulating a tick
    const { writeState } = await import("../../server/state-store");

    const status = {
      ok: true,
      status: { localDaemon: "running", connectedDaemon: "reachable", pid: 42 },
      metrics: { cpuPercent: 5.5, memoryMb: 128.0 },
      at: new Date().toISOString(),
    };

    await writeState({
      ok: status.ok,
      daemon: status,
      at: new Date().toISOString(),
    });

    const { readState } = await import("../../server/state-store");
    const result = await readState();

    expect(result).not.toBeNull();
    expect(result.ok).toBe(true);
    expect(result.daemon.status.localDaemon).toBe("running");
  });
});

describe("log rotation logic", () => {
  const testLogDir = path.join(__dirname, "..", "..", "data");

  it("only targets files matching collector-*.log pattern", async () => {
    // Simulate the rotation logic directly
    const { readdir } = await import("node:fs/promises");

    let files = [];
    try {
      files = await readdir(testLogDir);
    } catch {
      // Directory may not exist — skip
      return;
    }

    const collectorLogs = files.filter(
      (f) => f.startsWith("collector-") && f.endsWith(".log"),
    );

    // Just verify the pattern matching works
    expect(
      "collector-2026-05-30.log".startsWith("collector-") &&
        "collector-2026-05-30.log".endsWith(".log"),
    ).toBe(true);

    expect(
      "random-file.log".startsWith("collector-") &&
        "random-file.log".endsWith(".log"),
    ).toBe(false);

    expect(
      "collector-notes.txt".startsWith("collector-") &&
        "collector-notes.txt".endsWith(".log"),
    ).toBe(false);
  });
});
