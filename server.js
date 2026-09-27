'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const hwmon = require('./lib/hwmon');
const metrics = require('./lib/metrics');

const PORT = process.env.PORT || 3300;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function pickCpuTemp(temps) {
  const byLabel = temps.find((t) => /package|tctl|tdie|cpu/i.test(t.label));
  return byLabel ? byLabel.celsius : temps[0]?.celsius ?? null;
}

app.get('/api/status', async (req, res) => {
  try {
    const temps = hwmon.readTempsC();
    const fans = hwmon.readFans();
    const [disks, drives] = await Promise.all([metrics.diskUsage(), metrics.driveTemps()]);

    res.json({
      host: os.hostname(),
      uptimeSeconds: os.uptime(),
      cpu: {
        usagePercent: metrics.cpuUsagePercent(),
        temperatureC: pickCpuTemp(temps),
        cores: os.cpus().length,
      },
      memory: metrics.memoryInfo(),
      temps,
      fans,
      disks,
      drives,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fans/:id/percent', (req, res) => {
  const { percent } = req.body;
  if (typeof percent !== 'number' || percent < 0 || percent > 100) {
    return res.status(400).json({ ok: false, error: 'percent must be a number 0-100' });
  }
  const result = hwmon.setFanPercent(decodeURIComponent(req.params.id), percent);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/fans/:id/auto', (req, res) => {
  const result = hwmon.setFanAuto(decodeURIComponent(req.params.id));
  res.status(result.ok ? 200 : 400).json(result);
});

app.listen(PORT, () => {
  console.log(`Silver's HW Monitor listening on :${PORT}`);
});
