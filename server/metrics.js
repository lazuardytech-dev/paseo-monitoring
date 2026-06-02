const Database = require("better-sqlite3");
const path = require("node:path");

const DB_PATH = process.env.METRICS_DB_PATH || path.join(__dirname, "..", "data", "metrics.db");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let db = null;
let purgeTimer = null;

function initDatabase() {
  if (db) return;

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      cpu REAL,
      ram_mb REAL,
      daemon_status TEXT,
      local_daemon TEXT,
      connected_daemon TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics_samples(timestamp);
  `);

  autoPurge();

  // Auto-purge every hour
  purgeTimer = setInterval(autoPurge, 3600000);
  if (purgeTimer && typeof purgeTimer.unref === "function") {
    purgeTimer.unref();
  }
}

function insertSample({ cpu, ramMb, daemonStatus, localDaemon, connectedDaemon }) {
  if (!db) initDatabase();

  const stmt = db.prepare(`
    INSERT INTO metrics_samples (timestamp, cpu, ram_mb, daemon_status, local_daemon, connected_daemon)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    Date.now(),
    cpu != null ? cpu : null,
    ramMb != null ? ramMb : null,
    daemonStatus ?? null,
    localDaemon ?? null,
    connectedDaemon ?? null,
  );
}

function queryHistory(range) {
  if (!db) initDatabase();

  const ranges = {
    "1h": 3600000,
    "6h": 21600000,
    "24h": 86400000,
    "7d": 604800000,
  };

  const windowMs = ranges[range];
  if (!windowMs) {
    return { ok: false, error: "Invalid range. Use 1h, 6h, 24h, or 7d" };
  }

  const cutoff = Date.now() - windowMs;

  const rows = db
    .prepare(
      `
    SELECT
      (timestamp / 60000) * 60000 AS minute,
      COUNT(*) AS count,
      ROUND(AVG(cpu), 2) AS avg_cpu,
      ROUND(MIN(cpu), 2) AS min_cpu,
      ROUND(MAX(cpu), 2) AS max_cpu,
      ROUND(AVG(ram_mb), 2) AS avg_ram_mb,
      ROUND(MIN(ram_mb), 2) AS min_ram_mb,
      ROUND(MAX(ram_mb), 2) AS max_ram_mb,
      GROUP_CONCAT(DISTINCT daemon_status) AS daemon_statuses,
      GROUP_CONCAT(DISTINCT local_daemon) AS local_daemons
    FROM metrics_samples
    WHERE timestamp > ?
    GROUP BY minute
    ORDER BY minute ASC
  `,
    )
    .all(cutoff);

  return { ok: true, range, samples: rows };
}

function autoPurge() {
  if (!db) return;

  const cutoff = Date.now() - RETENTION_MS;
  const result = db.prepare("DELETE FROM metrics_samples WHERE timestamp < ?").run(cutoff);

  if (result.changes > 0) {
    console.log(`[metrics] Purged ${result.changes} old samples`);
  }

  // Vacuum periodically
  db.prepare("PRAGMA incremental_vacuum(0)").run();
}

function closeDatabase() {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }

  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDatabase, insertSample, queryHistory, closeDatabase };
