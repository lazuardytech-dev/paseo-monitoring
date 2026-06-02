import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionGuard } from "../../src/hooks/useSessionGuard";

// Mock the API module
vi.mock("../../src/api/client", () => ({
  API: {
    getSession: vi.fn(),
  },
}));

import { API } from "../../src/api/client";

// Test component that uses the hook
function TestComponent({ redirectIfAuthenticated = false }) {
  const { loading, allow } = useSessionGuard({ redirectIfAuthenticated });
  if (loading) return <div data-testid="loading">Loading...</div>;
  return (
    <div>
      <span data-testid="allow">{allow ? "allowed" : "denied"}</span>
    </div>
  );
}

describe("useSessionGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    API.getSession.mockReturnValue(new Promise(() => {})); // Never resolves

    render(
      <MemoryRouter>
        <TestComponent />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("loading")).toBeInTheDocument();
  });

  it("sets allow=true when authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    render(
      <MemoryRouter>
        <TestComponent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("allow")).toHaveTextContent("allowed");
    });
  });

  it("sets allow=false when not authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });

    render(
      <MemoryRouter>
        <TestComponent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("allow")).toHaveTextContent("denied");
    });
  });

  it("sets allow=false on API error", async () => {
    API.getSession.mockRejectedValue(new Error("Network error"));

    render(
      <MemoryRouter>
        <TestComponent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("allow")).toHaveTextContent("denied");
    });
  });

  it("inverts allow when redirectIfAuthenticated=true", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    render(
      <MemoryRouter>
        <TestComponent redirectIfAuthenticated={true} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      // When authenticated and redirectIfAuthenticated=true, allow=false
      expect(screen.getByTestId("allow")).toHaveTextContent("denied");
    });
  });

  it("allows when not authenticated and redirectIfAuthenticated=true", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });

    render(
      <MemoryRouter>
        <TestComponent redirectIfAuthenticated={true} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("allow")).toHaveTextContent("allowed");
    });
  });
});
