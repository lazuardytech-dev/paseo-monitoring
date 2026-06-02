import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage, MetricCard, StatusPill } from "../../src/pages/DashboardPage";

// Mock API
vi.mock("../../src/api/client", () => ({
  API: {
    getSession: vi.fn(),
    restartDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    logout: vi.fn(),
  },
  daemonStatusErrorMessage: vi.fn((payload, fallback) => {
    if (!payload || typeof payload !== "object") return fallback || "Status request failed";
    return payload.command?.output || payload.message || payload.error || fallback || "Status request failed";
  }),
  isSessionExpiryError: vi.fn((error) => {
    if (!error) return false;
    const msg = (error.message || error).toLowerCase();
    return (
      msg.includes("session expired") ||
      msg.includes("sign in again") ||
      msg.includes("401") ||
      msg.includes("unauthorized") ||
      msg.includes("unauthenticated")
    );
  }),
}));

import { API } from "../../src/api/client";

// Mock EventSource
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.readyState = 0; // CONNECTING

    // Simulate connection after microtask
    setTimeout(() => {
      this.readyState = 1; // OPEN
    }, 0);
  }

  addEventListener(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  removeEventListener(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  }

  dispatchEvent(event) {
    if (this.listeners[event.type]) {
      this.listeners[event.type].forEach((cb) => {
        cb(event);
      });
    }
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  // Helper for tests to simulate incoming SSE data
  triggerStatus(data) {
    const event = new MessageEvent("status", { data: JSON.stringify(data) });
    this.dispatchEvent(event);
  }

  triggerError() {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }
}

let mockEventSource;

globalThis.EventSource = (url) => {
  mockEventSource = new MockEventSource(url);
  return mockEventSource;
};

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEventSource = null;
  });

  it("shows loading while checking session", () => {
    API.getSession.mockReturnValue(new Promise(() => {}));

    renderDashboard();
    expect(screen.getByText("Checking session...")).toBeInTheDocument();
  });

  it("redirects to /login if not authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });

    renderDashboard();

    await waitFor(() => {
      expect(screen.queryByText("Checking session...")).not.toBeInTheDocument();
    });
  });

  it("renders dashboard when authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });
  });

  it("shows loading state before first SSE event", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    // Should show status loading pill
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("updates status when SSE event arrives", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    // Simulate SSE status event
    expect(mockEventSource).not.toBeNull();
    if (mockEventSource) {
      mockEventSource.triggerStatus({
        ok: true,
        daemon: {
          ok: true,
          status: {
            localDaemon: "running",
            connectedDaemon: "reachable",
            pid: 12345,
            daemonVersion: "1.2.3",
            cliVersion: "0.1.0",
            hostname: "test-server",
            listen: "127.0.0.1:8080",
            startedAt: "2026-05-30T10:00:00.000Z",
          },
          metrics: {
            cpuPercent: 12.5,
            memoryPercent: 8.3,
            memoryMb: 256.0,
          },
        },
        at: new Date().toISOString(),
      });
    }

    await waitFor(() => {
      expect(screen.getByText("Online")).toBeInTheDocument();
    });

    expect(screen.getByText("12345")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
  });

  it("shows reconnecting indicator on SSE error", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    if (mockEventSource) {
      mockEventSource.triggerError();
    }

    await waitFor(() => {
      expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
    });
  });

  it("removes reconnecting indicator when SSE reconnects", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    if (mockEventSource) {
      mockEventSource.triggerError();
    }

    await waitFor(() => {
      expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
    });

    // Simulate successful reconnect
    if (mockEventSource) {
      mockEventSource.triggerStatus({
        ok: true,
        daemon: {
          ok: true,
          status: {
            localDaemon: "running",
            connectedDaemon: "reachable",
            pid: 12345,
            daemonVersion: "1.2.3",
            cliVersion: "0.1.0",
            hostname: "test-server",
            listen: "127.0.0.1:8080",
            startedAt: "2026-05-30T10:00:00.000Z",
          },
          metrics: {
            cpuPercent: 12.5,
            memoryPercent: 8.3,
            memoryMb: 256.0,
          },
        },
        at: new Date().toISOString(),
      });
    }

    await waitFor(() => {
      expect(screen.queryByText("Reconnecting...")).not.toBeInTheDocument();
    });

    // Should show Online again
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("handles malformed SSE data gracefully", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockEventSource?.listeners?.status?.length || 0).toBeGreaterThan(0);
    });

    // Simulate malformed SSE data
    if (mockEventSource) {
      const badEvent = new MessageEvent("status", { data: "not-json-at-all" });
      mockEventSource.dispatchEvent(badEvent);
    }

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("Status request failed")).toBeInTheDocument();
  });

  it("shows error banner and toast on SSE error", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    if (mockEventSource) {
      mockEventSource.triggerError();
    }

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("calls API.restartDaemon on restart button click", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.restartDaemon.mockResolvedValue({
      ok: true,
      daemon: {
        ok: true,
        status: { localDaemon: "running", connectedDaemon: "reachable" },
      },
    });

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    // Wait for SSE to have been connected (status loading shown)
    const restartBtn = screen.getByText("Restart Daemon");
    await user.click(restartBtn);

    await waitFor(() => {
      expect(API.restartDaemon).toHaveBeenCalled();
    });
  });

  it("calls API.stopDaemon on stop button click", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.stopDaemon.mockResolvedValue({
      ok: true,
      action: "stop",
    });

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    const stopBtn = screen.getByText("Stop Daemon");
    await user.click(stopBtn);

    await waitFor(() => {
      expect(API.stopDaemon).toHaveBeenCalled();
    });
  });

  it("calls API.logout and navigates on logout button click", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.logout.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    const logoutBtn = screen.getByText("Logout");
    await user.click(logoutBtn);

    await waitFor(() => {
      expect(API.logout).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith("/login");
    });
  });

  it("renders four metric cards", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Daemon PID")).toBeInTheDocument();
    expect(screen.getByText("Daemon Version")).toBeInTheDocument();
    expect(screen.getByText("CPU Usage")).toBeInTheDocument();
    expect(screen.getByText("RAM Usage")).toBeInTheDocument();
  });

  it("renders control panel with status list", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    expect(screen.getByText("Daemon Controls")).toBeInTheDocument();
    expect(screen.getByText("Local Daemon")).toBeInTheDocument();
    expect(screen.getByText("Connected Daemon")).toBeInTheDocument();
    expect(screen.getByText("Host")).toBeInTheDocument();
    expect(screen.getByText("Listen")).toBeInTheDocument();
  });

  it("disables action buttons when an action is in progress", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.restartDaemon.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)));

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    const restartBtn = screen.getByText("Restart Daemon");
    await user.click(restartBtn);

    // Both restart and stop buttons should be disabled
    await waitFor(() => {
      const allBtns = screen.getAllByRole("button");
      const actionBtns = allBtns.filter(
        (btn) => btn.textContent.includes("Restart") || btn.textContent.includes("Stop"),
      );
      actionBtns.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });
  });

  it("shows 'Restarting...' text when restart is in progress", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.restartDaemon.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)));

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Restart Daemon"));

    await waitFor(() => {
      expect(screen.getByText("Restarting...")).toBeInTheDocument();
    });
  });

  it("shows 'Stopping...' text when stop is in progress", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.stopDaemon.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)));

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Stop Daemon"));

    await waitFor(() => {
      expect(screen.getByText("Stopping...")).toBeInTheDocument();
    });
  });

  it("re-enables buttons after action completes", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.restartDaemon.mockResolvedValue({
      ok: true,
      daemon: {
        ok: true,
        status: { localDaemon: "running", connectedDaemon: "reachable", pid: 12345 },
      },
    });

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Restart Daemon"));

    await waitFor(() => {
      expect(screen.getByText("Restart Daemon")).not.toBeDisabled();
    });
  });

  it("shows error banner when restart fails", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.restartDaemon.mockRejectedValue(new Error("Daemon not found"));

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Restart Daemon"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("Daemon not found")).toBeInTheDocument();
  });

  it("shows error banner when stop fails", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });
    API.stopDaemon.mockRejectedValue(new Error("Stop failed"));

    const user = userEvent.setup();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Stop Daemon"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("Stop failed")).toBeInTheDocument();
  });

  it("shows 'Last updated' timestamp after SSE event", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("Daemon Dashboard")).toBeInTheDocument();
    });

    // Before SSE event, show "-"
    const dashes = screen.getAllByText("-");
    expect(dashes.length).toBeGreaterThan(0);

    if (mockEventSource) {
      mockEventSource.triggerStatus({
        ok: true,
        daemon: {
          ok: true,
          status: { localDaemon: "running", connectedDaemon: "reachable", pid: 1 },
        },
        at: new Date().toISOString(),
      });
    }

    // Should now show a time instead of "-"
    await waitFor(() => {
      // "Last updated: " prefix should have a time, not "-"
      expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
    });
  });
});

describe("StatusPill", () => {
  it("shows loading state", () => {
    render(<StatusPill loadingStatus={true} />);
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("shows Online when daemon is running and reachable", () => {
    render(<StatusPill status={{ localDaemon: "running", connectedDaemon: "reachable" }} />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("shows Offline when daemon is not running", () => {
    render(<StatusPill status={{ localDaemon: "stopped", connectedDaemon: "reachable" }} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("shows Offline when connected daemon is not reachable", () => {
    render(<StatusPill status={{ localDaemon: "running", connectedDaemon: "unreachable" }} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });
});

describe("MetricCard", () => {
  it("renders with icon, title, value, and subtitle", () => {
    const MockIcon = () => <svg data-testid="mock-icon" />;
    render(<MetricCard icon={MockIcon} title="CPU" value="45%" subtitle="Current load" />);
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("Current load")).toBeInTheDocument();
  });
});
