'use strict';

const fs = require('fs');
const path = require('path');

const HWMON_ROOT = '/sys/class/hwmon';
const THERMAL_ROOT = '/sys/class/thermal';

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

      const fans = listEntries(chipDir, 'fan')
        .filter((f) => f.endsWith('_input'))
        .map((f) => {
          const idx = f.match(/fan(\d+)_input/)[1];
          const label = readFileSafe(path.join(chipDir, `fan${idx}_label`)) || `${name} fan${idx}`;
          const pwmPath = path.join(chipDir, `pwm${idx}`);
          const pwmEnablePath = path.join(chipDir, `pwm${idx}_enable`);
          return {
            id: `${entry}/fan${idx}`,
            label,
            inputPath: path.join(chipDir, f),
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
      const rpmRaw = readFileSafe(f.inputPath);
      const pwmRaw = f.pwmPath ? readFileSafe(f.pwmPath) : null;
      const enableRaw = f.pwmEnablePath ? readFileSafe(f.pwmEnablePath) : null;
      fans.push({
        id: f.id,
        chip: chip.name,
        label: f.label,
        rpm: rpmRaw === null ? null : Number(rpmRaw),
        percent: pwmRaw === null ? null : Math.round((Number(pwmRaw) / 255) * 100),
        controllable: Boolean(f.pwmPath),
        mode: enableRaw === null ? null : Number(enableRaw), // 0=full/off, 1=manual, 2+=auto
      });
    }
  }
  return fans;
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

/** Return a fan to automatic/BIOS control. */
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

  return report;
}

module.exports = { listChips, readTempsC, readFans, setFanPercent, setFanAuto, diagnostics };
