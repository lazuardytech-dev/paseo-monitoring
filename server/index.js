const express = require("express");
const path = require("node:path");
const child_process = require("node:child_process");
const {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  getAppPassword,
  isAuthenticatedRequest,
  parseCookies,
  revokeSessionToken,
} = require("./auth");
const {
  getDaemonStatus,
  restartDaemon,
  stopDaemon,
  isDaemonActionInProgress,
  resetDaemonActionLock,
} = require("./paseo");
const { readState } = require("./state-store");
const { initDatabase: initMetricsDb, insertSample, queryHistory, closeDatabase: closeMetricsDb } = require("./metrics");
const crypto = require("node:crypto");

function generateRequestId() {
  return crypto.randomUUID().slice(0, 8);
}

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const prometheus = require("prom-client");

if (!process.env.PASEO_MONITORING_PASSWORD) {
  console.error("FATAL: PASEO_MONITORING_PASSWORD environment variable is required");
  process.exit(1);
}

if (!process.env.PASEO_MONITORING_SESSION_SECRET || process.env.PASEO_MONITORING_SESSION_SECRET.length < 32) {
  console.error(
    "FATAL: PASEO_MONITORING_SESSION_SECRET environment variable is required and must be at least 32 characters",
  );
  process.exit(1);
}

const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 6004);
const publicDir = path.join(__dirname, "..", "dist");
const collectorUrl = process.env.COLLECTOR_URL ? process.env.COLLECTOR_URL.replace(/\/+$/, "") : "";
const DAEMON_STREAM_INTERVAL_MS = 6000;
const DAEMON_STREAM_HEARTBEAT_MS = process.env.NODE_ENV === "test" ? 1000 : 15000;
const daemonStreamClients = new Set();
let daemonStreamLoopTimer = null;
let daemonStreamLoopActive = false;
let daemonStreamLatestSnapshot = null;
let daemonStreamFetchPromise = null;

// Collector child process (P1-1: fork via IPC)
let collectorChild = null;
let collectorLatestState = null;

async function fetchCollectorState() {
  if (!collectorUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${collectorUrl}/internal/state`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[collector] ${collectorUrl}/internal/state returned ${response.status}`);
      return null;
    }

    const state = await response.json();
    if (!state?.daemon || !state?.at) {
      return null;
    }

    collectorLatestState = state;
    try {
      const d = state.daemon;
      insertSample({
        cpu: d.metrics?.cpuPercent,
        ramMb: d.metrics?.memoryMb,
        daemonStatus: d.ok ? "ok" : "error",
        localDaemon: d.status?.localDaemon,
        connectedDaemon: d.status?.connectedDaemon,
      });
    } catch (err) {
      console.error(`[collector] Failed to insert metrics sample: ${err.message}`);
    }

    return state;
  } catch (err) {
    console.warn(`[collector] Failed to fetch state from ${collectorUrl}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: false, limit: "8kb" }));
app.use(express.static(publicDir, { index: false }));

app.use((req, _res, next) => {
  req.id = generateRequestId();
  next();
});

function isCsrfSafeMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

// Custom header CSRF protection for state-changing endpoints
app.use((req, res, next) => {
  if (isCsrfSafeMethod(req.method)) {
    return next();
  }

  const customHeader = req.headers["x-requested-with"];
  if (customHeader === "XMLHttpRequest") {
    return next();
  }

  // Allow fetch API with Content-Type: application/json
  if (req.is("application/json")) {
    return next();
  }

  console.log(`[${req.id}] CSRF check failed for ${req.method} ${req.path}`);
  res.status(403).json({
    ok: false,
    message: "CSRF validation failed",
  });
});

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { ok: false, message: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "fonts.googleapis.com", "'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// Prometheus metrics (P1-5)
prometheus.collectDefaultMetrics({ register: prometheus.register });

const httpRequestCounter = new prometheus.Counter({
  name: "paseo_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status", "status_class"],
});

const httpRequestDurationHistogram = new prometheus.Histogram({
  name: "paseo_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const activeSseConnections = new prometheus.Gauge({
  name: "paseo_active_sse_connections",
  help: "Active SSE connections",
});

const daemonStatusGauge = new prometheus.Gauge({
  name: "paseo_daemon_status",
  help: "Daemon status (1=ok, 0=error)",
  labelNames: ["local_daemon", "connected_daemon"],
});

const httpErrorCounter = new prometheus.Counter({
  name: "paseo_http_errors_total",
  help: "Total HTTP errors (4xx/5xx)",
  labelNames: ["method", "path", "status"],
});

// Middleware to track request metrics
app.use((req, res, next) => {
  const end = httpRequestDurationHistogram.startTimer();
  res.on("finish", () => {
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    httpRequestCounter.inc({ method: req.method, path: req.path, status: res.statusCode, status_class: statusClass });
    end({ method: req.method, path: req.path, status: res.statusCode });
    if (res.statusCode >= 400) {
      httpErrorCounter.inc({ method: req.method, path: req.path, status: res.statusCode });
    }
  });
  next();
});

// Per-endpoint rate limiters (P1-8)
const healthLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const sessionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const logoutLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const daemonActionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { ok: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

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
  activeSseConnections.set(daemonStreamClients.size);
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

  // Update daemon status gauge
  if (snapshot?.daemon?.status) {
    const s = snapshot.daemon.status;
    daemonStatusGauge.set(
      { local_daemon: s.localDaemon, connected_daemon: s.connectedDaemon },
      s.localDaemon === "running" && s.connectedDaemon === "reachable" ? 1 : 0,
    );
  }

  for (const client of Array.from(daemonStreamClients)) {
    try {
      writeSseEvent(client.res, "status", snapshot);
    } catch {
      removeDaemonStreamClient(client);
    }
  }
}

async function fetchAndBroadcastDaemonStreamSnapshot() {
  // 1. Use in-memory state from collector IPC (lowest latency)
  if (collectorLatestState) {
    broadcastDaemonStreamSnapshot(collectorLatestState);
    return;
  }

  // 2. Remote collector service (Zeabur/private network)
  const remoteState = await fetchCollectorState();
  if (remoteState) {
    broadcastDaemonStreamSnapshot(remoteState);
    return;
  }

  // 3. Fallback to state file (cache for restart survival)
  const cached = await readState();
  if (cached) {
    broadcastDaemonStreamSnapshot(cached);
    return;
  }

  if (process.env.NODE_ENV === "test") {
    broadcastDaemonStreamSnapshot(
      createDaemonStreamSnapshot({
        ok: false,
        error: "Daemon status unavailable in test mode",
        status: {
          localDaemon: "unknown",
          connectedDaemon: "unknown",
          pid: null,
        },
        metrics: null,
      }),
    );
    return;
  }

  // 4. Last resort: direct daemon CLI call (cold start, no collector yet)
  if (daemonStreamFetchPromise) {
    await daemonStreamFetchPromise;
    return;
  }

  daemonStreamFetchPromise = (async () => {
    console.warn("[SSE] Cache stale, falling back to direct daemon call");
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
  try {
    if (!daemonStreamLoopActive || daemonStreamClients.size === 0) {
      return;
    }

    await fetchAndBroadcastDaemonStreamSnapshot();

    if (!daemonStreamLoopActive || daemonStreamClients.size === 0) {
      return;
    }

    daemonStreamLoopTimer = setTimeout(daemonStreamLoopTick, DAEMON_STREAM_INTERVAL_MS);
  } catch (err) {
    console.error(`[SSE] Error in daemonStreamLoopTick: ${err.message}`);
    daemonStreamLoopTimer = setTimeout(daemonStreamLoopTick, DAEMON_STREAM_INTERVAL_MS);
  }
}

function startDaemonStreamLoop() {
  if (daemonStreamLoopActive) {
    return;
  }

  daemonStreamLoopActive = true;
  daemonStreamLoopTick();
}

function shouldUseSecureCookie() {
  return process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
}

function setSessionCookie(res) {
  const token = createSessionToken();

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureCookie(),
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

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { password } = req.body || {};

  if (typeof password !== "string" || password.length > 1024) {
    console.log(`[${req.id}] POST /api/auth/login 400`);
    res.status(400).json({
      ok: false,
      message: "Password is required",
    });
    return;
  }

  const appPassword = getAppPassword();
  const passwordBuffer = Buffer.from(password);
  const appPasswordBuffer = Buffer.from(appPassword);

  if (
    passwordBuffer.length !== appPasswordBuffer.length ||
    !crypto.timingSafeEqual(passwordBuffer, appPasswordBuffer)
  ) {
    clearSessionCookie(res);
    console.log(`[${req.id}] POST /api/auth/login 401`);
    res.status(401).json({
      ok: false,
      message: "Invalid password",
    });
    return;
  }

  setSessionCookie(res);
  console.log(`[${req.id}] POST /api/auth/login 200`);
  res.json({
    ok: true,
  });
});

app.post("/api/auth/logout", logoutLimiter, (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) {
    revokeSessionToken(token);
  }

  clearSessionCookie(res);
  console.log(`[${req.id}] POST /api/auth/logout 200`);
  res.json({ ok: true });
});

app.get("/api/auth/session", sessionLimiter, (req, res) => {
  res.json({
    ok: true,
    authenticated: isAuthenticatedRequest(req),
  });
});

app.get("/api/daemon/status", requireAuth, async (req, res) => {
  // 1. In-memory from collector IPC
  if (collectorLatestState?.daemon) {
    console.log(`[${req.id}] GET /api/daemon/status 200 (collector IPC)`);
    res.json(collectorLatestState.daemon);
    return;
  }

  // 2. Remote collector service (Zeabur/private network)
  const remoteState = await fetchCollectorState();
  if (remoteState?.daemon) {
    console.log(`[${req.id}] GET /api/daemon/status 200 (collector url)`);
    res.json(remoteState.daemon);
    return;
  }

  // 3. State file fallback
  const cached = await readState();
  if (cached?.daemon) {
    console.log(`[${req.id}] GET /api/daemon/status 200 (file cache)`);
    res.json(cached.daemon);
    return;
  }

  console.warn(`[${req.id}] GET /api/daemon/status cache miss, calling daemon directly`);
  const daemonStatus = await getDaemonStatus();

  if (!daemonStatus.ok) {
    console.log(`[${req.id}] GET /api/daemon/status 502`);
    res.status(502).json(daemonStatus);
    return;
  }

  console.log(`[${req.id}] GET /api/daemon/status 200 (direct)`);
  res.json(daemonStatus);
});

app.post("/api/daemon/restart", actionLimiter, requireAuth, async (req, res) => {
  const restarted = await restartDaemon();
  const daemonStatus = restarted.daemonStatus || (await getDaemonStatus());
  broadcastDaemonStreamSnapshot(createDaemonStreamSnapshot(daemonStatus));
  const restartSucceeded = Boolean(restarted.ok && daemonStatus.ok);

  console.log(`[${req.id}] POST /api/daemon/restart ${restartSucceeded ? 200 : 502}`);

  res.status(restartSucceeded ? 200 : 502).json({
    ok: restartSucceeded,
    action: "restart",
    daemon: daemonStatus,
  });
});

app.post("/api/daemon/stop", actionLimiter, requireAuth, async (req, res) => {
  const stopped = await stopDaemon();
  const daemonStatus = await getDaemonStatus();
  broadcastDaemonStreamSnapshot(createDaemonStreamSnapshot(daemonStatus));

  console.log(`[${req.id}] POST /api/daemon/stop ${stopped.ok ? 200 : 502}`);

  res.status(stopped.ok ? 200 : 502).json({
    ok: stopped.ok,
    action: "stop",
    daemon: daemonStatus,
  });
});

app.get("/api/metrics/history", requireAuth, (req, res) => {
  const range = req.query.range || "1h";
  console.log(`[${req.id}] GET /api/metrics/history?range=${range}`);

  try {
    const result = queryHistory(range);
    res.json(result);
  } catch (err) {
    console.error(`[${req.id}] GET /api/metrics/history error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/daemon/stream", requireAuth, async (req, res) => {
  const MAX_SSE_CLIENTS = 50;
  if (daemonStreamClients.size >= MAX_SSE_CLIENTS) {
    res.status(503).json({ ok: false, message: "Too many SSE clients" });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  res.write("retry: 5000\n\n");

  const SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  const idleTimer = setTimeout(() => {
    try {
      res.end();
    } catch {
      // ignore
    }
    removeDaemonStreamClient(client);
  }, SSE_IDLE_TIMEOUT_MS);

  const client = {
    res,
    heartbeat: null,
  };

  client.heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
      idleTimer.refresh();
    } catch {
      removeDaemonStreamClient(client);
    }
  }, DAEMON_STREAM_HEARTBEAT_MS);

  activeSseConnections.set(daemonStreamClients.size);
  daemonStreamClients.add(client);
  activeSseConnections.set(daemonStreamClients.size);

  req.on("close", () => {
    clearTimeout(idleTimer);
    removeDaemonStreamClient(client);
  });

  if (daemonStreamLatestSnapshot) {
    try {
      writeSseEvent(res, "status", daemonStreamLatestSnapshot);
    } catch {
      clearTimeout(idleTimer);
      removeDaemonStreamClient(client);
      return;
    }
  }

  startDaemonStreamLoop();
  await fetchAndBroadcastDaemonStreamSnapshot();
});

app.get("/api/health", healthLimiter, (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/metrics", async (_req, res) => {
  res.setHeader("Content-Type", prometheus.register.contentType);
  res.end(await prometheus.register.metrics());
});

app.get(["/", "/login", "/dashboard"], (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err, req, res, _next) => {
  const requestId = req.id || "?";

  if (err.type === "entity.parse.failed") {
    console.log(`[${requestId}] ERROR Invalid JSON body`);
    res.status(400).json({
      ok: false,
      message: "Invalid JSON in request body",
    });
    return;
  }

  if (err.type === "entity.too.large") {
    console.log(`[${requestId}] ERROR Request body too large`);
    res.status(413).json({
      ok: false,
      message: "Request body too large",
    });
    return;
  }

  console.error(`[${requestId}] ERROR ${err.message || err}`);
  console.error(err.stack);

  const statusCode = err.statusCode || err.status || 500;
  const isOperational = Boolean(err.isOperational || err.expose);
  const message = isOperational ? err.message : "Internal server error";

  res.status(statusCode).json({
    ok: false,
    message,
  });
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    message: "Not found",
  });
});

function forkCollector() {
  if (collectorUrl || process.env.DISABLE_EMBEDDED_COLLECTOR === "true") {
    console.log("[Startup] Embedded collector disabled");
    return;
  }

  // In PM2 cluster mode, only fork from the primary instance (pm_id=0)
  const pmId = process.env.pm_id;
  if (pmId !== undefined && pmId !== "0") {
    return;
  }

  console.log("[Startup] Forking collector child process");

  collectorChild = child_process.fork(path.join(__dirname, "collector.js"), [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env },
  });

  collectorChild.on("message", (msg) => {
    if (msg.type === "collector:tick" && msg.data) {
      // Update in-memory state
      collectorLatestState = msg.data;

      // Also insert into SQLite metrics DB
      const d = msg.data.daemon;
      try {
        insertSample({
          cpu: d.metrics?.cpuPercent,
          ramMb: d.metrics?.memoryMb,
          daemonStatus: d.ok ? "ok" : "error",
          localDaemon: d.status?.localDaemon,
          connectedDaemon: d.status?.connectedDaemon,
        });
      } catch (err) {
        console.error(`[collector] Failed to insert metrics sample: ${err.message}`);
      }
    }
  });

  collectorChild.on("exit", (code, signal) => {
    console.log(`[collector] Child exited (code=${code}, signal=${signal}), restarting in 5s`);
    collectorChild = null;
    setTimeout(forkCollector, 5000);
  });

  collectorChild.on("error", (err) => {
    console.error(`[collector] Child error: ${err.message}`);
    collectorChild = null;
  });
}

function stopCollector() {
  if (!collectorChild) return;

  try {
    collectorChild.disconnect();
  } catch {
    // ignore
  }

  collectorChild = null;
}

const server = app.listen(port, host, () => {
  console.log(`Paseo Monitoring running on http://${host}:${port}`);

  // Seed daemon state from cache on startup
  readState().then((cached) => {
    if (cached) {
      daemonStreamLatestSnapshot = cached;
      console.log(`[Startup] Seeded daemon state from cache (age=${Date.now() - new Date(cached.at).getTime()}ms)`);
    }
  });

  // Initialize metrics DB
  try {
    initMetricsDb();
    console.log("[Startup] Metrics database initialized");
  } catch (err) {
    console.error(`[Startup] Failed to init metrics DB: ${err.message}`);
  }

  // Fork collector as child process (P1-1)
  forkCollector();
});

function gracefulShutdown(signal) {
  console.log(`[${signal}] Initiating graceful shutdown`);
  daemonStreamLoopActive = false;

  if (daemonStreamLoopTimer) {
    clearTimeout(daemonStreamLoopTimer);
    daemonStreamLoopTimer = null;
  }

  for (const client of Array.from(daemonStreamClients)) {
    removeDaemonStreamClient(client);
  }

  const waitForDaemonAction = () => {
    if (isDaemonActionInProgress()) {
      console.log(`[${signal}] Waiting for in-flight daemon action to complete`);
      return new Promise((resolve) => {
        let waited = 0;
        const check = setInterval(() => {
          waited += 100;
          if (!isDaemonActionInProgress() || waited >= 5000) {
            clearInterval(check);
            if (isDaemonActionInProgress()) {
              console.log(`[${signal}] Daemon action did not complete within 5s, forcing reset`);
              resetDaemonActionLock();
            }
            resolve();
          }
        }, 100);
      });
    }
    return Promise.resolve();
  };

  waitForDaemonAction().then(() => {
    stopCollector();
    closeMetricsDb();
    server.closeIdleConnections();
    server.close(() => {
      console.log("Graceful shutdown complete");
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
  if (reason instanceof Error) {
    console.error(reason.stack);
  }
  gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught Exception: ${err.message}`);
  console.error(err.stack);
  gracefulShutdown("uncaughtException");
});

module.exports = server;
