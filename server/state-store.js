const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const STATE_FILE = process.env.STATE_FILE_PATH || "/tmp/paseo-monitoring-state.json";
const STALE_AFTER_MS = 30_000;
let writeCounter = 0;

async function writeState(state) {
  const data = JSON.stringify(state);
  writeCounter += 1;
  const suffix = `${process.pid}.${Date.now()}.${writeCounter}.${crypto.randomUUID()}`;
  const tmpFile = `${STATE_FILE}.${suffix}.tmp`;
  await fs.writeFile(tmpFile, data, "utf8");
  await fs.rename(tmpFile, STATE_FILE);
}

async function readState() {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    const state = JSON.parse(data);
    const age = Date.now() - new Date(state.at).getTime();
    if (age > STALE_AFTER_MS) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

module.exports = { writeState, readState };
