const POLL_MS = 30000;
const MAX_POINTS = (4 * 60 * 60) / (POLL_MS / 1000);
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

document.getElementById('apply-btn').addEventListener('click', () => {
  apiBase = apiInput.value.trim().replace(/\/$/, '');
  deviceId = deviceInput.value.trim();

  localStorage.setItem('telemetry-api-base', apiBase);
  localStorage.setItem('telemetry-device-id', deviceId);

  history.length = 0;
  updateCharts();
  fetchLatest();
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

  const ago = pts > 1 ? `${timeSince(history[0].ts)} ago → now` : 'collecting…';
  document.getElementById('chart-t-meta').textContent = ago;
  document.getElementById('chart-h-meta').textContent = ago;
}

function timeSince(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
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

    console.log('API response:', data);

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const temp = parseFloat(data.temperature ?? data.temp ?? data.Temperature);
    const humid = parseFloat(data.humidity ?? data.hum ?? data.Humidity);
    const rawTs = data.ts ?? data.timestamp ?? data.time ?? new Date().toISOString();
    const parsedTs = parseTimestamp(rawTs);

    if (Number.isNaN(temp)) throw new Error('Temperature missing in API response');
    if (Number.isNaN(humid)) throw new Error('Humidity missing in API response');
    if (Number.isNaN(parsedTs.getTime())) throw new Error('Timestamp invalid in API response');

    setStatus(
      'ok',
      'LIVE',
      parsedTs.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );

    updateTile('val-temp', 'sub-temp', temp, '°C', 18, 25, 'temp');
    updateTile('val-humid', 'sub-humid', humid, '%', 40, 60, 'humid');

    history.push({
      ts: parsedTs,
      temperature: temp,
      humidity: humid
    });

    if (history.length > MAX_POINTS) history.shift();

    updateCharts();
  } catch (err) {
    console.error('Fetch failed:', err);
    setStatus('err', 'ERROR', err.message);
  }
}

fetchLatest();
setInterval(fetchLatest, POLL_MS);