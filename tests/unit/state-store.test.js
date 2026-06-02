// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "/tmp/paseo-monitoring-state.json";

describe("state-store", () => {
  beforeEach(() => {
    // Clean up any existing state file
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
    // Also clean up temp files
    const dir = path.dirname(STATE_FILE);
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith("paseo-monitoring-state.json")) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {
          // ignore
        }
      }
    }
  });

  describe("readState and writeState", () => {
    it("writes and reads state successfully", async () => {
      const { writeState, readState } = await import("../../server/state-store");

      const state = {
        ok: true,
        daemon: { status: { localDaemon: "running" } },
        at: new Date().toISOString(),
      };

      await writeState(state);
      const result = await readState();
      expect(result).toEqual(state);
    });

    it("returns null if state file does not exist", async () => {
      const { readState } = await import("../../server/state-store");
      const result = await readState();
      expect(result).toBeNull();
    });

    it("returns null for stale state (older than 30s)", async () => {
      const { writeState, readState } = await import("../../server/state-store");

      const staleState = {
        ok: true,
        daemon: {},
        at: new Date(Date.now() - 60000).toISOString(), // 60s ago
      };

      await writeState(staleState);
      const result = await readState();
      expect(result).toBeNull();
    });

    it("returns null for corrupted state", async () => {
      const { readState } = await import("../../server/state-store");
      fs.writeFileSync(STATE_FILE, "not-json", "utf8");
      const result = await readState();
      expect(result).toBeNull();
    });

    it("handles concurrent writes via atomic rename", async () => {
      const { writeState, readState } = await import("../../server/state-store");

      const state1 = {
        ok: true,
        daemon: { test: "first" },
        at: new Date().toISOString(),
      };

      const state2 = {
        ok: true,
        daemon: { test: "second" },
        at: new Date().toISOString(),
      };

      await Promise.all([writeState(state1), writeState(state2)]);
      const result = await readState();
      // One of the two should win
      expect(result).not.toBeNull();
      expect(["first", "second"]).toContain(result.daemon.test);
    });
  });
});
