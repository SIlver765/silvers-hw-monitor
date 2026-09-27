'use strict';

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function execFileSafe(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Aggregate CPU busy/idle jiffies across all cores from /proc/stat. */
function readCpuJiffies() {
  const stat = readFileSafe('/proc/stat');
  if (!stat) {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  }
  const line = stat.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal"
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

let lastJiffies = readCpuJiffies();

/** Percent CPU busy since the previous call (call on a ~1-2s poll cadence). */
function cpuUsagePercent() {
  const now = readCpuJiffies();
  const deltaIdle = now.idle - lastJiffies.idle;
  const deltaTotal = now.total - lastJiffies.total;
  lastJiffies = now;
  if (deltaTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)));
}

function memoryInfo() {
  const meminfo = readFileSafe('/proc/meminfo');
  if (!meminfo) {
    const total = os.totalmem();
    const free = os.freemem();
    return { totalBytes: total, usedBytes: total - free, percent: Math.round(((total - free) / total) * 100) };
  }
  const kv = {};
  for (const line of meminfo.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]) * 1024; // kB -> bytes
  }
  const total = kv.MemTotal || 0;
  const available = kv.MemAvailable ?? kv.MemFree ?? 0;
  const used = total - available;
  return { totalBytes: total, usedBytes: used, percent: total ? Math.round((used / total) * 100) : 0 };
}

/** Disk usage per mounted filesystem, via `df` (present in virtually every base image). */
async function diskUsage() {
  const out = await execFileSafe('df', ['-kP']);
  if (!out) return [];
  const lines = out.trim().split('\n').slice(1);
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const [fsName, blocks1k, used1k, , usePct, mount] = parts;
      if (!fsName.startsWith('/dev/')) return null;
      return {
        filesystem: fsName,
        mount,
        totalBytes: Number(blocks1k) * 1024,
        usedBytes: Number(used1k) * 1024,
        percent: Number(usePct.replace('%', '')),
      };
    })
    .filter(Boolean);
}

/** Best-effort per-drive temperature via smartctl; skipped silently if unavailable/unprivileged. */
async function driveTemps() {
  const lsblk = await execFileSafe('lsblk', ['-dno', 'NAME,TYPE']);
  if (!lsblk) return [];
  const disks = lsblk
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([, type]) => type === 'disk')
    .map(([name]) => name);

  const results = [];
  for (const name of disks) {
    const out = await execFileSafe('smartctl', ['-A', '-j', `/dev/${name}`]);
    if (!out) continue;
    try {
      const json = JSON.parse(out);
      const temp = json.temperature?.current;
      if (typeof temp === 'number') results.push({ device: name, celsius: temp });
    } catch {
      // smartctl not available/parsable — leave this drive without a temp reading
    }
  }
  return results;
}

module.exports = { cpuUsagePercent, memoryInfo, diskUsage, driveTemps };
