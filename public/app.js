'use strict';

const POLL_MS = 2000;
const ARC_LENGTH = 126; // matches the path length used in gaugeSvg()

function bytesToGiB(bytes) {
  return bytes / (1024 ** 3);
}

function tempClass(c) {
  if (c === null || c === undefined) return '';
  if (c >= 80) return 'temp-hot';
  if (c >= 60) return 'temp-warn';
  return 'temp-ok';
}

function gaugeSvg(percent, color) {
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const offset = ARC_LENGTH - (ARC_LENGTH * clamped) / 100;
  return `
    <svg viewBox="0 0 100 60" width="100%" height="60">
      <path d="M10,55 A40,40 0 0,1 90,55" fill="none" stroke="var(--track)" stroke-width="8" stroke-linecap="round"/>
      <path d="M10,55 A40,40 0 0,1 90,55" fill="none" stroke="${color}" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="${ARC_LENGTH}" stroke-dashoffset="${offset}"/>
    </svg>`;
}

function renderStats(data) {
  const grid = document.getElementById('stat-grid');
  const cpu = data.cpu || {};
  const mem = data.memory || {};
  const primaryDisk = (data.disks || [])[0];

  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">CPU</div>
      ${gaugeSvg(cpu.usagePercent, 'var(--accent-blue)')}
      <div class="stat-value">${cpu.temperatureC != null ? cpu.temperatureC.toFixed(0) + '°C' : '—'}</div>
      <div class="stat-sub">${cpu.usagePercent ?? 0}% load · ${cpu.cores ?? '?'} cores</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">RAM</div>
      ${gaugeSvg(mem.percent, 'var(--accent-green)')}
      <div class="stat-value">${mem.usedBytes != null ? bytesToGiB(mem.usedBytes).toFixed(1) + ' GB' : '—'}</div>
      <div class="stat-sub">of ${mem.totalBytes != null ? bytesToGiB(mem.totalBytes).toFixed(0) + ' GB' : '?'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Storage</div>
      ${gaugeSvg(primaryDisk?.percent, 'var(--accent-amber)')}
      <div class="stat-value">${primaryDisk ? primaryDisk.percent + '%' : '—'}</div>
      <div class="stat-sub">${primaryDisk ? bytesToGiB(primaryDisk.usedBytes).toFixed(0) + ' / ' + bytesToGiB(primaryDisk.totalBytes).toFixed(0) + ' GB' : 'no disks found'}</div>
    </div>`;
}

function renderDrives(data) {
  const list = document.getElementById('drive-list');
  const drives = data.drives || [];
  const disks = data.disks || [];

  if (disks.length === 0) {
    list.innerHTML = '<div class="drive-row"><span>No mounted drives detected</span></div>';
    return;
  }

  list.innerHTML = disks
    .map((d) => {
      const tempEntry = drives.find((dr) => d.filesystem.includes(dr.device));
      const tempStr = tempEntry ? `${tempEntry.celsius.toFixed(0)}°C · ` : '';
      return `<div class="drive-row">
        <span>${d.mount}</span>
        <span class="drive-meta"><span class="${tempClass(tempEntry?.celsius)}">${tempStr}</span>${d.percent}% used</span>
      </div>`;
    })
    .join('');
}

const fanPresets = { silent: 30, balanced: 55, performance: 85 };
const fanState = {}; // id -> pending debounce timer

function applyFanPercent(id, percent) {
  clearTimeout(fanState[id]);
  fanState[id] = setTimeout(() => {
    fetch(`/api/fans/${encodeURIComponent(id)}/percent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent }),
    }).catch(() => {});
  }, 250);
}

function setFanAuto(id) {
  fetch(`/api/fans/${encodeURIComponent(id)}/auto`, { method: 'POST' }).catch(() => {});
}

function renderFans(data) {
  const list = document.getElementById('fan-list');
  const fans = (data.fans || []).filter((f) => f.controllable || f.rpm !== null);

  if (fans.length === 0) {
    list.innerHTML = '<div class="fan-block">No controllable fans detected on this host.</div>';
    return;
  }

  list.innerHTML = fans
    .map((f) => {
      const percent = f.percent ?? 0;
      const safeId = f.id.replace(/[^a-zA-Z0-9]/g, '-');
      return `
        <div class="fan-block" data-fan-id="${f.id}">
          <div class="fan-head">
            <span>${f.label}</span>
            <span class="fan-rpm">${f.rpm != null ? f.rpm + ' RPM' : '—'}</span>
          </div>
          ${
            f.controllable
              ? `
          <div class="slider-row">
            <input type="range" min="0" max="100" value="${percent}" id="slider-${safeId}" ${f.controllable ? '' : 'disabled'} />
            <span class="slider-value" id="value-${safeId}">${percent}%</span>
          </div>
          <div class="preset-row">
            <button class="preset-btn" data-preset="silent">Silent</button>
            <button class="preset-btn" data-preset="balanced">Balanced</button>
            <button class="preset-btn" data-preset="performance">Performance</button>
            <button class="preset-btn" data-preset="auto">Auto</button>
          </div>`
              : '<div class="fan-rpm">Read-only on this chip</div>'
          }
        </div>`;
    })
    .join('');

  for (const f of fans) {
    if (!f.controllable) continue;
    const safeId = f.id.replace(/[^a-zA-Z0-9]/g, '-');
    const slider = document.getElementById(`slider-${safeId}`);
    const valueLabel = document.getElementById(`value-${safeId}`);
    slider.addEventListener('input', () => {
      valueLabel.textContent = `${slider.value}%`;
      applyFanPercent(f.id, Number(slider.value));
    });
  }

  list.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.fan-block');
      const id = block.dataset.fanId;
      const preset = btn.dataset.preset;
      block.querySelectorAll('.preset-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (preset === 'auto') {
        setFanAuto(id);
        return;
      }
      const percent = fanPresets[preset];
      const safeId = id.replace(/[^a-zA-Z0-9]/g, '-');
      const slider = document.getElementById(`slider-${safeId}`);
      const valueLabel = document.getElementById(`value-${safeId}`);
      if (slider) slider.value = percent;
      if (valueLabel) valueLabel.textContent = `${percent}%`;
      applyFanPercent(id, percent);
    });
  });
}

async function poll() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    document.getElementById('empty-note').hidden = (data.temps || []).length > 0 || (data.fans || []).length > 0;
    renderStats(data);
    renderDrives(data);
    renderFans(data);
  } catch (err) {
    console.error('status poll failed', err);
  }
}

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('hw-monitor-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  const syncIcon = () => {
    const isDark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    btn.textContent = isDark ? '☀️' : '🌙';
  };
  syncIcon();

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const isDarkNow =
      current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDarkNow ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('hw-monitor-theme', next);
    syncIcon();
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${name}`;
  });
  if (name === 'logs') {
    document.getElementById('log-error-badge').hidden = true;
  }
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function formatLogTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function renderLogs(logs) {
  const list = document.getElementById('log-list');
  if (logs.length === 0) {
    list.innerHTML = '<div class="log-empty">No log entries yet.</div>';
    return;
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = logs
    .map(
      (l) => `<div class="log-row ${l.level}">
        <span class="log-time">${formatLogTime(l.ts)}</span>
        <span class="log-level">${l.level.toUpperCase()}</span>
        <span class="log-msg">${escapeHtml(l.message)}</span>
      </div>`
    )
    .join('');

  const autoscroll = document.getElementById('log-autoscroll').checked;
  if (autoscroll && atBottom) list.scrollTop = list.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function pollLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    const logs = data.logs || [];
    renderLogs(logs);

    const logsTabActive = document.getElementById('tab-logs').hidden === false;
    if (!logsTabActive && logs.some((l) => l.level === 'error')) {
      document.getElementById('log-error-badge').hidden = false;
    }
  } catch (err) {
    console.error('log poll failed', err);
  }
}

function initLogControls() {
  document.getElementById('log-clear').addEventListener('click', async () => {
    await fetch('/api/logs/clear', { method: 'POST' }).catch(() => {});
    pollLogs();
  });
}

function initDiagnostics() {
  document.getElementById('run-diagnostics').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      await fetch('/api/diagnostics/run', { method: 'POST' });
    } catch (err) {
      console.error('diagnostics request failed', err);
    }
    await pollLogs();
    switchTab('logs');
    btn.disabled = false;
    btn.textContent = 'Run diagnostics';
  });
}

initTheme();
initTabs();
initLogControls();
initDiagnostics();
poll();
pollLogs();
setInterval(poll, POLL_MS);
setInterval(pollLogs, POLL_MS);
