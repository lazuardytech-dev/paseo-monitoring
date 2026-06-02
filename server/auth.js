const crypto = require("node:crypto");

const SESSION_COOKIE_NAME = "paseo_monitoring_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Server-side session revocation set.
// Stores { signature, expiresAt } for revoked tokens.
// Bounded to MAX_REVOKED_TOKENS entries, auto-evicts expired after 24h,
// periodic cleanup every 1 hour.
const revokedTokens = new Map();
const MAX_REVOKED_TOKENS = 1000;
const REVOKED_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let revokedCleanupTimer = null;

function evictExpiredTokens() {
  const now = Date.now();
  for (const [sig, expiresAt] of revokedTokens) {
    if (now >= expiresAt) {
      revokedTokens.delete(sig);
    }
  }
}

function enforceMaxTokens() {
  if (revokedTokens.size <= MAX_REVOKED_TOKENS) return;
  // Evict oldest entries (Map preserves insertion order)
  const toEvict = revokedTokens.size - MAX_REVOKED_TOKENS;
  let evicted = 0;
  for (const [sig] of revokedTokens) {
    if (evicted >= toEvict) break;
    revokedTokens.delete(sig);
    evicted++;
  }
}

function startRevokedCleanup() {
  if (revokedCleanupTimer) return;
  revokedCleanupTimer = setInterval(() => {
    evictExpiredTokens();
    enforceMaxTokens();
    if (revokedTokens.size === 0 && revokedCleanupTimer) {
      clearInterval(revokedCleanupTimer);
      revokedCleanupTimer = null;
    }
  }, REVOKED_CLEANUP_INTERVAL_MS).unref();
}

function revokeSessionToken(token) {
  if (!token || typeof token !== "string") return;
  const parts = token.split(".");
  if (parts.length !== 2) return;
  const signature = parts[1];

  // Evict expired first before adding new entry
  evictExpiredTokens();

  // Enforce max size — evict oldest if still over limit
  if (revokedTokens.size >= MAX_REVOKED_TOKENS) {
    const firstKey = revokedTokens.keys().next().value;
    if (firstKey) revokedTokens.delete(firstKey);
  }

  revokedTokens.set(signature, Date.now() + SESSION_TTL_MS);
  startRevokedCleanup();
}

function isTokenRevoked(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  return revokedTokens.has(parts[1]);
}

function getSessionSecret() {
  const secret = process.env.PASEO_MONITORING_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("PASEO_MONITORING_SESSION_SECRET is required and must be at least 32 characters");
  }
  return secret;
}

function getAppPassword() {
  if (!process.env.PASEO_MONITORING_PASSWORD) {
    throw new Error("PASEO_MONITORING_PASSWORD is required");
  }
  return process.env.PASEO_MONITORING_PASSWORD;
}

function encodePayload(payload) {
  return Buffer.from(payload).toString("base64url");
}

function decodePayload(payload) {
  return Buffer.from(payload, "base64url").toString("utf8");
}

function signPayload(encodedPayload) {
  return crypto.createHmac("sha256", getSessionSecret()).update(encodedPayload).digest("base64url");
}

function createSessionToken() {
  const now = Date.now();
  const payload = {
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const encodedPayload = encodePayload(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = signPayload(encodedPayload);

  if (providedSignature.length !== expectedSignature.length) {
    return false;
  }

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return false;
  }

  try {
    const payload = JSON.parse(decodePayload(encodedPayload));
    return Boolean(payload.exp && Date.now() < payload.exp);
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex <= 0) {
        return acc;
      }

      const key = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();
      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function isAuthenticatedRequest(req) {
  const cookieHeader = req.headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];

  if (isTokenRevoked(token)) {
    return false;
  }

  return verifySessionToken(token);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  getAppPassword,
  isAuthenticatedRequest,
  parseCookies,
  revokeSessionToken,
  verifySessionToken,
};
