# Silver's HW Monitor

A lightweight hardware dashboard for **[5tratumOS](https://github.com/WillItMod/5tratum)**:
live CPU temp & usage, RAM usage, per-drive storage usage & temperature, and fan control —
packaged as a self-contained Docker app.

Different motherboards/laptops expose fan control very differently, so the app probes for
several sysfs interfaces and shows whichever one a given chip actually supports — nothing is
hardcoded to one vendor's hardware:
- **Full duty-cycle control** (most desktop SuperIO chips, e.g. `it87`/`nct6775`): Silent/
  Balanced/Performance presets or a manual 0-100% slider, with RPM readout.
- **Enable-only chips** (e.g. `hp-wmi` on HP hardware, which exposes `pwmN_enable` but no `pwmN`
  duty file or RPM tachometer): a simple Auto (BIOS) / Full Speed toggle instead of a percentage.
- **ACPI cooling-device fans** (`/sys/class/thermal/cooling_device*` of type `Fan` — common on
  laptops where the EC isn't exposed via hwmon at all): a discrete step slider (e.g. "Level 2/5")
  instead of RPM, since the kernel only reports a step index here, not real RPM.

If your hardware exposes none of these (nothing under `/sys/class/hwmon` with `pwm*` files, and
no `Fan`-type cooling device), that's a genuine host/kernel limitation — no userspace app can
show or control fan speed the kernel driver doesn't expose. Use **Fan Control → Run diagnostics**
(Logs tab) to see exactly what this container can see on your host.

## How it works

- **Backend**: Node.js + Express (`server.js`, `lib/`). Reads sensors straight from the host's
  Linux kernel interfaces, no native bindings required:
  - CPU/RAM usage: `/proc/stat`, `/proc/meminfo`
  - Temperatures: `/sys/class/hwmon/*` (falls back to `/sys/class/thermal/*`)
  - Disk usage: `df`
  - Drive temperature (best-effort): `smartctl` from `smartmontools`
  - Fan RPM + PWM control: `/sys/class/hwmon/hwmon*/fan*_input`, `pwm*`, `pwm*_enable`
  - ACPI fan level (fallback): `/sys/class/thermal/cooling_device*/{type,cur_state,max_state}`
- **Frontend**: static HTML/CSS/vanilla JS (`public/`), polls `GET /api/status` every 2s. Ships
  with a light and dark theme (follows system preference, with a manual toggle saved to
  `localStorage`).

## Fan control requirements

Fan control depends entirely on your motherboard/laptop's sensor chip and driver being supported
by the host kernel (via `lm-sensors`/`it87`, `nct6775`, `nct6683`, `hp-wmi`, etc. — the same
drivers Linux's own `fancontrol` uses, plus the generic ACPI thermal cooling-device interface).

The container needs read-write access to both sysfs paths it writes to — see
`silvers-hw-monitor/docker-compose.yml`, which mounts `/sys/class/hwmon:/sys/class/hwmon:rw`,
`/sys/class/thermal:/sys/class/thermal:rw`, and adds `cap_add: [SYS_RAWIO]`. Reading temperatures
works out of the box since Docker exposes host sysfs read-only by default.

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

5tratumOS only looks for `umbrel-app.yml` + `docker-compose.yml` inside a subfolder that
matches an app's `id` — if those files sit at the repo root instead, the store shows up empty.

## Publishing as a 5tratumOS community app

1. Build and push the image referenced in `silvers-hw-monitor/docker-compose.yml`
   (`ghcr.io/silver765/silvers-hw-monitor:<version>` — registry paths are lowercase-only).
2. In 5tratumOS: Settings → App Store → Community App Stores → add
   `https://github.com/Silver765/silvers-hw-monitor`. "Silver's HW Monitor" should then appear
   under the "Silver's Apps" community store.
3. Bump `version` in both `silvers-hw-monitor/umbrel-app.yml` and the image tag in
   `silvers-hw-monitor/docker-compose.yml` together on every release.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | CPU/RAM/disk/temp/fan snapshot |
| `/api/fans/:id/percent` | POST `{ percent: 0-100 }` | Set a fan to manual mode at a duty cycle (hwmon `pwmN` chips) |
| `/api/fans/:id/auto` | POST | Return a fan to automatic/BIOS control (hwmon `pwmN_enable` chips) |
| `/api/fans/:id/full` | POST | Force full speed on an enable-only chip (e.g. `hp-wmi`) |
| `/api/fans/:id/level` | POST `{ level: 0-maxState }` | Set an ACPI cooling-device fan's discrete step |
| `/api/diagnostics/run` | POST | Dump raw hwmon/thermal sysfs contents into the Logs tab |

`:id` is either a hwmon-relative id like `hwmon2/fan1`, or `thermal/cooling_deviceN` for ACPI fans
(URL-encode the `/`).
