import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "/tmp/paseo-monitoring-state.json";

describe("State store edge cases", () => {
  beforeEach(() => {
    // Clean up
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // ignore
    }
    const dir = path.dirname(STATE_FILE);
    try {
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
    } catch {
      // ignore
    }
  });

  it("handles concurrent read/write correctly", async () => {
    const { writeState, readState } = await import("../../server/state-store");

    const state = {
      ok: true,
      daemon: { test: "data" },
      at: new Date().toISOString(),
    };

    await writeState(state);

    // Multiple concurrent reads should all return the same data
    const results = await Promise.all([
      readState(),
      readState(),
      readState(),
    ]);

    results.forEach((result) => {
      expect(result).toEqual(state);
    });
  });

  it("handles empty daemon state gracefully", async () => {
    const { writeState, readState } = await import("../../server/state-store");

    const emptyState = {
      ok: false,
      daemon: null,
      at: new Date().toISOString(),
    };

    await writeState(emptyState);
    const result = await readState();
    expect(result).toEqual(emptyState);
  });

  it("preserves state across rapid writes", async () => {
    const { writeState, readState } = await import("../../server/state-store");

    const states = [];
    for (let i = 0; i < 10; i++) {
      const s = {
        ok: true,
        daemon: { iteration: i },
        at: new Date().toISOString(),
      };
      states.push(s);
    }

    // Write all rapidly
    await Promise.all(states.map((s) => writeState(s)));

    const final = await readState();
    expect(final).not.toBeNull();
    // The last one should have won
    expect(typeof final.daemon.iteration).toBe("number");
  });

  it("recovers after corrupted state file", async () => {
    const { writeState, readState } = await import("../../server/state-store");

    // Write corrupted data
    fs.writeFileSync(STATE_FILE, "corrupted{json", "utf8");

    // Read should return null
    const result1 = await readState();
    expect(result1).toBeNull();

    // Write valid state
    const state = {
      ok: true,
      daemon: { recovered: true },
      at: new Date().toISOString(),
    };

    await writeState(state);
    const result2 = await readState();
    expect(result2).toEqual(state);
  });
});
