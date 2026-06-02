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

function sanitizeCommandOutput(output) {
  if (typeof output !== "string") {
    return output;
  }

  // Strip absolute paths (Unix and Windows)
  let sanitized = output.replace(/\/[\w./-]+\/[\w./-]+/g, "[path]");
  sanitized = sanitized.replace(/[A-Za-z]:\\[\w.\\-]+/g, "[path]");

  // Truncate to 100 chars
  return sanitized.slice(0, 100);
}

function buildApiErrorMessage({ response, payload, rawText, fallbackMessage }) {
  if (payload && typeof payload === "object") {
    return (
      sanitizeCommandOutput(payload.command?.output) ||
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

function daemonStatusErrorMessage(
  daemonPayload,
  fallbackMessage = "Status request failed",
) {
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

function isSessionExpiryError(error) {
  if (!error) return false;
  const msg = (error.message || error).toLowerCase();
  return (
    msg.includes("session expired") ||
    msg.includes("sign in again") ||
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("unauthenticated")
  );
}

async function requestJson(url, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: "include",
    });

    const { payload, rawText } = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(
        buildApiErrorMessage({
          response,
          payload,
          rawText,
          fallbackMessage: "Request failed",
        }),
      );
    }

    return { payload, rawText };
  } finally {
    clearTimeout(timeout);
  }
}

const API = {
  async getSession() {
    const { payload } = await requestJson("/api/auth/session");
    if (!payload) {
      throw new Error("Failed to fetch session");
    }

    return payload;
  },

  async login(password) {
    const { payload } = await requestJson("/api/auth/login", {
      method: "POST",
      body: { password },
    });

    if (!payload?.ok) {
      throw new Error(payload?.message || payload?.error || "Login failed");
    }

    return payload;
  },

  async logout() {
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
    } catch {
      // Server-side cleanup is best-effort; proceed with local cleanup
    }
  },

  async restartDaemon() {
    const { payload } = await requestJson("/api/daemon/restart", {
      method: "POST",
    });

    if (!payload?.ok) {
      throw new Error(
        daemonStatusErrorMessage(payload, "Failed to restart daemon"),
      );
    }

    return payload;
  },

  async stopDaemon() {
    const { payload } = await requestJson("/api/daemon/stop", {
      method: "POST",
    });

    if (!payload?.ok) {
      throw new Error(
        daemonStatusErrorMessage(payload, "Failed to stop daemon"),
      );
    }

    return payload;
  },
};

export {
  API,
  parseApiResponse,
  normalizeErrorText,
  buildApiErrorMessage,
  daemonStatusErrorMessage,
  isSessionExpiryError,
  requestJson,
};
