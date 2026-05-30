const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");

const CPU_SAMPLE_INTERVAL_MS = 250;
const DAEMON_STATUS_TIMEOUT_MS = 45000;
const DAEMON_RESTART_TIMEOUT_MS = 90000;
const DAEMON_HEALTHCHECK_ATTEMPTS_NORMAL = 2;
const DAEMON_HEALTHCHECK_ATTEMPTS_FORCE = 3;
const DAEMON_HEALTHCHECK_RETRY_DELAY_MS = 3000;

function execute(command, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function extractJsonBlob(text) {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

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

function joinNonEmpty(lines) {
  return lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getCpuCoreCount() {
  if (typeof os.availableParallelism === "function") {
    const count = os.availableParallelism();
    if (Number.isFinite(count) && count > 0) {
      return count;
    }
  }

  const cores = os.cpus();
  if (Array.isArray(cores) && cores.length > 0) {
    return cores.length;
  }

  return 1;
}

const CPU_CORE_COUNT = getCpuCoreCount();

function parseProcessCpuTicks(processStatText) {
  if (!processStatText) {
    return null;
  }

  const trimmed = processStatText.trim();
  const lastParenIndex = trimmed.lastIndexOf(")");
  if (lastParenIndex < 0) {
    return null;
  }

  const trailingFields = trimmed.slice(lastParenIndex + 1).trim().split(/\s+/);
  if (trailingFields.length < 13) {
    return null;
  }

  const userTicks = parseNumber(trailingFields[11]);
  const systemTicks = parseNumber(trailingFields[12]);
  if (userTicks == null || systemTicks == null) {
    return null;
  }

  return userTicks + systemTicks;
}

function parseSystemCpuTicks(systemStatText) {
  if (!systemStatText) {
    return null;
  }

  const firstLine = systemStatText.split("\n")[0]?.trim() || "";
  if (!firstLine.startsWith("cpu ")) {
    return null;
  }

  const fields = firstLine.split(/\s+/).slice(1);
  if (fields.length === 0) {
    return null;
  }

  let totalTicks = 0;
  for (const field of fields) {
    const value = parseNumber(field);
    if (value == null) {
      return null;
    }
    totalTicks += value;
  }

  return totalTicks;
}

async function listProcessTreePids(rootPid) {
  try {
    const { stdout } = await execute("ps", ["-eo", "pid=,ppid="], 10000);
    const childMap = new Map();

    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      const values = line.trim().split(/\s+/);
      if (values.length < 2) {
        continue;
      }

      const pid = parseNumber(values[0]);
      const parentPid = parseNumber(values[1]);
      if (pid == null || parentPid == null) {
        continue;
      }

      if (!childMap.has(parentPid)) {
        childMap.set(parentPid, []);
      }
      childMap.get(parentPid).push(pid);
    }

    const queue = [rootPid];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const currentPid = queue.shift();
      const children = childMap.get(currentPid) || [];
      for (const childPid of children) {
        if (visited.has(childPid)) {
          continue;
        }
        visited.add(childPid);
        queue.push(childPid);
      }
    }

    return Array.from(visited);
  } catch {
    return [rootPid];
  }
}

async function sampleCpuTicksForPids(pids) {
  const uniquePids = Array.from(
    new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)),
  );
  if (uniquePids.length === 0) {
    return null;
  }

  try {
    const [systemStatText, processSamples] = await Promise.all([
      fs.readFile("/proc/stat", "utf8"),
      Promise.all(
        uniquePids.map(async (pid) => {
          try {
            const processStatText = await fs.readFile(`/proc/${pid}/stat`, "utf8");
            const processTicks = parseProcessCpuTicks(processStatText);
            if (processTicks == null) {
              return null;
            }

            return {
              pid,
              processTicks,
            };
          } catch {
            return null;
          }
        }),
      ),
    ]);

    const systemTicks = parseSystemCpuTicks(systemStatText);
    if (systemTicks == null) {
      return null;
    }

    const processTicksByPid = new Map();
    for (const sample of processSamples) {
      if (!sample) {
        continue;
      }

      processTicksByPid.set(sample.pid, sample.processTicks);
    }

    return {
      systemTicks,
      processTicksByPid,
    };
  } catch {
    return null;
  }
}

function sumProcessTickDelta(firstTicksByPid, secondTicksByPid) {
  let totalDelta = 0;
  let matchedPidCount = 0;

  for (const [pid, firstTicks] of firstTicksByPid.entries()) {
    const secondTicks = secondTicksByPid.get(pid);
    if (secondTicks == null) {
      continue;
    }

    matchedPidCount += 1;
    const delta = secondTicks - firstTicks;
    if (delta > 0) {
      totalDelta += delta;
    }
  }

  if (matchedPidCount === 0) {
    return null;
  }

  return totalDelta;
}

async function getInstantCpuPercent(pids) {
  const firstSample = await sampleCpuTicksForPids(pids);
  if (!firstSample) {
    return null;
  }

  await sleep(CPU_SAMPLE_INTERVAL_MS);

  const secondSample = await sampleCpuTicksForPids(pids);
  if (!secondSample) {
    return null;
  }

  const processDelta = sumProcessTickDelta(
    firstSample.processTicksByPid,
    secondSample.processTicksByPid,
  );
  const systemDelta = secondSample.systemTicks - firstSample.systemTicks;
  if (processDelta == null || systemDelta <= 0) {
    return null;
  }

  const instantCpu = (processDelta / systemDelta) * CPU_CORE_COUNT * 100;
  return Number(instantCpu.toFixed(2));
}

async function getMemoryMetrics(pids) {
  const uniquePids = Array.from(
    new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)),
  );
  if (uniquePids.length === 0) {
    return null;
  }

  try {
    const { stdout } = await execute(
      "ps",
      ["-o", "pid=,%mem=,rss=", "-p", uniquePids.join(",")],
      10000,
    );

    const lines = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return null;
    }

    let memoryPercent = 0;
    let rssKb = 0;
    let parsedRowCount = 0;

    for (const line of lines) {
      const values = line.split(/\s+/);
      if (values.length < 3) {
        continue;
      }

      const rowMemoryPercent = parseNumber(values[1]);
      const rowRssKb = parseNumber(values[2]);
      if (rowMemoryPercent == null || rowRssKb == null) {
        continue;
      }

      memoryPercent += rowMemoryPercent;
      rssKb += rowRssKb;
      parsedRowCount += 1;
    }

    if (parsedRowCount === 0) {
      return null;
    }

    return {
      memoryPercent: Number(memoryPercent.toFixed(2)),
      memoryMb: Number((rssKb / 1024).toFixed(2)),
      rssKb,
    };
  } catch {
    return null;
  }
}

async function getProcessMetrics(pid) {
  const processTreePids = await listProcessTreePids(pid);
  const monitoredPids = processTreePids.length > 0 ? processTreePids : [pid];

  const [cpuPercent, memoryMetrics] = await Promise.all([
    getInstantCpuPercent(monitoredPids),
    getMemoryMetrics(monitoredPids),
  ]);

  if (cpuPercent == null && !memoryMetrics) {
    return null;
  }

  return {
    cpuPercent,
    memoryPercent: memoryMetrics?.memoryPercent ?? null,
    memoryMb: memoryMetrics?.memoryMb ?? null,
    rssKb: memoryMetrics?.rssKb ?? null,
  };
}

async function getDaemonStatus() {
  let combinedOutput = "";

  try {
    const { stdout, stderr } = await execute(
      "paseo",
      ["daemon", "status", "--json"],
      DAEMON_STATUS_TIMEOUT_MS,
    );
    combinedOutput = `${stdout}\n${stderr}`.trim();
  } catch (error) {
    combinedOutput = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim();

    return {
      ok: false,
      error: "Unable to fetch daemon status",
      details: combinedOutput,
    };
  }

  const status = extractJsonBlob(combinedOutput);
  if (!status) {
    return {
      ok: false,
      error: "Unable to parse daemon status JSON",
      details: combinedOutput,
    };
  }

  const pid = parseNumber(status.pid);
  const metrics = pid ? await getProcessMetrics(pid) : null;

  return {
    ok: true,
    status,
    metrics,
  };
}

function isDaemonReachableStatus(daemonStatus) {
  return (
    Boolean(daemonStatus?.ok) &&
    daemonStatus?.status?.localDaemon === "running" &&
    daemonStatus?.status?.connectedDaemon === "reachable"
  );
}

function summarizeDaemonStatus(daemonStatus) {
  if (!daemonStatus || typeof daemonStatus !== "object") {
    return "unknown";
  }

  if (!daemonStatus.ok) {
    return daemonStatus.error || "unreachable";
  }

  const localDaemon = daemonStatus.status?.localDaemon || "unknown";
  const connectedDaemon = daemonStatus.status?.connectedDaemon || "unknown";
  const pid = daemonStatus.status?.pid ?? "-";

  return `local=${localDaemon}, connected=${connectedDaemon}, pid=${pid}`;
}

function buildRestartStepLabel(force) {
  return force ? "restart_force" : "restart";
}

async function executeRestartCommand(force = false) {
  const args = ["daemon", "restart", "--json"];
  if (force) {
    args.push("--force");
  }

  try {
    const { stdout, stderr } = await execute("paseo", args, DAEMON_RESTART_TIMEOUT_MS);

    return {
      step: buildRestartStepLabel(force),
      ok: true,
      forced: force,
      output: `${stdout}\n${stderr}`.trim(),
    };
  } catch (error) {
    return {
      step: buildRestartStepLabel(force),
      ok: false,
      forced: force,
      output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
      error: force ? "Failed to force restart daemon" : "Failed to restart daemon",
    };
  }
}

async function waitForReachableDaemon(attempts) {
  const statusChecks = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(DAEMON_HEALTHCHECK_RETRY_DELAY_MS);
    }

    const daemonStatus = await getDaemonStatus();
    statusChecks.push({
      attempt,
      ok: daemonStatus.ok,
      summary: summarizeDaemonStatus(daemonStatus),
    });

    if (isDaemonReachableStatus(daemonStatus)) {
      return {
        ok: true,
        daemonStatus,
        statusChecks,
      };
    }
  }

  return {
    ok: false,
    daemonStatus: null,
    statusChecks,
  };
}

async function restartDaemon() {
  const commandSteps = [];
  const healthChecks = [];

  const normalRestart = await executeRestartCommand(false);
  commandSteps.push(normalRestart);

  const normalHealth = await waitForReachableDaemon(DAEMON_HEALTHCHECK_ATTEMPTS_NORMAL);
  healthChecks.push(...normalHealth.statusChecks);

  if (normalHealth.ok) {
    return {
      ok: true,
      forced: false,
      output: joinNonEmpty([
        normalRestart.output,
        `Daemon recovered after restart: ${summarizeDaemonStatus(normalHealth.daemonStatus)}`,
      ]),
      steps: commandSteps,
      healthChecks,
      daemonStatus: normalHealth.daemonStatus,
    };
  }

  const forceRestart = await executeRestartCommand(true);
  commandSteps.push(forceRestart);

  const forceHealth = await waitForReachableDaemon(DAEMON_HEALTHCHECK_ATTEMPTS_FORCE);
  healthChecks.push(...forceHealth.statusChecks);

  if (forceHealth.ok) {
    return {
      ok: true,
      forced: true,
      output: joinNonEmpty([
        normalRestart.output,
        forceRestart.output,
        `Daemon recovered after force restart: ${summarizeDaemonStatus(forceHealth.daemonStatus)}`,
      ]),
      steps: commandSteps,
      healthChecks,
      daemonStatus: forceHealth.daemonStatus,
    };
  }

  const finalStatus =
    forceHealth.statusChecks[forceHealth.statusChecks.length - 1]?.summary ||
    normalHealth.statusChecks[normalHealth.statusChecks.length - 1]?.summary ||
    "unknown";

  return {
    ok: false,
    forced: true,
    error: "Daemon restart failed to recover a reachable daemon",
    output: joinNonEmpty([
      normalRestart.output,
      forceRestart.output,
      `Final daemon status: ${finalStatus}`,
    ]),
    steps: commandSteps,
    healthChecks,
  };
}

async function stopDaemon() {
  try {
    const { stdout, stderr } = await execute("paseo", [
      "daemon",
      "stop",
      "--json",
    ]);

    return {
      ok: true,
      output: `${stdout}\n${stderr}`.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
      error: "Failed to stop daemon",
    };
  }
}

module.exports = {
  getDaemonStatus,
  restartDaemon,
  stopDaemon,
};
