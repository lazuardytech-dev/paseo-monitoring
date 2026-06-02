import { Gauge, LoaderCircle } from "lucide-react";
import React from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { API } from "../api/client";
import { useSessionGuard } from "../hooks/useSessionGuard";

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
  const navigate = useNavigate();

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
      navigate("/dashboard");
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

export { FullPageLoader, LoginPage };
