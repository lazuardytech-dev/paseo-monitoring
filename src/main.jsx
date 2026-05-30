import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster, toast } from "sonner";
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  LoaderCircle,
  LogOut,
  RefreshCcw,
  Server,
  SquarePower,
} from "lucide-react";
import "sonner/dist/styles.css";
import "./styles.css";

async function parseApiResponse(response) {
  const rawText = await response.text();
  let payload = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }
  }

  return { payload, rawText };
}

function normalizeErrorText(text, fallbackMessage) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return fallbackMessage;
  }

  if (cleaned.startsWith("<!DOCTYPE") || cleaned.startsWith("<html")) {
    return fallbackMessage;
  }

  return cleaned.slice(0, 220);
}

function buildApiErrorMessage({ response, payload, rawText, fallbackMessage }) {
  if (payload && typeof payload === "object") {
    return (
      payload.command?.output ||
      payload.message ||
      payload.error ||
      fallbackMessage
    );
  }

  if (response.status === 401) {
    return "Session expired. Please sign in again.";
  }

  return normalizeErrorText(rawText, fallbackMessage);
}

function daemonStatusErrorMessage(daemonPayload, fallbackMessage = "Status request failed") {
  if (!daemonPayload || typeof daemonPayload !== "object") {
    return fallbackMessage;
  }

  return (
    daemonPayload.command?.output ||
    daemonPayload.message ||
    daemonPayload.error ||
    fallbackMessage
  );
}

const API = {
  async getSession() {
    const response = await fetch("/api/auth/session", {
      credentials: "include",
    });
    const { payload, rawText } = await parseApiResponse(response);

    if (!response.ok || !payload) {
      throw new Error(
        buildApiErrorMessage({
          response,
          payload,
          rawText,
          fallbackMessage: "Failed to fetch session",
        }),
      );
    }

    return payload;
  },

  async login(password) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ password }),
    });
    const { payload, rawText } = await parseApiResponse(response);
    if (!response.ok || !payload.ok) {
      throw new Error(
        buildApiErrorMessage({
          response,
          payload,
          rawText,
          fallbackMessage: "Login failed",
        }),
      );
    }

    return payload;
  },

  async logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  },

  async restartDaemon() {
    const response = await fetch("/api/daemon/restart", {
      method: "POST",
      credentials: "include",
    });
    const { payload, rawText } = await parseApiResponse(response);
    if (!response.ok || !payload.ok) {
      throw new Error(
        buildApiErrorMessage({
          response,
          payload,
          rawText,
          fallbackMessage: "Failed to restart daemon",
        }),
      );
    }

    return payload;
  },

  async stopDaemon() {
    const response = await fetch("/api/daemon/stop", {
      method: "POST",
      credentials: "include",
    });
    const { payload, rawText } = await parseApiResponse(response);
    if (!response.ok || !payload.ok) {
      throw new Error(
        buildApiErrorMessage({
          response,
          payload,
          rawText,
          fallbackMessage: "Failed to stop daemon",
        }),
      );
    }

    return payload;
  },
};

function formatNumber(value, unit = "") {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }

  return `${Number(value).toFixed(2)}${unit}`;
}

function formatDate(isoString) {
  if (!isoString) {
    return "-";
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString();
}

function toStatusLabel(value) {
  if (!value) {
    return "Unknown";
  }

  return String(value)
    .split("_")
    .map((part) => {
      if (!part) {
        return part;
      }

      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function useSessionGuard({ redirectIfAuthenticated = false } = {}) {
  const [loading, setLoading] = React.useState(true);
  const [authenticated, setAuthenticated] = React.useState(false);

  React.useEffect(() => {
    let active = true;

    API.getSession()
      .then((payload) => {
        if (!active) {
          return;
        }

        setAuthenticated(Boolean(payload.authenticated));
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setAuthenticated(false);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return { loading: true, allow: false };
  }

  if (redirectIfAuthenticated) {
    return {
      loading: false,
      allow: !authenticated,
    };
  }

  return {
    loading: false,
    allow: authenticated,
  };
}

function FullPageLoader() {
  return (
    <div className="page page-center">
      <div className="loader-card">
        <Gauge size={18} />
        <span>Checking session...</span>
      </div>
    </div>
  );
}

function LoginPage() {
  const { loading, allow } = useSessionGuard({ redirectIfAuthenticated: true });
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");

  if (loading) {
    return <FullPageLoader />;
  }

  if (!allow) {
    return <Navigate to="/dashboard" replace />;
  }

  const onSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await API.login(password);
      window.location.assign("/dashboard");
    } catch (submissionError) {
      setError(submissionError.message || "Failed to login");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pod-login-shell">
      <div className="pod-login-glow" />

      <main className="pod-login-wrap">
        <div className="pod-login-brand">
          <div className="pod-logo-wrap">
            <img src="/paseo-logo.svg" alt="Paseo" className="pod-logo" />
          </div>
          <h1 className="pod-login-title">Paseo Monitoring</h1>
          <p className="pod-login-subtitle">Enter your password to continue</p>
        </div>

        <section className="pod-login-card">
          <form className="auth-form" onSubmit={onSubmit}>
            <label htmlFor="password" className="input-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
            />

            {error ? <p className="form-error">{error}</p> : null}

            <button type="submit" className="btn btn-primary pod-login-submit" disabled={submitting}>
              {submitting ? (
                <>
                  <LoaderCircle size={15} className="btn-spinner" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

function StatusPill({ status, loadingStatus = false }) {
  if (loadingStatus) {
    return (
      <span className="status-pill is-loading">
        <LoaderCircle size={14} className="status-pill-spinner" />
        <strong>Loading</strong>
      </span>
    );
  }

  const isOnline =
    status?.localDaemon === "running" && status?.connectedDaemon === "reachable";

  return (
    <span className={`status-pill ${isOnline ? "is-online" : "is-offline"}`}>
      <Activity size={14} />
      <strong>{isOnline ? "Online" : "Offline"}</strong>
    </span>
  );
}

function MetricCard({ icon: Icon, title, value, subtitle }) {
  return (
    <article className="metric-card">
      <div className="metric-head">
        <Icon size={17} />
        <span>{title}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <p className="metric-subtitle">{subtitle}</p>
    </article>
  );
}

function DashboardPage() {
  const { loading, allow } = useSessionGuard();
  const [statusPayload, setStatusPayload] = React.useState(null);
  const [statusError, setStatusError] = React.useState("");
  const [busyAction, setBusyAction] = React.useState("");
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [hasFetchedStatusOnce, setHasFetchedStatusOnce] = React.useState(false);
  const lastStatusToastRef = React.useRef({
    message: "",
    at: 0,
  });

  const applyDaemonStatus = React.useCallback((daemonPayload, isoTimestamp) => {
    if (!daemonPayload || !daemonPayload.ok) {
      return false;
    }

    setStatusPayload(daemonPayload);
    setStatusError("");
    setHasFetchedStatusOnce(true);

    const timestamp = isoTimestamp ? new Date(isoTimestamp) : new Date();
    setLastUpdated(Number.isNaN(timestamp.getTime()) ? new Date() : timestamp);
    return true;
  }, []);

  React.useEffect(() => {
    if (!statusError) {
      return;
    }

    const now = Date.now();
    const isSameMessage = statusError === lastStatusToastRef.current.message;
    const isCooldownActive = now - lastStatusToastRef.current.at < 15000;
    if (isSameMessage && isCooldownActive) {
      return;
    }

    toast.error(statusError, {
      id: "daemon-status-error",
      duration: 5500,
    });

    lastStatusToastRef.current = {
      message: statusError,
      at: now,
    };
  }, [statusError]);

  React.useEffect(() => {
    if (!allow) {
      return undefined;
    }

    const stream = new EventSource("/api/daemon/stream");

    const onStatus = (event) => {
      let streamPayload = null;

      try {
        streamPayload = JSON.parse(event.data || "{}");
      } catch {
        setHasFetchedStatusOnce(true);
        setStatusError("Status request failed");
        return;
      }

      setHasFetchedStatusOnce(true);

      if (applyDaemonStatus(streamPayload.daemon, streamPayload.at)) {
        return;
      }

      setStatusError(daemonStatusErrorMessage(streamPayload.daemon));
    };

    stream.addEventListener("status", onStatus);
    stream.onerror = () => {
      setHasFetchedStatusOnce(true);
      setStatusError((previousError) => previousError || "Status request failed");
    };

    return () => {
      stream.removeEventListener("status", onStatus);
      stream.close();
    };
  }, [allow, applyDaemonStatus]);

  if (loading) {
    return <FullPageLoader />;
  }

  if (!allow) {
    return <Navigate to="/login" replace />;
  }

  const daemon = statusPayload?.status;
  const metrics = statusPayload?.metrics;
  const isStatusLoading = !hasFetchedStatusOnce && !statusPayload;
  const localDaemonState = daemon?.localDaemon || "";
  const connectedDaemonState = daemon?.connectedDaemon || "";
  const isLocalDaemonRunning = localDaemonState === "running";
  const isConnectedDaemonReachable = connectedDaemonState === "reachable";

  const onRestart = async () => {
    setBusyAction("restart");
    setStatusError("");

    try {
      const payload = await API.restartDaemon();
      if (!applyDaemonStatus(payload.daemon)) {
        setStatusError(daemonStatusErrorMessage(payload.daemon));
      }
    } catch (error) {
      setStatusError(error.message || "Restart failed");
    } finally {
      setBusyAction("");
    }
  };

  const onStop = async () => {
    setBusyAction("stop");
    setStatusError("");

    try {
      const payload = await API.stopDaemon();
      if (!applyDaemonStatus(payload.daemon)) {
        setStatusError(daemonStatusErrorMessage(payload.daemon));
      }
    } catch (error) {
      setStatusError(error.message || "Stop failed");
    } finally {
      setBusyAction("");
    }
  };

  const onLogout = async () => {
    await API.logout();
    window.location.assign("/login");
  };

  return (
    <div className="page dashboard-page">
      <div className="ambient-layer" />

      <div className="dashboard-container">
        <header className="topbar">
          <div className="topbar-left">
            <div className="logo-badge">
              <img src="/paseo-app-logo.svg?v=1" alt="Paseo" className="logo-badge-icon" />
              <span>PASEO MONITORING</span>
            </div>
            <h1>Daemon Dashboard</h1>
          </div>

          <div className="topbar-right">
            <StatusPill status={daemon} loadingStatus={isStatusLoading} />
          </div>
        </header>

        <main className="dashboard-main">
          <section className="grid-metrics">
            <MetricCard
              icon={Server}
              title="Daemon PID"
              value={daemon?.pid || "-"}
              subtitle={`Started: ${formatDate(daemon?.startedAt)}`}
            />

            <MetricCard
              icon={Gauge}
              title="Daemon Version"
              value={daemon?.daemonVersion || "-"}
              subtitle={`CLI: ${daemon?.cliVersion || "-"}`}
            />

            <MetricCard
              icon={Cpu}
              title="CPU Usage"
              value={formatNumber(metrics?.cpuPercent, "%")}
              subtitle="Current daemon CPU load"
            />

            <MetricCard
              icon={HardDrive}
              title="RAM Usage"
              value={formatNumber(metrics?.memoryMb, " MB")}
              subtitle={`Memory Usage: ${formatNumber(metrics?.memoryPercent, "%")}`}
            />
          </section>

          <section className="control-panel">
            <div className="panel-head">
              <h2>Daemon Controls</h2>
              <span>
                Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "-"}
              </span>
            </div>

            <div className="status-list">
              <div>
                <span className="label">Local Daemon</span>
                <strong className={isLocalDaemonRunning ? "status-ok" : "status-bad"}>
                  {toStatusLabel(localDaemonState)}
                </strong>
              </div>
              <div>
                <span className="label">Connected Daemon</span>
                <strong className={isConnectedDaemonReachable ? "status-ok" : "status-bad"}>
                  {toStatusLabel(connectedDaemonState)}
                </strong>
              </div>
              <div>
                <span className="label">Host</span>
                <strong>{daemon?.hostname || "-"}</strong>
              </div>
              <div>
                <span className="label">Listen</span>
                <strong>{daemon?.listen || "-"}</strong>
              </div>
            </div>

            <div className="action-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onLogout}
                disabled={busyAction.length > 0}
              >
                <LogOut size={16} />
                Logout
              </button>

              <button
                type="button"
                className="btn btn-primary"
                onClick={onRestart}
                disabled={busyAction.length > 0}
              >
                <RefreshCcw size={16} />
                {busyAction === "restart" ? "Restarting..." : "Restart Daemon"}
              </button>

              <button
                type="button"
                className="btn btn-danger"
                onClick={onStop}
                disabled={busyAction.length > 0}
              >
                <SquarePower size={16} />
                {busyAction === "stop" ? "Stopping..." : "Stop Daemon"}
              </button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>

      <Toaster position="bottom-right" richColors theme="dark" />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignore registration errors to keep UI functional.
    });
  });
}
