'use strict';

const fs = require('fs');
const path = require('path');

// Overridable for local testing off a real Linux host (see scripts/fixtures/).
const HWMON_ROOT = process.env.HWMON_ROOT_OVERRIDE || '/sys/class/hwmon';
const THERMAL_ROOT = process.env.THERMAL_ROOT_OVERRIDE || '/sys/class/thermal';

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function writeFileSafe(filePath, value) {
  try {
    fs.writeFileSync(filePath, String(value));
    return true;
  } catch (err) {
    return false;
  }
}

function listEntries(dir, prefix) {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return [];
  }
}

/**
 * Enumerate every hwmon chip and the temp/fan/pwm channels it exposes.
 * Chips and channel numbering come entirely from sysfs, so this reflects
 * whatever SuperIO/NVMe/coretemp drivers the host kernel has loaded.
 */
function listChips() {
  if (!fs.existsSync(HWMON_ROOT)) return [];

  return fs
    .readdirSync(HWMON_ROOT)
    .map((entry) => {
      const chipDir = path.join(HWMON_ROOT, entry);
      const name = readFileSafe(path.join(chipDir, 'name')) || entry;

      const temps = listEntries(chipDir, 'temp')
        .filter((f) => f.endsWith('_input'))
        .map((f) => {
          const idx = f.match(/temp(\d+)_input/)[1];
          const label =
            readFileSafe(path.join(chipDir, `temp${idx}_label`)) || `${name} temp${idx}`;
          return { id: `${entry}/temp${idx}`, label, inputPath: path.join(chipDir, f) };
        });

      // Index fan channels from BOTH fan*_input (RPM tachometer) and pwm*/pwm*_enable
      // (speed control) — some drivers (e.g. hp-wmi on HP hardware) expose only
      // pwm1_enable with no fan1_input and no pwm1 duty file at all, so relying on
      // fan*_input alone would silently hide an otherwise-controllable fan.
      const fanIndices = new Set();
      listEntries(chipDir, 'fan')
        .filter((f) => f.endsWith('_input'))
        .forEach((f) => fanIndices.add(f.match(/fan(\d+)_input/)[1]));
      listEntries(chipDir, 'pwm').forEach((f) => {
        const m = f.match(/^pwm(\d+)(?:_enable)?$/);
        if (m) fanIndices.add(m[1]);
      });

      const fans = [...fanIndices]
        .sort((a, b) => Number(a) - Number(b))
        .map((idx) => {
          const inputPath = path.join(chipDir, `fan${idx}_input`);
          const pwmPath = path.join(chipDir, `pwm${idx}`);
          const pwmEnablePath = path.join(chipDir, `pwm${idx}_enable`);
          const label = readFileSafe(path.join(chipDir, `fan${idx}_label`)) || `${name} fan${idx}`;
          return {
            id: `${entry}/fan${idx}`,
            label,
            inputPath: fs.existsSync(inputPath) ? inputPath : null,
            pwmPath: fs.existsSync(pwmPath) ? pwmPath : null,
            pwmEnablePath: fs.existsSync(pwmEnablePath) ? pwmEnablePath : null,
          };
        });

      return { chip: entry, name, dir: chipDir, temps, fans };
    })
    .filter((chip) => chip.temps.length || chip.fans.length);
}

function readTempsC() {
  const readings = [];
  for (const chip of listChips()) {
    for (const t of chip.temps) {
      const raw = readFileSafe(t.inputPath);
      if (raw === null) continue;
      readings.push({ id: t.id, chip: chip.name, label: t.label, celsius: Number(raw) / 1000 });
    }
  }

  // Fallback: thermal zones (always present, even without SuperIO drivers).
  if (readings.length === 0 && fs.existsSync(THERMAL_ROOT)) {
    for (const zone of listEntries(THERMAL_ROOT, 'thermal_zone')) {
      const raw = readFileSafe(path.join(THERMAL_ROOT, zone, 'temp'));
      const type = readFileSafe(path.join(THERMAL_ROOT, zone, 'type')) || zone;
      if (raw === null) continue;
      readings.push({ id: zone, chip: 'thermal_zone', label: type, celsius: Number(raw) / 1000 });
    }
  }

  return readings;
}

function readFans() {
  const fans = [];
  for (const chip of listChips()) {
    for (const f of chip.fans) {
      const rpmRaw = f.inputPath ? readFileSafe(f.inputPath) : null;
      const pwmRaw = f.pwmPath ? readFileSafe(f.pwmPath) : null;
      const enableRaw = f.pwmEnablePath ? readFileSafe(f.pwmEnablePath) : null;
      fans.push({
        id: f.id,
        source: 'hwmon',
        chip: chip.name,
        label: f.label,
        rpm: rpmRaw === null ? null : Number(rpmRaw),
        percent: pwmRaw === null ? null : Math.round((Number(pwmRaw) / 255) * 100),
        // Full 0-100% duty control (needs a pwmN file, e.g. most SuperIO chips).
        hasDutyControl: Boolean(f.pwmPath),
        // Some drivers (hp-wmi on HP hardware) only expose pwmN_enable with no
        // pwmN file at all — that still lets us toggle "full speed" (0) vs
        // "automatic/BIOS" (2), just not a smooth percentage.
        hasEnableToggle: Boolean(f.pwmEnablePath),
        hasLevelControl: false,
        controllable: Boolean(f.pwmPath) || Boolean(f.pwmEnablePath),
        mode: enableRaw === null ? null : Number(enableRaw), // 0=full speed, 1=manual, 2+=automatic
      });
    }
  }
  return fans;
}

/**
 * Enumerate ACPI thermal "cooling devices" of type Fan — a second, more
 * universal Linux fan interface (used on many laptops, HP included, when the
 * SuperIO/EC chip isn't exposed through hwmon at all). Unlike hwmon this only
 * gives a discrete step (cur_state of max_state), not an RPM value, but on
 * hardware where hwmon exposes nothing at all it's the only signal available.
 */
function listCoolingFans() {
  if (!fs.existsSync(THERMAL_ROOT)) return [];
  return fs
    .readdirSync(THERMAL_ROOT)
    .filter((f) => f.startsWith('cooling_device'))
    .map((entry) => ({ entry, dir: path.join(THERMAL_ROOT, entry) }))
    .map(({ entry, dir }) => ({ entry, dir, type: readFileSafe(path.join(dir, 'type')) }))
    .filter((d) => d.type && /fan/i.test(d.type));
}

function readCoolingFans() {
  return listCoolingFans().map((d) => {
    const curRaw = readFileSafe(path.join(d.dir, 'cur_state'));
    const maxRaw = readFileSafe(path.join(d.dir, 'max_state'));
    const levelCur = curRaw === null ? null : Number(curRaw);
    const levelMax = maxRaw === null ? null : Number(maxRaw);
    return {
      id: `thermal/${d.entry}`,
      source: 'thermal',
      chip: d.type,
      label: d.type,
      rpm: null,
      percent: null,
      levelCur,
      levelMax,
      hasDutyControl: false,
      hasEnableToggle: false,
      hasLevelControl: levelMax !== null,
      controllable: levelMax !== null,
      mode: null,
    };
  });
}

/** Set an ACPI cooling-device fan to a discrete step from 0 to its max_state. */
function setCoolingLevel(fanId, level) {
  const fan = listCoolingFans().find((d) => `thermal/${d.entry}` === fanId);
  if (!fan) return { ok: false, error: 'fan not found' };

  const maxRaw = readFileSafe(path.join(fan.dir, 'max_state'));
  const max = maxRaw === null ? null : Number(maxRaw);
  if (max === null) return { ok: false, error: 'chip has no max_state' };

  const clamped = Math.max(0, Math.min(max, Math.round(Number(level))));
  const wrote = writeFileSafe(path.join(fan.dir, 'cur_state'), clamped);
  return wrote ? { ok: true, level: clamped } : { ok: false, error: 'write failed' };
}

/** Set a fan to manual mode and a target 0-100% duty cycle. */
function setFanPercent(fanId, percent) {
  const chips = listChips();
  for (const chip of chips) {
    const fan = chip.fans.find((f) => f.id === fanId);
    if (!fan) continue;
    if (!fan.pwmPath) return { ok: false, error: 'fan is not controllable on this chip' };

    const clamped = Math.max(0, Math.min(100, Number(percent)));
    const pwmValue = Math.round((clamped / 100) * 255);

    if (fan.pwmEnablePath) writeFileSafe(fan.pwmEnablePath, 1); // manual mode
    const wrote = writeFileSafe(fan.pwmPath, pwmValue);
    return wrote
      ? { ok: true, percent: clamped }
      : { ok: false, error: 'write failed — check container has rw access to hwmon and CAP_SYS_RAWIO' };
  }
  return { ok: false, error: 'fan not found' };
}

/** Return a fan to automatic/BIOS control (pwm*_enable = 2, per the kernel hwmon ABI). */
function setFanAuto(fanId) {
  const chips = listChips();
  for (const chip of chips) {
    const fan = chip.fans.find((f) => f.id === fanId);
    if (!fan) continue;
    if (!fan.pwmEnablePath) return { ok: false, error: 'chip has no auto mode control' };
    const wrote = writeFileSafe(fan.pwmEnablePath, 2);
    return wrote ? { ok: true } : { ok: false, error: 'write failed' };
  }
  return { ok: false, error: 'fan not found' };
}

/**
 * Force a fan to full speed (pwm*_enable = 0, per the kernel hwmon ABI: "no fan
 * speed control, fan at full speed"). This is the only non-auto option on chips
 * that expose pwm*_enable but no pwm* duty file (e.g. hp-wmi).
 */
function setFanFullSpeed(fanId) {
  const chips = listChips();
  for (const chip of chips) {
    const fan = chip.fans.find((f) => f.id === fanId);
    if (!fan) continue;
    if (!fan.pwmEnablePath) return { ok: false, error: 'chip has no fan speed control' };
    const wrote = writeFileSafe(fan.pwmEnablePath, 0);
    return wrote ? { ok: true } : { ok: false, error: 'write failed' };
  }
  return { ok: false, error: 'fan not found' };
}

/**
 * Raw, unfiltered dump of what this container can actually see under
 * /sys/class/hwmon and /sys/class/thermal — meant to be logged verbatim so a
 * "no controllable fans" report can be root-caused without SSH access to the
 * host (host missing a SuperIO driver vs. container missing mount/perms vs.
 * chip genuinely has no pwm* files).
 */
function diagnostics() {
  const report = { hwmonRoot: HWMON_ROOT, hwmonExists: fs.existsSync(HWMON_ROOT), chips: [] };

  if (report.hwmonExists) {
    let entries;
    try {
      entries = fs.readdirSync(HWMON_ROOT);
    } catch (err) {
      report.hwmonReadError = err.message;
      entries = [];
    }

    report.chips = entries.map((entry) => {
      const chipDir = path.join(HWMON_ROOT, entry);
      let files = [];
      let readError = null;
      try {
        files = fs.readdirSync(chipDir);
      } catch (err) {
        readError = err.message;
      }
      const name = readFileSafe(path.join(chipDir, 'name'));
      const pwmFiles = files.filter((f) => /^pwm\d+$/.test(f));
      return { entry, name, readError, fileCount: files.length, files, pwmFiles };
    });
  }

  report.thermalRoot = THERMAL_ROOT;
  report.thermalExists = fs.existsSync(THERMAL_ROOT);
  report.thermalZones = report.thermalExists ? listEntries(THERMAL_ROOT, 'thermal_zone') : [];

  // Dump every cooling_device, not just fan-typed ones, so we can see naming
  // conventions this host uses even if our /fan/i filter is too strict for it.
  report.coolingDevices = report.thermalExists
    ? listEntries(THERMAL_ROOT, 'cooling_device').map((entry) => {
        const dir = path.join(THERMAL_ROOT, entry);
        return {
          entry,
          type: readFileSafe(path.join(dir, 'type')),
          curState: readFileSafe(path.join(dir, 'cur_state')),
          maxState: readFileSafe(path.join(dir, 'max_state')),
        };
      })
    : [];

  return report;
}

module.exports = {
  listChips,
  readTempsC,
  readFans,
  readCoolingFans,
  setFanPercent,
  setFanAuto,
  setFanFullSpeed,
  setCoolingLevel,
  diagnostics,
};
