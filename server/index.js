const express = require("express");
const path = require("node:path");
const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  getAppPassword,
  isAuthenticatedRequest,
} = require("./auth");
const { getDaemonStatus, restartDaemon, stopDaemon } = require("./paseo");

const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 6004);
const publicDir = path.join(__dirname, "..", "dist");
const DAEMON_STREAM_INTERVAL_MS = 6000;
const DAEMON_STREAM_HEARTBEAT_MS = 15000;
const daemonStreamClients = new Set();
let daemonStreamLoopTimer = null;
let daemonStreamLoopActive = false;
let daemonStreamLatestSnapshot = null;
let daemonStreamFetchPromise = null;

app.disable("x-powered-by");
app.use(express.json());
app.use(express.static(publicDir, { index: false }));

function createDaemonStreamSnapshot(daemonStatus) {
  return {
    ok: daemonStatus.ok,
    daemon: daemonStatus,
    at: new Date().toISOString(),
  };
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function removeDaemonStreamClient(client) {
  if (!client) {
    return;
  }

  if (client.heartbeat) {
    clearInterval(client.heartbeat);
    client.heartbeat = null;
  }

  daemonStreamClients.delete(client);
  if (daemonStreamClients.size === 0) {
    daemonStreamLoopActive = false;
    if (daemonStreamLoopTimer) {
      clearTimeout(daemonStreamLoopTimer);
      daemonStreamLoopTimer = null;
    }
  }
}

function broadcastDaemonStreamSnapshot(snapshot) {
  daemonStreamLatestSnapshot = snapshot;

  for (const client of Array.from(daemonStreamClients)) {
    try {
      writeSseEvent(client.res, "status", snapshot);
    } catch {
      removeDaemonStreamClient(client);
    }
  }
}

async function fetchAndBroadcastDaemonStreamSnapshot() {
  if (daemonStreamFetchPromise) {
    await daemonStreamFetchPromise;
    return;
  }

  daemonStreamFetchPromise = (async () => {
    const daemonStatus = await getDaemonStatus();
    const snapshot = createDaemonStreamSnapshot(daemonStatus);
    broadcastDaemonStreamSnapshot(snapshot);
  })();

  try {
    await daemonStreamFetchPromise;
  } finally {
    daemonStreamFetchPromise = null;
  }
}

async function daemonStreamLoopTick() {
  if (!daemonStreamLoopActive || daemonStreamClients.size === 0) {
    return;
  }

  await fetchAndBroadcastDaemonStreamSnapshot();

  if (!daemonStreamLoopActive || daemonStreamClients.size === 0) {
    return;
  }

  daemonStreamLoopTimer = setTimeout(daemonStreamLoopTick, DAEMON_STREAM_INTERVAL_MS);
}

function startDaemonStreamLoop() {
  if (daemonStreamLoopActive) {
    return;
  }

  daemonStreamLoopActive = true;
  daemonStreamLoopTick();
}

function setSessionCookie(res) {
  const token = createSessionToken();

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
  });
}

function requireAuth(req, res, next) {
  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized",
    });
    return;
  }

  next();
}

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body || {};

  if (typeof password !== "string") {
    res.status(400).json({
      ok: false,
      message: "Password is required",
    });
    return;
  }

  if (password !== getAppPassword()) {
    clearSessionCookie(res);
    res.status(401).json({
      ok: false,
      message: "Invalid password",
    });
    return;
  }

  setSessionCookie(res);
  res.json({
    ok: true,
  });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  res.json({
    ok: true,
    authenticated: isAuthenticatedRequest(req),
  });
});

app.get("/api/daemon/status", requireAuth, async (_req, res) => {
  const daemonStatus = await getDaemonStatus();

  if (!daemonStatus.ok) {
    res.status(502).json(daemonStatus);
    return;
  }

  res.json(daemonStatus);
});

app.post("/api/daemon/restart", requireAuth, async (_req, res) => {
  const restarted = await restartDaemon();
  const daemonStatus = restarted.daemonStatus || (await getDaemonStatus());
  broadcastDaemonStreamSnapshot(createDaemonStreamSnapshot(daemonStatus));
  const restartSucceeded = Boolean(restarted.ok && daemonStatus.ok);

  res.status(restartSucceeded ? 200 : 502).json({
    ok: restartSucceeded,
    action: "restart",
    command: restarted,
    daemon: daemonStatus,
  });
});

app.post("/api/daemon/stop", requireAuth, async (_req, res) => {
  const stopped = await stopDaemon();
  const daemonStatus = await getDaemonStatus();
  broadcastDaemonStreamSnapshot(createDaemonStreamSnapshot(daemonStatus));

  res.status(stopped.ok ? 200 : 502).json({
    ok: stopped.ok,
    action: "stop",
    command: stopped,
    daemon: daemonStatus,
  });
});

app.get("/api/daemon/stream", requireAuth, async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write("retry: 5000\n\n");

  const client = {
    res,
    heartbeat: null,
  };

  client.heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      removeDaemonStreamClient(client);
    }
  }, DAEMON_STREAM_HEARTBEAT_MS);

  daemonStreamClients.add(client);

  req.on("close", () => {
    removeDaemonStreamClient(client);
  });

  if (daemonStreamLatestSnapshot) {
    try {
      writeSseEvent(res, "status", daemonStreamLatestSnapshot);
    } catch {
      removeDaemonStreamClient(client);
      return;
    }
  }

  startDaemonStreamLoop();
  await fetchAndBroadcastDaemonStreamSnapshot();
});

app.get(["/", "/login", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Not found",
  });
});

app.listen(port, host, () => {
  console.log(`Paseo Monitoring running on http://${host}:${port}`);
});
