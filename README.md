# Silver's HW Monitor

A lightweight hardware dashboard for **umbrelOS / [5tratumOS](https://github.com/WillItMod/5tratum)**
(a home-server OS built the same way as Umbrel): live CPU temp & usage, RAM usage, per-drive
storage usage & temperature, and fan control — packaged as a self-contained Docker app.

Fan control adapts to what the host chip actually supports:
- **Full duty-cycle control** (most SuperIO chips, e.g. `it87`/`nct6775`): Silent/Balanced/Performance
  presets or a manual 0-100% slider.
- **Enable-only chips** (e.g. `hp-wmi` on HP hardware, which exposes `pwmN_enable` but no `pwmN`
  duty file or RPM tachometer): a simple Auto (BIOS) / Full Speed toggle instead of a percentage.

## How it works

- **Backend**: Node.js + Express (`server.js`, `lib/`). Reads sensors straight from the host's
  Linux kernel interfaces, no native bindings required:
  - CPU/RAM usage: `/proc/stat`, `/proc/meminfo`
  - Temperatures: `/sys/class/hwmon/*` (falls back to `/sys/class/thermal/*`)
  - Disk usage: `df`
  - Drive temperature (best-effort): `smartctl` from `smartmontools`
  - Fan RPM + PWM control: `/sys/class/hwmon/hwmon*/fan*_input`, `pwm*`, `pwm*_enable`
- **Frontend**: static HTML/CSS/vanilla JS (`public/`), polls `GET /api/status` every 2s. Ships
  with a light and dark theme (follows system preference, with a manual toggle saved to
  `localStorage`).

## Fan control requirements

Fan control depends entirely on your motherboard's sensor chip being supported by the host
kernel (via `lm-sensors`/`it87`, `nct6775`, `nct6683`, etc. — same drivers Linux's own
`fancontrol` uses). If no `pwm*` files exist under `/sys/class/hwmon/hwmon*/`, fans will show up
as read-only (RPM only) or not at all.

The container needs read-write access to hwmon to change fan speed — see
`silvers-hw-monitor/docker-compose.yml`, which mounts `/sys/class/hwmon:/sys/class/hwmon:rw` and
adds `cap_add: [SYS_RAWIO]`. Reading temperatures works out of the box since Docker exposes host
sysfs read-only by default.

## Local development

```bash
npm install
npm start
# open http://localhost:3300
```

Outside a real Linux host with hwmon support, the dashboard will simply show "no sensors found"
for temps/fans while CPU/RAM/disk usage still work.

## Building & running the container

```bash
docker build -t silvers-hw-monitor .
docker run --rm -p 3300:3300 \
  -v /sys/class/hwmon:/sys/class/hwmon:rw \
  --cap-add SYS_RAWIO \
  silvers-hw-monitor
```

## Repo layout (community app store format)

This repository *is* a community app store, not just one app's files:

```
umbrel-app-store.yml       <- store id/name (required at repo root)
silvers-hw-monitor/        <- one folder per app, named after the app id
  umbrel-app.yml
  docker-compose.yml
  icon.svg
server.js, lib/, public/, Dockerfile, package.json   <- app source (built into the Docker image)
```

umbrelOS/5tratumOS only looks for `umbrel-app.yml` + `docker-compose.yml` inside a subfolder that
matches an app's `id` — if those files sit at the repo root instead, the store shows up empty.

## Publishing as an umbrelOS / 5tratumOS community app

1. Build and push the image referenced in `silvers-hw-monitor/docker-compose.yml`
   (`ghcr.io/SIlver765/silvers-hw-monitor:<version>`).
2. In umbrelOS/5tratumOS: Settings → App Store → Community App Stores → add
   `https://github.com/SIlver765/silvers-hw-monitor`. "Silver's HW Monitor" should then appear
   under the "Silver's Apps" community store.
3. Bump `version` in both `silvers-hw-monitor/umbrel-app.yml` and the image tag in
   `silvers-hw-monitor/docker-compose.yml` together on every release.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | CPU/RAM/disk/temp/fan snapshot |
| `/api/fans/:id/percent` | POST `{ percent: 0-100 }` | Set a fan to manual mode at a duty cycle |
| `/api/fans/:id/auto` | POST | Return a fan to automatic/BIOS control |

`:id` is a hwmon-relative id like `hwmon2/fan1` (URL-encode the `/`).
