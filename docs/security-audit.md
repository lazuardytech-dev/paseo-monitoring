# Security Audit — Paseo Monitoring

**Date:** 2026-05-30
**Scope:** server/, src/, package.json, deployment config
**Tools:** Manual code review, npm audit

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 5 |
| Info | 2 |

**npm audit:** 0 vulnerabilities across 264 dependencies (79 prod, 186 dev).

---

## Findings

### M-1: CSP blocks inline style attributes

**Location:** `server/index.js` — `helmet` CSP config
**Severity:** Medium

```
styleSrc: ["'self'", "fonts.googleapis.com"]
```

Without `'unsafe-inline'` in `style-src`, browser CSP will block inline `style` attributes on DOM elements. The `style-src` directive serves as fallback for `style-src-attr` if the latter is not explicitly set. React renders `style={{}}` as `<div style="...">` attributes — these would be blocked.

**Impact:** Visual breakage of any React component using inline styles. The `sonner` toast library may inject `<style>` tags or inline styles for animations/positioning, causing toast notifications to render incorrectly or not at all.

**Mitigation:** Verify no React components use inline `style` attributes. Current codebase uses CSS classes throughout (`src/styles.css`). If sonner injects inline styles, either:
- Add `style-src-attr: ["'unsafe-inline'"]` — only allows inline `style` attributes, not `<style>` elements (safer)
- Or add `'unsafe-inline'` to `style-src` (broader)

Alternatively, test in production build: if Vite extracts all CSS to files and sonner doesn't inject, the CSP may work as-is.

### M-2: No rate limiter on unauthenticated endpoints

**Location:** `server/index.js`
**Severity:** Medium

Three endpoints lack rate limiting:

| Endpoint | Auth | Risk |
|----------|------|------|
| `GET /api/health` | None | Unauthenticated DOS — no limit on liveness probes or abuse |
| `GET /api/auth/session` | None | Session existence enumeration, brute-force timing attacks |
| `POST /api/auth/logout` | None | Low-value DOS |

The health endpoint is the most exposed — it returns process info (uptime, memory, PID) with no authentication or rate limiting.

**Mitigation:** Apply a global rate limiter or add per-endpoint limits:
```js
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', globalLimiter);
```

### M-3: Session token server-side invalidation missing

**Location:** `server/auth.js` and `server/index.js`
**Severity:** Medium

`POST /api/auth/logout` only clears the cookie client-side. The session token itself is not tracked or invalidated server-side. If a token is exfiltrated (XSS, log leakage), it remains valid for its full TTL (24 hours) even after the legitimate user logs out.

**Mitigation:** Since session is stateless (HMAC-signed), add a blocklist/revocation list in Redis or in-memory:
```js
const revokedTokens = new Set();
// On logout: add token signature to revoked set
// On auth check: reject if signature in revoked set
```

Add memory limit + TTL to the set to prevent unbounded growth.

---

### L-1: `secure: false` default for session cookie

**Location:** `server/index.js:86`
**Severity:** Low

```js
secure: process.env.NODE_ENV === "production",
```

If `NODE_ENV` is not set to `"production"` in deployment, the session cookie is transmitted over plain HTTP. The liveness probe (`/api/health`) and assets still work over HTTP.

**Mitigation:** Either enforce via explicit env var or ensure `NODE_ENV=production` in all deployment environments. Add validation:
```js
if (process.env.NODE_ENV === "production" && !req.secure) {
  // Option: redirect to HTTPS or reject
}
```

### L-2: `trust proxy` without validation

**Location:** `server/index.js:33`
**Severity:** Low

```js
app.set("trust proxy", 1);
```

Trusts the first proxy in the `X-Forwarded-For` chain. If deployed without a reverse proxy, this allows a client to spoof its IP. Rate limiters use `req.ip` which is derived from `X-Forwarded-For` when `trust proxy` is set.

**Mitigation:** Use only behind a known reverse proxy (nginx, Caddy, Cloudflare). Document this dependency.

### L-3: Error messages may leak command output

**Location:** `src/api/client.js:23` — `buildApiErrorMessage`
**Severity:** Low

```js
return (
  payload.command?.output ||
  payload.message ||
  payload.error ||
  fallbackMessage
);
```

The client displays `payload.command?.output` which can contain raw shell command output from paseo daemon. While this is behind authentication, it could leak system paths, configuration details, or daemon internals to authenticated users.

**Mitigation:** Server-side: truncate or sanitize command output before returning to client. Client-side: strip path prefixes from output.

### L-4: No CSRF token beyond SameSite cookie

**Location:** `server/index.js`, `server/auth.js`
**Severity:** Low

CSRF protection relies solely on `sameSite: "strict"`. This is sufficient for most modern browsers, but older browsers or automated tools may ignore SameSite. No CSRF token or Origin/Referer header validation.

**Mitigation:** Add Origin header check for POST endpoints:
```js
app.post("/api/*", (req, res, next) => {
  const origin = req.get("Origin") || req.get("Referer") || "";
  if (!origin.startsWith("http://127.0.0.1") && !origin.startsWith("https://yourdomain.com")) {
    return res.status(403).json({ ok: false });
  }
  next();
});
```

### L-5: Health endpoint leaks process internals

**Location:** `server/index.js:238-244` — `GET /api/health`
**Severity:** Low

Returns `memoryUsage` (rss, heapTotal, heapUsed), `pid`, and `uptime` with no authentication. This information aids attackers in understanding the server environment.

**Mitigation:** Move to authenticated endpoint, or strip `memoryUsage` details, or add rate limiting.

---

### I-1: Default password in README

**Location:** `README.md`
**Severity:** Info

```md
- Password default: `Lzrdy2024_`
```

Documenting the default password is convenient for development but risks production deployment with unchanged credentials.

**Mitigation:** Add explicit warning above default credentials: "CHANGE THIS FOR PRODUCTION. Set PASEO_MONITORING_PASSWORD in environment."

### I-2: No TLS termination documented

**Location:** All deployment docs
**Severity:** Info

No documentation on TLS termination. The server binds to `127.0.0.1` by default but if bound to `0.0.0.0` or exposed via reverse proxy, traffic is unencrypted.

**Mitigation:** Document TLS setup (nginx/Caddy/Cloudflare) and add `upgrade-insecure-requests` directive to CSP.

---

## Security Checklist

| Check | Status | Notes |
|-------|--------|-------|
| Helmet.js | ✅ | CSP, X-Frame-Options, X-Content-Type-Options, etc. |
| express-rate-limit | ⚠️ Partial | Login (10/15min) and actions (5/min) only. Missing: health, session check, logout |
| httpOnly cookie | ✅ | `httpOnly: true` |
| sameSite cookie | ✅ | `sameSite: "strict"` |
| secure cookie | ⚠️ Conditional | `NODE_ENV === "production"` — easy to miss |
| CSP | ⚠️ Review | `style-src` without `'unsafe-inline'` may break inline styles |
| Input validation | ⚠️ Partial | Login validates password type. Other POST endpoints accept JSON but don't use body params |
| Timing-safe comparison | ✅ | `crypto.timingSafeEqual` for password and HMAC signature |
| Session token | ✅ | HMAC-SHA256 signed, nonce, expiry |
| npm audit | ✅ | 0 vulnerabilities |
| Error handling | ✅ | No stack traces to client (operational vs internal errors) |
| CSRF | ⚠️ Partial | Only SameSite cookie — no Origin check |
| Request size limit | ✅ | `express.json({ limit: "16kb" })` |
| X-Powered-By | ✅ | `app.disable("x-powered-by")` |

## Recommendations (Priority Order)

1. **HIGH**: Add global rate limiter on `/api` for unauthenticated endpoints
2. **MEDIUM**: Verify CSP compatibility with sonner + production build
3. **MEDIUM**: Add server-side session revocation on logout
4. **LOW**: Add Origin/Referer validation on POST endpoints
5. **LOW**: Sanitize command output in error responses
6. **LOW**: Move `/api/health` behind auth or add rate limiting
7. **INFO**: Add TLS documentation and `upgrade-insecure-requests` CSP directive
8. **INFO**: Warn about default credentials in README
