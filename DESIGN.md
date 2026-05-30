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

## Motion & Feedback

- Polling status tiap 5 detik
- Action button loading state (`Restarting...`, `Stopping...`)
- Error message inline pada panel kontrol
