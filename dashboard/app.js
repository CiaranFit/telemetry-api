const POLL_MS = 30000;
const API_BASE = window.location.origin.startsWith("http")
  ? window.location.origin
  : "http://localhost:8000";

const history = [];
let selectedHours = Number(localStorage.getItem("telemetry-window-hours")) || 4;
let deviceId = localStorage.getItem("telemetry-device-id") || "";

const deviceSelect = document.getElementById("device-select");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const lastSeen = document.getElementById("last-seen");
const windowButtons = Array.from(document.querySelectorAll(".window-btn"));

let pollHandle = null;

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "#13161b",
      borderColor: "#1e232c",
      borderWidth: 1,
      titleColor: "#4a5568",
      bodyColor: "#d4dbe8",
      titleFont: { family: "'Space Mono', monospace", size: 10 },
      bodyFont: { family: "'Space Mono', monospace", size: 11 },
      padding: 10
    }
  },
  scales: {
    x: {
      grid: { color: "#1a1e26", drawBorder: false },
      ticks: {
        color: "#4a5568",
        font: { family: "'Space Mono', monospace", size: 9 },
        maxTicksLimit: 6,
        maxRotation: 0
      },
      border: { display: false }
    },
    y: {
      grid: { color: "#1a1e26", drawBorder: false },
      ticks: {
        color: "#4a5568",
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
  const ctx = document.getElementById(canvasId).getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, color + "33");
  grad.addColorStop(1, color + "00");

  return new Chart(ctx, {
    type: "line",
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

const chartTemp = makeChart("chart-temp", "#e8834a");
const chartHumid = makeChart("chart-humid", "#4ab8e8");

function parseTimestamp(ts) {
  if (typeof ts === "number") return new Date(ts * 1000);
  if (typeof ts === "string" && /^\d+$/.test(ts)) return new Date(Number(ts) * 1000);
  return new Date(ts);
}

function setStatus(state, text, detail = "") {
  statusDot.className = state;
  statusText.textContent = text;
  lastSeen.textContent = detail ? `· ${detail}` : "";
}

function setWindowButtons() {
  for (const btn of windowButtons) {
    btn.classList.toggle("active", Number(btn.dataset.hours) === selectedHours);
  }

  document.getElementById("chart-t-title").textContent = `Temperature / ${selectedHours}hr window`;
  document.getElementById("chart-h-title").textContent = `Humidity / ${selectedHours}hr window`;
}

function updateTile(valId, subId, value, unit, low, high, type) {
  if (Number.isNaN(value)) return;

  const el = document.getElementById(valId);
  const sub = document.getElementById(subId);

  const color = type === "temp"
    ? (value > high ? "#e85c5c" : value < low ? "#4ab8e8" : "#e8834a")
    : (value > high ? "#e85c5c" : value < low ? "#e8834a" : "#4ab8e8");

  const tag = type === "temp"
    ? (value > high ? "ABOVE RANGE" : value < low ? "BELOW RANGE" : "NORMAL")
    : (value > high ? "HIGH" : value < low ? "LOW" : "NORMAL");

  el.innerHTML = `${value.toFixed(1)}<span class="tile-unit">${unit}</span>`;
  el.style.color = color;
  sub.textContent = tag;
}

function updateWeatherTile(data) {
  const val = document.getElementById("val-weather");
  const sub = document.getElementById("sub-weather");

  if (!data) {
    val.innerHTML = `--<span class="tile-unit">°C</span>`;
    sub.textContent = "forecast unavailable";
    return;
  }

  const temp = Number(data.temp_max ?? data.temperature ?? data.temp ?? NaN);
  const tempText = Number.isNaN(temp) ? "--" : temp.toFixed(0);

  val.innerHTML = `${tempText}<span class="tile-unit">°C</span>`;

  const parts = [];
  if (data.condition) parts.push(String(data.condition).toUpperCase());
  if (data.temp_min != null && data.temp_max != null) {
    parts.push(`${Number(data.temp_min).toFixed(0)}–${Number(data.temp_max).toFixed(0)}°C`);
  }
  if (data.precip_chance != null) {
    parts.push(`${Math.round(Number(data.precip_chance))}% RAIN`);
  }

  sub.textContent = parts.length ? parts.join(" · ") : "forecast loaded";
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

function trimHistoryWindow() {
  const cutoff = Date.now() - selectedHours * 60 * 60 * 1000;
  while (history.length && history[0].ts.getTime() < cutoff) {
    history.shift();
  }
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
    r.ts.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit"
    })
  );

  chartTemp.data.labels = labels;
  chartTemp.data.datasets[0].data = history.map(r => r.temperature);
  chartTemp.update();

  chartHumid.data.labels = labels;
  chartHumid.data.datasets[0].data = history.map(r => r.humidity);
  chartHumid.update();

  const pts = history.length;
  document.getElementById("nd-temp").style.display = pts > 1 ? "none" : "flex";
  document.getElementById("nd-humid").style.display = pts > 1 ? "none" : "flex";

  let meta = "collecting…";
  if (pts > 1) {
    const first = history[0].ts;
    const last = history[history.length - 1].ts;
    meta =
      `${first.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` +
      ` → ` +
      `${last.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` +
      ` · ${pts} pts`;
  }

  document.getElementById("chart-t-meta").textContent = meta;
  document.getElementById("chart-h-meta").textContent = meta;
}

async function fetchDevices() {
  const res = await fetch(`${API_BASE}/devices`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const devices = Array.isArray(data.devices) ? data.devices : [];
  deviceSelect.innerHTML = "";

  for (const dev of devices) {
    const opt = document.createElement("option");
    opt.value = dev;
    opt.textContent = dev;
    deviceSelect.appendChild(opt);
  }

  if (!devices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No devices found";
    deviceSelect.appendChild(opt);
    deviceId = "";
    return;
  }

  if (!devices.includes(deviceId)) {
    deviceId = devices[0];
    localStorage.setItem("telemetry-device-id", deviceId);
  }

  deviceSelect.value = deviceId;
}

async function fetchHistory() {
  if (!deviceId) {
    setStatus("err", "ERROR", "No device selected");
    return;
  }

  setStatus("init", "LOADING", `${selectedHours}hr history`);

  const minutes = selectedHours * 60;
  const url = `${API_BASE}/history?device_id=${encodeURIComponent(deviceId)}&minutes=${minutes}&mode=time`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const rows = Array.isArray(data.history) ? data.history : [];
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
    updateTile("val-temp", "sub-temp", latest.temperature, "°C", 18, 25, "temp");
    updateTile("val-humid", "sub-humid", latest.humidity, "%", 40, 60, "humid");
    setStatus(
      "ok",
      "LIVE",
      latest.ts.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    );
  } else {
    setStatus("init", "LIVE", "no history yet");
  }
}

async function fetchLatest() {
  if (!deviceId) return;

  try {
    const url = `${API_BASE}/latest?device_id=${encodeURIComponent(deviceId)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const point = normaliseRecord(data);
    if (!point) {
      throw new Error("Latest response missing temperature, humidity or timestamp");
    }

    updateTile("val-temp", "sub-temp", point.temperature, "°C", 18, 25, "temp");
    updateTile("val-humid", "sub-humid", point.humidity, "%", 40, 60, "humid");

    addOrReplacePoint(point);
    updateCharts();

    setStatus(
      "ok",
      "LIVE",
      point.ts.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    );
  } catch (err) {
    console.error("Fetch latest failed:", err);
    setStatus("err", "ERROR", err.message);
  }
}

async function fetchWeatherToday() {
  try {
    const res = await fetch(`${API_BASE}/weather/today`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    updateWeatherTile(data);
  } catch (err) {
    console.error("Weather fetch failed:", err);
    updateWeatherTile(null);
  }
}

async function initialiseDashboard() {
  try {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }

    setWindowButtons();
    await fetchDevices();
    await fetchHistory();
    await fetchLatest();
    await fetchWeatherToday();

    pollHandle = setInterval(fetchLatest, POLL_MS);
  } catch (err) {
    console.error("Initialisation failed:", err);
    setStatus("err", "ERROR", err.message);
  }
}

deviceSelect.addEventListener("change", async (e) => {
  deviceId = e.target.value;
  localStorage.setItem("telemetry-device-id", deviceId);
  history.length = 0;
  updateCharts();
  await initialiseDashboard();
});

for (const btn of windowButtons) {
  btn.addEventListener("click", async () => {
    selectedHours = Number(btn.dataset.hours);
    localStorage.setItem("telemetry-window-hours", String(selectedHours));
    history.length = 0;
    setWindowButtons();
    updateCharts();
    await fetchHistory();
    await fetchLatest();
  });
}

initialiseDashboard();
