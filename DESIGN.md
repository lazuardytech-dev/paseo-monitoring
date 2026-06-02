# Paseo Monitoring Design Brief

UI/UX ini mengadopsi prinsip dari `lazuardytech/pod` DESIGN system: dark-only, compact density, layered surfaces, dan iconografi line-based.

## Theme Direction

- Mode: dark-only
- Primary background: `#07090A`
- Accent utama: `#F8F8F8`
- Visual tone: command-center, high-contrast, minimal decorative noise

## Core Tokens

- `--bg`: `#07090A`
- `--surface`: `#101315`
- `--surface-2`: `#151A1D`
- `--border`: `#232E35`
- `--text`: `#F8F8F8`
- `--text-muted`: `#9EA8B0`
- `--accent`: `#F8F8F8`
- `--accent-ink`: `#07090A`
- `--danger`: `#DB4242`

## Typography

- UI font: Manrope
- Mono/metrics font: JetBrains Mono
- Compact spacing, tight tracking on headings

## Layout & Density

- Compact grid layout untuk monitoring
- Section gap kecil (10-16px)
- Card radius rendah (7-10px)
- Subtle shadow + inset outline untuk depth

## Iconography

- Library: Lucide React only
- Icon size dominan: 16-18px
- Semua action kritikal memiliki label teks + icon

## Screen Definition

### `/login`

- Single-password authentication flow
- No register / no forgot-password
- One primary CTA: `Login`

### `/dashboard`

- Status cards: PID, CPU, RAM, version
- Runtime health: local/connected daemon + host/listen
- Actions:
  - Restart Daemon
  - Stop Daemon

## Ops

### Required Environment Variables

- `PASEO_MONITORING_PASSWORD` — Password for login authentication
- `PASEO_MONITORING_SESSION_SECRET` — HMAC secret for session tokens (min 32 chars)

### Optional Environment Variables

- `HOST` — Bind address (default: `127.0.0.1`)
- `PORT` — HTTP port (default: `6004`)
- `NODE_ENV` — Set to `production` for secure cookies

### Health Endpoint

`GET /api/health` (unauthenticated)

Returns liveness/readiness probe data:

```json
{
  "ok": true,
  "uptime": 123.45,
  "memoryUsage": { "rss": 12345678, "heapTotal": 8765432, "heapUsed": 5432109 },
  "pid": 1234,
  "timestamp": "2026-05-30T12:00:00.000Z"
}
```

### Graceful Shutdown

Server handles `SIGTERM` and `SIGINT`:
1. Stops SSE stream loop
2. Clears all timers (stream loop, client heartbeats)
3. Closes all SSE client connections
4. Closes HTTP server
5. Force-exits after 10s timeout

### Concurrency Guard (Daemon Actions)

Restart and Stop daemon actions are serialized with a lock. If an action is already in progress, subsequent actions are rejected with `Another daemon action is in progress ({action})`.

### SSE Resilience

- Stream loop errors are caught per-tick and don't kill the loop
- Max 50 concurrent SSE clients; 503 returned when full
- Per-client idle timeout of 5 minutes (no data → close)

### Structured Logging

All request handlers log with a request ID prefix: `[abc12345] METHOD /path statusCode`. Error middleware includes `req.id` in the log line.

## Motion & Feedback

- Real-time status via SSE /eventsource
- Action button loading state (`Restarting...`, `Stopping...`)
- Error message inline pada panel kontrol
