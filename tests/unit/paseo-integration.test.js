// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const queuedExecResponses = [];

function queueExecSuccess(stdout = "", stderr = "") {
  queuedExecResponses.push((_command, _args, _options, callback) => {
    callback(null, stdout, stderr);
  });
}

function queueExecFailure(message, stdout = "", stderr = "") {
  queuedExecResponses.push((_command, _args, _options, callback) => {
    const error = new Error(message);
    error.stdout = stdout;
    error.stderr = stderr;
    callback(error, stdout, stderr);
  });
}

function testExecFile(command, args, options, callback) {
  const next = queuedExecResponses.shift();
  if (!next) {
    const error = new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
    callback(error, "", "");
    return;
  }
  next(command, args, options, callback);
}

describe("paseo.js exports (with mocked cli runner)", () => {
  let paseo;

  beforeEach(async () => {
    vi.resetModules();
    queuedExecResponses.length = 0;
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "test" };
    globalThis.__PASEO_EXEC_FILE__ = vi.fn(testExecFile);
    paseo = await import("../../server/paseo");
  });

  afterEach(() => {
    delete globalThis.__PASEO_EXEC_FILE__;
    process.env = { ...ORIGINAL_ENV };
  });

  describe("getDaemonStatus", () => {
    it("returns parsed daemon status on success", async () => {
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "running",
          connectedDaemon: "reachable",
          pid: 12345,
          daemonVersion: "1.2.3",
          cliVersion: "0.1.0",
          hostname: "test-server",
          listen: "127.0.0.1:8080",
          metrics: {
            cpuPercent: 5.5,
            memoryPercent: 10.2,
            memoryMb: 128.0,
          },
        }),
      );
      // listProcessTreePids `ps -eo`, then getMemoryMetrics `ps -o ...`
      queueExecFailure("process tree unavailable");
      queueExecFailure("memory metrics unavailable");

      const result = await paseo.getDaemonStatus();
      expect(result.ok).toBe(true);
      expect(result.status.localDaemon).toBe("running");
      expect(result.status.connectedDaemon).toBe("reachable");
      expect(result.status.pid).toBe(12345);
      expect(result.metrics.cpuPercent).toBe(5.5);
    });

    it("returns error status when daemon command fails", async () => {
      queueExecFailure("Command failed: paseo not found");

      const result = await paseo.getDaemonStatus();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("handles non-JSON output gracefully", async () => {
      queueExecSuccess("Some random terminal output\nwith no JSON");

      const result = await paseo.getDaemonStatus();
      expect(result.ok).toBe(false);
    });

    it("handles empty output", async () => {
      queueExecSuccess("");

      const result = await paseo.getDaemonStatus();
      expect(result.ok).toBe(false);
    });
  });

  describe("restartDaemon", () => {
    it("returns ok true on successful restart", async () => {
      queueExecSuccess(JSON.stringify({ ok: true })); // restart command
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "running",
          connectedDaemon: "reachable",
        }),
      ); // health check status

      const result = await paseo.restartDaemon();
      expect(result.ok).toBe(true);
      expect(result.forced).toBe(false);
    });

    it("returns error when daemon cannot recover after restart attempts", async () => {
      queueExecFailure("paseo restart failed"); // normal restart command

      // normal health checks (2 attempts)
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "stopped",
          connectedDaemon: "unreachable",
        }),
      );
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "stopped",
          connectedDaemon: "unreachable",
        }),
      );

      queueExecFailure("paseo force restart failed"); // force restart command

      // force health checks (3 attempts)
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "stopped",
          connectedDaemon: "unreachable",
        }),
      );
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "stopped",
          connectedDaemon: "unreachable",
        }),
      );
      queueExecSuccess(
        JSON.stringify({
          localDaemon: "stopped",
          connectedDaemon: "unreachable",
        }),
      );

      const result = await paseo.restartDaemon();
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe("stopDaemon", () => {
    it("returns ok true on successful stop", async () => {
      queueExecSuccess(JSON.stringify({ ok: true }));

      const result = await paseo.stopDaemon();
      expect(result.ok).toBe(true);
    });

    it("returns error when stop command fails", async () => {
      queueExecFailure("paseo stop failed");

      const result = await paseo.stopDaemon();
      expect(result.ok).toBe(false);
    });
  });
});
