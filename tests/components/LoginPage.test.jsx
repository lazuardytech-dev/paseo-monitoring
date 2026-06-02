import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../../src/pages/LoginPage";

// Mock API
vi.mock("../../src/api/client", () => ({
  API: {
    getSession: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

import { API } from "../../src/api/client";

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while checking session", () => {
    API.getSession.mockReturnValue(new Promise(() => {})); // Never resolves

    renderLogin();
    expect(screen.getByText("Checking session...")).toBeInTheDocument();
  });

  it("redirects to /dashboard if already authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: true });

    renderLogin();

    await waitFor(() => {
      expect(screen.queryByText("Checking session...")).not.toBeInTheDocument();
    });
    // Should render Navigate to /dashboard
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
  });

  it("renders login form when not authenticated", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });

    renderLogin();

    await waitFor(() => {
      expect(screen.getByText("Paseo Monitoring")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("calls API.login on form submit", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });
    API.login.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    renderLogin();

    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Password"), "testpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(API.login).toHaveBeenCalledWith("testpass");
    });
  });

  it("navigates to /dashboard on successful login", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });
    API.login.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    renderLogin();

    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Password"), "testpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("shows error on failed login", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });
    API.login.mockRejectedValue(new Error("Invalid password"));
    const user = userEvent.setup();

    renderLogin();

    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid password")).toBeInTheDocument();
    });
  });

  it("shows submitting state on submit", async () => {
    API.getSession.mockResolvedValue({ authenticated: false });
    API.login.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1000)));
    const user = userEvent.setup();

    renderLogin();

    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Password"), "testpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Signing in...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
  });
});
