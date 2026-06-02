import { useEffect, useState } from "react";
import { API } from "../api/client";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useSessionGuard({ redirectIfAuthenticated = false } = {}) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;

    async function fetchSessionWithRetry() {
      const delays = [1000, 2000];

      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const payload = await API.getSession();
          if (!active) return;
          setAuthenticated(Boolean(payload.authenticated));
          return;
        } catch (err) {
          if (!active) return;

          // Only retry on network errors, not auth/session errors
          const isNetworkError =
            err.message === "Failed to fetch" ||
            err.message === "Failed to fetch session" ||
            err.name === "TypeError" ||
            err.message === "NetworkError" ||
            err.code === "ERR_NETWORK";

          if (isNetworkError && attempt < delays.length) {
            await sleep(delays[attempt]);
            continue;
          }

          // Non-network error or exhausted retries
          setAuthenticated(false);
          return;
        }
      }
    }

    fetchSessionWithRetry().finally(() => {
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

export { useSessionGuard };
