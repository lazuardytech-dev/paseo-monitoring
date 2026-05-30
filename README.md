# Paseo Monitoring

Simple web app untuk monitoring dan kontrol daemon `paseo`.

## Features

- Login page di `/login` (password only, tanpa register)
- Dashboard di `/dashboard`
- Monitor:
  - status daemon (`localDaemon`, `connectedDaemon`)
  - PID daemon
  - CPU usage
  - RAM usage
  - versi daemon/CLI
- Action:
  - Restart Daemon
  - Stop Daemon

## Default credentials

- Password default: `Lzrdy2024_`
- Bisa diubah via env `PASEO_MONITORING_PASSWORD`

## Run locally

```bash
bun install
bun run build
HOST=127.0.0.1 PORT=6004 bun run start
```

## Run with PM2 (production)

```bash
bun install
bun run build
HOST=127.0.0.1 PORT=6004 pm2 start --interpreter /root/.bun/bin/bun server/index.js --name paseo-monitoring
pm2 save
```

## Env vars

- `HOST` (default `127.0.0.1`)
- `PORT` (default `6004`)
- `PASEO_MONITORING_PASSWORD` (default `Lzrdy2024_`)
- `PASEO_MONITORING_SESSION_SECRET` (ganti untuk production)
