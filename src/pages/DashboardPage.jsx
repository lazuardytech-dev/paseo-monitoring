import { Activity, Cpu, Gauge, HardDrive, LoaderCircle, LogOut, RefreshCcw, Server, SquarePower } from "lucide-react";
import React from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { API, daemonStatusErrorMessage, isSessionExpiryError } from "../api/client";
import { useSessionGuard } from "../hooks/useSessionGuard";
import { formatDate, formatNumber, toStatusLabel } from "../utils/format";
import { FullPageLoader } from "./LoginPage";

function StatusPill({ status, loadingStatus = false }) {
  if (loadingStatus) {
    return (
      <span className="status-pill is-loading">
        <LoaderCircle size={14} className="status-pill-spinner" />
        <strong>Loading</strong>
      </span>
    );
  }

  const isOnline = status?.localDaemon === "running" && status?.connectedDaemon === "reachable";

  return (
    <span className={`status-pill ${isOnline ? "is-online" : "is-offline"}`}>
      <Activity size={14} />
      <strong>{isOnline ? "Online" : "Offline"}</strong>
    </span>
  );
}

function MetricCard({ icon: Icon, title, value, subtitle }) {
  return (
    <article className="metric-card" aria-live="polite" aria-label={`${title}: ${value}`}>
      <div className="metric-head">
        <Icon size={17} />
        <span>{title}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <p className="metric-subtitle">{subtitle}</p>
    </article>
  );
}

function openEventSource(url) {
  if (typeof EventSource !== "function") {
    throw new Error("EventSource is not available");
  }

  try {
    return new EventSource(url);
  } catch {
    return EventSource(url);
  }
}

function DashboardPage() {
  const { loading, allow } = useSessionGuard();
  const [statusPayload, setStatusPayload] = React.useState(null);
  const [statusError, setStatusError] = React.useState("");
  const [busyAction, setBusyAction] = React.useState("");
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [hasFetchedStatusOnce, setHasFetchedStatusOnce] = React.useState(false);
  const [sseStatus, setSseStatus] = React.useState("connected");
  const sessionExpiryHandledRef = React.useRef(false);
  const lastStatusToastRef = React.useRef({
    message: "",
    at: 0,
  });
  const navigate = useNavigate();

  const applyDaemonStatus = React.useCallback((daemonPayload, isoTimestamp) => {
    if (!daemonPayload || !daemonPayload.ok) {
      return false;
    }

    setStatusPayload(daemonPayload);
    setStatusError("");
    setSseStatus("connected");
    setHasFetchedStatusOnce(true);

    const timestamp = isoTimestamp ? new Date(isoTimestamp) : new Date();
    setLastUpdated(Number.isNaN(timestamp.getTime()) ? new Date() : timestamp);
    return true;
  }, []);

  React.useEffect(() => {
    if (!statusError) {
      return;
    }

    // Detect session expiry and redirect
    const sessionExpired = typeof isSessionExpiryError === "function" && isSessionExpiryError(statusError);

    if (sessionExpired && !sessionExpiryHandledRef.current) {
      sessionExpiryHandledRef.current = true;
      toast.error("Session expired. Redirecting to login...", {
        id: "session-expired",
        duration: 4000,
      });
      setTimeout(() => navigate("/login"), 1500);
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
  }, [statusError, navigate]);

  React.useEffect(() => {
    if (!allow) {
      return undefined;
    }

    let stream = null;

    try {
      stream = openEventSource("/api/daemon/stream");
    } catch {
      setHasFetchedStatusOnce(true);
      setSseStatus("reconnecting");
      setStatusError("Status request failed");
      return undefined;
    }

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
      setSseStatus("reconnecting");
      setStatusError((previousError) => {
        // If we already have an error that looks like session expiry, propagate it
        if (previousError && typeof isSessionExpiryError === "function" && isSessionExpiryError(previousError)) {
          return previousError;
        }
        return previousError || "Status request failed";
      });
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
    navigate("/login");
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
            {sseStatus === "reconnecting" && (
              <span className="status-pill is-loading" aria-live="assertive" role="status">
                <LoaderCircle size={14} className="status-pill-spinner" />
                <strong>Reconnecting...</strong>
              </span>
            )}
            <StatusPill status={daemon} loadingStatus={isStatusLoading} />
          </div>
        </header>

        <main className="dashboard-main" aria-label="Dashboard metrics and controls" aria-live="polite">
          <section className="grid-metrics" aria-label="System metrics" aria-live="polite">
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

          <section className="control-panel" aria-label="Daemon controls and status" aria-live="polite">
            <div className="panel-head">
              <h2>Daemon Controls</h2>
              <span>Last updated: {lastUpdated ? lastUpdated.toLocaleTimeString() : "-"}</span>
            </div>

            {statusError && (
              <div className="control-error-banner" role="alert">
                {statusError}
              </div>
            )}

            <ul className="status-list" aria-label="Daemon status details">
              <li>
                <span className="label">Local Daemon</span>
                <strong className={isLocalDaemonRunning ? "status-ok" : "status-bad"}>
                  {toStatusLabel(localDaemonState)}
                </strong>
              </li>
              <li>
                <span className="label">Connected Daemon</span>
                <strong className={isConnectedDaemonReachable ? "status-ok" : "status-bad"}>
                  {toStatusLabel(connectedDaemonState)}
                </strong>
              </li>
              <li>
                <span className="label">Host</span>
                <strong>{daemon?.hostname || "-"}</strong>
              </li>
              <li>
                <span className="label">Listen</span>
                <strong>{daemon?.listen || "-"}</strong>
              </li>
            </ul>

            <div className="action-row">
              <button type="button" className="btn btn-primary" onClick={onLogout}>
                <LogOut size={16} />
                Logout
              </button>

              <button type="button" className="btn btn-primary" onClick={onRestart} disabled={busyAction.length > 0}>
                <RefreshCcw size={16} />
                {busyAction === "restart" ? "Restarting..." : "Restart Daemon"}
              </button>

              <button type="button" className="btn btn-danger" onClick={onStop} disabled={busyAction.length > 0}>
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

export default DashboardPage;
export { DashboardPage, MetricCard, StatusPill };
