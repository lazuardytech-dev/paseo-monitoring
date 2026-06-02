const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { getDaemonStatus } = require("./paseo");
const { writeState } = require("./state-store");

const COLLECT_INTERVAL_MS = 5000;
const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;

function getLogFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `collector-${date}.log`);
}

function formatLogEntry(status) {
  const ts = new Date().toISOString();
  return (
    JSON.stringify({
      ts,
      ok: status.ok,
      localDaemon: status.status?.localDaemon ?? null,
      connectedDaemon: status.status?.connectedDaemon ?? null,
      pid: status.status?.pid ?? null,
      cpu: status.metrics?.cpuPercent != null ? status.metrics.cpuPercent : null,
      ramMb: status.metrics?.memoryMb != null ? status.metrics.memoryMb : null,
    }) + "\n"
  );
}

async function appendToLog(entry) {
  const logFile = getLogFilePath();
  try {
    await fsPromises.appendFile(logFile, entry, "utf8");
  } catch (err) {
    console.error(`[collector] Failed to write log: ${err.message}`);
  }
}

async function rotateOldLogs() {
  try {
    const files = await fsPromises.readdir(LOG_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.startsWith("collector-") || !file.endsWith(".log")) {
        continue;
      }

      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = await fsPromises.stat(filePath);
        if (now - stat.mtimeMs > LOG_RETENTION_MS) {
          await fsPromises.unlink(filePath);
          console.error(`[collector] Rotated old log: ${file}`);
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // directory not found, skip
  }
}

async function collectAndStore() {
  const status = await getDaemonStatus();
  await writeState({
    ok: status.ok,
    daemon: status,
    at: new Date().toISOString(),
  });

  const logEntry = formatLogEntry(status);
  process.stderr.write(logEntry);
  await appendToLog(logEntry);

  if (typeof process.send === "function") {
    process.send({
      type: "collector:tick",
      data: {
        ok: status.ok,
        daemon: status,
        at: new Date().toISOString(),
      },
    });
  }
}

function shutdown() {
  console.error("[collector] Shutting down gracefully");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  try {
    await fsPromises.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error(`[collector] Failed to create log directory: ${err.message}`);
    process.exit(1);
  }

  rotateOldLogs();

  console.error(`[collector] Started (interval=${COLLECT_INTERVAL_MS}ms, log_dir=${LOG_DIR})`);

  const loop = async () => {
    await collectAndStore();
    setTimeout(loop, COLLECT_INTERVAL_MS);
  };

  loop();
}

main();
