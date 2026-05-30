const crypto = require("node:crypto");

const SESSION_COOKIE_NAME = "paseo_monitoring_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PASSWORD = "Lzrdy2024_";

function getSessionSecret() {
  return (
    process.env.PASEO_MONITORING_SESSION_SECRET ||
    "paseo-monitoring-change-this-secret"
  );
}

function getAppPassword() {
  return process.env.PASEO_MONITORING_PASSWORD || DEFAULT_PASSWORD;
}

function encodePayload(payload) {
  return Buffer.from(payload).toString("base64url");
}

function decodePayload(payload) {
  return Buffer.from(payload, "base64url").toString("utf8");
}

function signPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
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
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function isAuthenticatedRequest(req) {
  const cookieHeader = req.headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  return verifySessionToken(token);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  getAppPassword,
  isAuthenticatedRequest,
};
