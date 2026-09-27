# Silver's HW Monitor

A lightweight hardware dashboard for **umbrelOS / StratumOS**: live CPU temp & usage, RAM usage,
per-drive storage usage & temperature, and PWM fan control (Silent / Balanced / Performance
presets, or a manual slider) — packaged as a self-contained Docker app.

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

The container needs read-write access to hwmon to change fan speed — see `docker-compose.yml`,
which mounts `/sys/class/hwmon:/sys/class/hwmon:rw` and adds `cap_add: [SYS_RAWIO]`. Reading
temperatures works out of the box since Docker exposes host sysfs read-only by default.

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

## Publishing as an umbrelOS / StratumOS community app

1. Build and push the image referenced in `docker-compose.yml` (`ghcr.io/SIlver765/silvers-hw-monitor:<version>`).
2. Add this repo as a community app store in umbrelOS (Settings → App Store → Community App
   Stores) using this repository's URL, or submit `umbrel-app.yml` + `docker-compose.yml` to a
   community app store repo.
3. Bump `version` in both `umbrel-app.yml` and the image tag in `docker-compose.yml` together on
   every release.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | CPU/RAM/disk/temp/fan snapshot |
| `/api/fans/:id/percent` | POST `{ percent: 0-100 }` | Set a fan to manual mode at a duty cycle |
| `/api/fans/:id/auto` | POST | Return a fan to automatic/BIOS control |

`:id` is a hwmon-relative id like `hwmon2/fan1` (URL-encode the `/`).
