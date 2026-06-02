# Paseo Monitoring — Findings & Priority Matrix

**Date:** 2026-05-30
**Source:** 5 subagents (SE, QA, DevSecOps, Data Engineer, SRE)
**Status:** ❌ Belum maksimal — 4 P0, 8 P1, 7 P2 ditemukan

---

## Ringkasan

| Priority | Count | Status |
|----------|-------|--------|
| **P0** — Critical | 4 | Perlu segera |
| **P1** — High | 8 | Perlu minggu ini |
| **P2** — Medium | 7 | Perlu bulan ini |
| ✅ **Already Fixed** | 6 | Selesai oleh DevSecOps |

---

## P0 — Critical (system crash / data loss / security breach)

### P0-1: Tidak ada unhandledRejection / uncaughtException handler
- **File:** `server/index.js`
- **Ditemukan oleh:** SRE
- **Dampak:** Async middleware yang throw rejected promise → process crash silent tanpa restart message. Express 5 tidak handle rejected promise secara otomatis.
- **Perbaikan:** Tambah `process.on("unhandledRejection", ...)` dan `process.on("uncaughtException", ...)` di entry point. Log error + graceful shutdown.
- **Effort:** 5 menit

### P0-2: Graceful shutdown tidak drain in-flight requests
- **File:** `server/index.js` (~line 290-310)
- **Ditemukan oleh:** SRE
- **Dampak:** Request daemon (45s timeout) terputus paksa oleh force exit 10s. Variabel `daemonActionInProgress` tetap `true` → semua aksi daemon selanjutnya ditolak sampai process restart. Juga `server.close()` tanpa `closeIdleConnections()` — keep-alive connections tetap open.
- **Perbaikan:** Sebelum force exit, tunggu in-flight daemon action selesai (max 5s). Reset `daemonActionInProgress` di cleanup. Tambah `server.closeIdleConnections()`.
- **Effort:** 10 menit

### P0-3: Tidak ada circuit breaker untuk daemon CLI calls
- **File:** `server/paseo.js` / `server/index.js`
- **Ditemukan oleh:** SRE
- **Dampak:** Jika `paseo daemon status` gagal 10x berturut-turut (daemon down), server tetap panggil tiap request/SSE tick → cascade failure ke semua endpoint dependen. Setiap call bisa 45s timeout.
- **Perbaikan:** Implement circuit breaker pattern: setelah N failure, open circuit (return cached/error) untuk X detik, lalu half-open, lalu closed lagi.
- **Effort:** 20 menit

### P0-4: PM2 OOM restart sudah terjadi (RAM > 256M threshold)
- **File:** `ecosystem.config.js` (max_memory_restart: 256M)
- **Ditemukan oleh:** SRE (dari log: `ram=340.66MB`)
- **Dampak:** Server sudah restart setidaknya sekali karena melebihi threshold 256M. Variance RAM 178-340MB — perlu investigasi memory leak.
- **Perbaikan:** Naikkan threshold ke 512M sementara. Investigasi memory leak (heap snapshot, GC pressure). PM2 cluster mode untuk distribusi beban.
- **Effort:** 30 menit investigasi + 5 menit fix

---

## P1 — High (signifikan, perlu minggu ini)

### P1-1: Collector process tidak pernah di-spawn
- **File:** `server/collector.js` + `server/index.js`
- **Ditemukan oleh:** Data Engineer
- **Dampak:** `server/index.js` tidak pernah `fork('collector.js')`. Tidak ada `child_process.fork` atau `spawn` di codebase. Kolektor mati — 50% kode server tidak berguna. Data di `data/collector-*.log` hanya 5 baris dari test manual.
- **Perbaikan:** Server fork collector sebagai child process. Collector kirim data via IPC (`process.send()`), bukan file. SSE loop duduk di IPC event. State file jadi fallback saja.
- **Effort:** 30 menit

### P1-2: Zero historical metrics — hanya snapshot real-time
- **File:** `server/state-store.js` + `server/index.js`
- **Ditemukan oleh:** Data Engineer
- **Dampak:** Frontend cuma tampilkan "sekarang". Tidak ada grafik trending CPU/RAM, tidak ada perbandingan. Data CPU sample (250ms) dibuang tiap siklus.
- **Perbaikan:** Tambah SQLite/ring buffer untuk historical metrics: `(timestamp, cpu, ram_mb, daemon_status)`. Agregasi per-minute (avg, min, max). Frontend query via `/api/metrics/history?range=1h|6h|24h|7d`. Retensi 7 hari.
- **Effort:** 1-2 jam

### P1-3: Single-thread (fork=1) di 4vCPU — 3 core idle
- **File:** `ecosystem.config.js` / `server/index.js`
- **Ditemukan oleh:** SRE
- **Dampak:** Utilisasi CPU 25%. Request seri di single thread. Express 5 async tapi tetap single-thread untuk CPU-bound ops.
- **Perbaikan:** PM2 cluster mode `instances: max` atau `instances: 4`. Sesuaikan rate limiter untuk multi-instance (shared state via file/redis).
- **Effort:** 10 menit

### P1-4: Vite build zero optimization
- **File:** `vite.config.mjs`
- **Ditemukan oleh:** SE
- **Dampak:** Tidak ada `build.rollupOptions.output.manualChunks`, tidak ada lazy loading. DashboardPage di-import eager di App.jsx → semua komponen + Lucide icons masuk di initial bundle.
- **Perbaikan:** `React.lazy(() => import("./pages/DashboardPage"))` + Suspense. Tambah `manualChunks` untuk vendor splitting (react, lucide).
- **Effort:** 15 menit

### P1-5: Tidak ada Prometheus metrics endpoint
- **File:** `server/index.js`
- **Ditemukan oleh:** SRE
- **Dampak:** Tidak bisa alert berdasarkan error rate, p95 latency, connection count. Ops blind terhadap performa real-time.
- **Perbaikan:** Tambah `GET /api/metrics` endpoint format Prometheus. Track: request count, duration, status code, active SSE connections, daemon status, error rate.
- **Effort:** 30 menit

### P1-6: Log format tidak machine-readable
- **File:** `server/collector.js` (log format)
- **Ditemukan oleh:** Data Engineer
- **Dampak:** Format `key=value` dengan spasi separator — rawan parsing error kalau value mengandung spasi. Tidak bisa di-query, di-aggregate, atau di-load ke tools analitik.
- **Perbaikan:** Ubah format log collector ke NDJSON — tiap baris JSON valid: `{"ts":"...","localDaemon":"running","cpu":2.5,"ramMb":128}`. Bisa di-stream, di-parse dengan `jq`, dan di-load ke tools monitoring.
- **Effort:** 15 menit

### P1-7: State file di /tmp/ — world-readable + hilang setelah reboot
- **File:** `server/state-store.js` + `ecosystem.config.js`
- **Ditemukan oleh:** Data Engineer, SRE
- **Dampak:** `/tmp/paseo-monitoring-state.json` bisa dibaca proses lain (info daemon status + path). Hilang setelah reboot — startup seed dari cache selalu null.
- **Perbaikan:** Pindah ke persistent path (sudah ada `STATE_FILE_PATH` env var dari DevSecOps — tinggal set di ecosystem.config). Set permission 600.
- **Effort:** 5 menit

### P1-8: Tidak ada rate limiter per-endpoint untuk health/session/logout
- **File:** `server/index.js`
- **Ditemukan oleh:** SE
- **Dampak:** `/api/health`, `/api/auth/session`, `/api/auth/logout` tanpa rate limiter spesifik (hanya ada global). Bisa di-brute force untuk session enumeration.
- **Perbaikan:** Tambah rate limiter spesifik per endpoint. Update security audit doc.
- **Effort:** 10 menit

---

## P2 — Medium (nice to have, perlu bulan ini)

### P2-1: Cookie parsing duplikasi
- **File:** `server/index.js:202-209` (logout handler) vs `server/auth.js:121-141` (`parseCookies`)
- **Ditemukan oleh:** SE
- **Perbaikan:** Reuse `parseCookies` dari auth.js di logout handler.
- **Effort:** 5 menit

### P2-2: payload.command?.output — potensi info leak
- **File:** `src/api/client.js:23` (via `buildApiErrorMessage`)
- **Ditemukan oleh:** SE
- **Perbaikan:** Filter output sebelum ditampilkan ke user — truncate/sanitize path dan system details. Hanya tampilkan di log, bukan di UI.
- **Effort:** 10 menit

### P2-3: useSessionGuard tanpa retry
- **File:** `src/hooks/useSessionGuard.js`
- **Ditemukan oleh:** SE
- **Perbaikan:** Tambah retry 1-2x (exponential backoff 1s-2s) sebelum fallback ke unauthenticated.
- **Effort:** 15 menit

### P2-4: CSP style-src tanpa 'unsafe-inline' bisa break sonner
- **File:** `server/index.js` (helmet config)
- **Ditemukan oleh:** SE, DevSecOps
- **Dampak:** Sonner (toast library) mungkin perlu inline styles — CSP ketat bisa break UI notification.
- **Perbaikan:** Test sonner di production build. Tambah `'unsafe-inline'` ke `style-src` jika perlu. Alternatif: gunakan nonce.
- **Effort:** 15 menit

### P2-5: RevokedTokens tidak dibersihkan — unbounded growth
- **File:** `server/auth.js`
- **Ditemukan oleh:** SRE
- **Dampak:** Setiap logout menambah entry ke `revokedTokens`. Cleanup tiap 24h, tapi attack bisa flood dengan ribuan token — memory leak.
- **Perbaikan:** Implement bounded size + TTL-based eviction untuk revokedTokens.
- **Effort:** 15 menit

### P2-6: Dashboard tidak auto-redirect saat session expired
- **File:** `src/pages/DashboardPage.jsx`, `src/hooks/useSessionGuard.js`
- **Ditemukan oleh:** QA (dari TESTS.md)
- **Dampak:** User session expired, user tetap di dashboard sampai klik Logout manual.
- **Perbaikan:** Periodic session check (5 menit) atau intercept 401 response untuk auto-redirect ke /login.
- **Effort:** 20 menit

### P2-7: ARIA live regions untuk real-time updates
- **File:** `src/pages/DashboardPage.jsx`
- **Ditemukan oleh:** QA (dari TESTS.md)
- **Dampak:** Dynamic status changes (online/offline, CPU/RAM update via SSE, reconnecting indicator) tidak di-announce ke screen reader.
- **Perbaikan:** Tambah `aria-live="polite"` pada container metrik. `aria-live="assertive"` pada reconnecting indicator.
- **Effort:** 10 menit

---

## ✅ Already Fixed (oleh DevSecOps)

| Item | File | Fix |
|------|------|-----|
| Secrets bocor via SSH command args | `.github/workflows/ci.yml` | Heredoc env (stdin, bukan argv) |
| CSRF protection | `server/index.js` + `src/api/client.js` | Middleware `X-Requested-With` + Content-Type check |
| CSP upgradeInsecureRequests + HSTS | `server/index.js` | `upgradeInsecureRequests: []`, HSTS explicit 1 tahun |
| Input validation | `server/index.js` | Password length cap 1024, JSON body error handler |
| URL-encoded body parser | `server/index.js` | `express.urlencoded({ extended: false, limit: "8kb" })` |
| Secret scanning di CI | `.github/workflows/ci.yml` | Gitleaks job |
| State file path konfigurabel | `server/state-store.js` | `STATE_FILE_PATH` env var |
| Test fixes | Multiple files | client.test.js, server-auth.test.js, setup.js adjusted for new headers |

---

## ⚡ Top 5 Immediate Actions

| Rank | Item | Est. Time | Why Now |
|------|------|-----------|---------|
| 1 | P0-1: unhandledRejection handler | 5m | Cegah silent crash production |
| 2 | P0-2: Fix graceful shutdown drain | 10m | Cegah lock corruption |
| 3 | P0-3: Circuit breaker daemon CLI | 20m | Cegah cascade failure |
| 4 | P0-4: PM2 OOM — naikkan threshold + cluster mode | 15m | Cegah restart loop |
| 5 | P1-1: Fix collector — fork via IPC | 30m | 50% kode mati, fondasi metrics |

---

*Generated by: SE, QA, DevSecOps, Data Engineer, SRE — 2026-05-30*
