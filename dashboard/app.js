const POLL_MS = 30000;
const WINDOW_MS = 4 * 60 * 60 * 1000;
const history = [];

let apiBase = localStorage.getItem('telemetry-api-base') || 'http://192.168.1.7:8000';
let deviceId = localStorage.getItem('telemetry-device-id') || 'Test_01';

const apiInput = document.getElementById('api-url-input');
const deviceInput = document.getElementById('device-id-input');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const lastSeen = document.getElementById('last-seen');

apiInput.value = apiBase;
deviceInput.value = deviceId;

let pollHandle = null;

document.getElementById('apply-btn').addEventListener('click', async () => {
  apiBase = apiInput.value.trim().replace(/\/$/, '');
  deviceId = deviceInput.value.trim();

  localStorage.setItem('telemetry-api-base', apiBase);
  localStorage.setItem('telemetry-device-id', deviceId);

  history.length = 0;
  updateCharts();

  await initialiseDashboard();
});

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#13161b',
      borderColor: '#1e232c',
      borderWidth: 1,
      titleColor: '#4a5568',
      bodyColor: '#d4dbe8',
      titleFont: { family: "'Space Mono', monospace", size: 10 },
      bodyFont: { family: "'Space Mono', monospace", size: 11 },
      padding: 10
    }
  },
  scales: {
    x: {
      grid: { color: '#1a1e26', drawBorder: false },
      ticks: {
        color: '#4a5568',
        font: { family: "'Space Mono', monospace", size: 9 },
        maxTicksLimit: 6,
        maxRotation: 0
      },
      border: { display: false }
    },
    y: {
      grid: { color: '#1a1e26', drawBorder: false },
      ticks: {
        color: '#4a5568',
        font: { family: "'Space Mono', monospace", size: 9 }
      },
      border: { display: false }
    }
  },
  elements: {
    point: { radius: 0, hoverRadius: 4 },
    line: { tension: 0.35 }
  }
};

function makeChart(canvasId, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '00');

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        borderWidth: 2,
        backgroundColor: grad,
        fill: true
      }]
    },
    options: chartDefaults
  });
}

const chartTemp = makeChart('chart-temp', '#e8834a');
const chartHumid = makeChart('chart-humid', '#4ab8e8');

function parseTimestamp(ts) {
  if (typeof ts === 'number') return new Date(ts * 1000);
  if (typeof ts === 'string' && /^\d+$/.test(ts)) return new Date(Number(ts) * 1000);
  return new Date(ts);
}

function setStatus(state, text, detail = '') {
  statusDot.className = state;
  statusText.textContent = text;
  lastSeen.textContent = detail ? `· ${detail}` : '';
}

function updateTile(valId, subId, value, unit, low, high, type) {
  if (Number.isNaN(value)) return;

  const el = document.getElementById(valId);
  const sub = document.getElementById(subId);

  const color = type === 'temp'
    ? (value > high ? '#e85c5c' : value < low ? '#4ab8e8' : '#e8834a')
    : (value > high ? '#e85c5c' : value < low ? '#e8834a' : '#4ab8e8');

  const tag = type === 'temp'
    ? (value > high ? 'ABOVE RANGE' : value < low ? 'BELOW RANGE' : 'NORMAL')
    : (value > high ? 'HIGH' : value < low ? 'LOW' : 'NORMAL');

  el.innerHTML = `${value.toFixed(1)}<span class="tile-unit">${unit}</span>`;
  el.style.color = color;
  sub.textContent = tag;
}

function normaliseRecord(row) {
  const temp = parseFloat(row.temperature ?? row.temp ?? row.Temperature);
  const humid = parseFloat(row.humidity ?? row.hum ?? row.Humidity);
  const tsRaw = row.ts ?? row.timestamp ?? row.time;

  const ts = parseTimestamp(tsRaw);

  if (Number.isNaN(temp) || Number.isNaN(humid) || Number.isNaN(ts.getTime())) {
    return null;
  }

  return {
    ts,
    temperature: temp,
    humidity: humid
  };
}

function trimHistoryWindow() {
  const cutoff = Date.now() - WINDOW_MS;

  while (history.length && history[0].ts.getTime() < cutoff) {
    history.shift();
  }
}

function sortHistory() {
  history.sort((a, b) => a.ts - b.ts);
}

function dedupeHistory() {
  const deduped = [];
  const seen = new Set();

  for (const point of history) {
    const key = point.ts.getTime();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(point);
    }
  }

  history.length = 0;
  history.push(...deduped);
}

function addOrReplacePoint(point) {
  const tsMs = point.ts.getTime();
  const existingIndex = history.findIndex(p => p.ts.getTime() === tsMs);

  if (existingIndex >= 0) {
    history[existingIndex] = point;
  } else {
    history.push(point);
  }

  sortHistory();
  dedupeHistory();
  trimHistoryWindow();
}

function updateCharts() {
  const labels = history.map(r =>
    r.ts.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    })
  );

  chartTemp.data.labels = labels;
  chartTemp.data.datasets[0].data = history.map(r => r.temperature);
  chartTemp.update();

  chartHumid.data.labels = labels;
  chartHumid.data.datasets[0].data = history.map(r => r.humidity);
  chartHumid.update();

  const pts = history.length;
  document.getElementById('nd-temp').style.display = pts > 1 ? 'none' : 'flex';
  document.getElementById('nd-humid').style.display = pts > 1 ? 'none' : 'flex';

  let meta = 'collecting…';
  if (pts > 1) {
    const first = history[0].ts;
    const last = history[history.length - 1].ts;
    meta =
      `${first.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` +
      ` → ` +
      `${last.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` +
      ` · ${pts} pts`;
  }

  document.getElementById('chart-t-meta').textContent = meta;
  document.getElementById('chart-h-meta').textContent = meta;
}

async function fetchHistory() {
  if (!apiBase || !deviceId) {
    setStatus('err', 'ERROR', 'Missing API base or device ID');
    return;
  }

  setStatus('init', 'LOADING', '4hr history');

  const url = `${apiBase}/history?device_id=${encodeURIComponent(deviceId)}&minutes=240&mode=time`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  let rows = [];

  if (Array.isArray(data)) {
    rows = data;
  } else if (Array.isArray(data.history)) {
    rows = data.history;
  } else if (Array.isArray(data.records)) {
    rows = data.records;
  } else if (Array.isArray(data.data)) {
    rows = data.data;
  } else {
    throw new Error('History response format not recognised');
  }

  history.length = 0;

  for (const row of rows) {
    const point = normaliseRecord(row);
    if (point) history.push(point);
  }

  sortHistory();
  dedupeHistory();
  trimHistoryWindow();
  updateCharts();

  if (history.length > 0) {
    const latest = history[history.length - 1];

    updateTile('val-temp', 'sub-temp', latest.temperature, '°C', 18, 25, 'temp');
    updateTile('val-humid', 'sub-humid', latest.humidity, '%', 40, 60, 'humid');

    setStatus(
      'ok',
      'LIVE',
      latest.ts.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );
  } else {
    setStatus('init', 'LIVE', 'no history yet');
  }
}

async function fetchLatest() {
  if (!apiBase || !deviceId) {
    setStatus('err', 'ERROR', 'Missing API base or device ID');
    return;
  }

  try {
    const url = `${apiBase}/latest?device_id=${encodeURIComponent(deviceId)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const point = normaliseRecord(data);

    if (!point) {
      throw new Error('Latest response missing temperature, humidity or timestamp');
    }

    updateTile('val-temp', 'sub-temp', point.temperature, '°C', 18, 25, 'temp');
    updateTile('val-humid', 'sub-humid', point.humidity, '%', 40, 60, 'humid');

    addOrReplacePoint(point);
    updateCharts();

    setStatus(
      'ok',
      'LIVE',
      point.ts.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );
  } catch (err) {
    console.error('Fetch latest failed:', err);
    setStatus('err', 'ERROR', err.message);
  }
}

async function initialiseDashboard() {
  try {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }

    await fetchHistory();
    await fetchLatest();

    pollHandle = setInterval(fetchLatest, POLL_MS);
  } catch (err) {
    console.error('Initialisation failed:', err);
    setStatus('err', 'ERROR', err.message);
  }
}

initialiseDashboard();