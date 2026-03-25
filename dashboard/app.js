const POLL_MS = 30000;
const MAX_HISTORY_POINTS = 480;
const savedApiBase = localStorage.getItem("telemetry-api-base") || "";
let apiBase = savedApiBase || "";

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
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") {
    return {
      data: { labels: [], datasets: [{ data: [] }] },
      update() {}
    };
  }

  const ctx = canvas.getContext("2d");
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

function formatStatusTimestamp(ts) {
  const ageMs = Date.now() - ts.getTime();
  const isStale = ageMs > 24 * 60 * 60 * 1000;

  if (isStale) {
    return ts.toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  return ts.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setDeviceSelectState(label, { disabled = true, value = "" } = {}) {
  deviceSelect.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  deviceSelect.appendChild(opt);
  deviceSelect.value = value;
  deviceSelect.disabled = disabled;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();

  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from ${url}`);
    }
  }

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

function getApiCandidates() {
  const candidates = [];
  const origin = window.location.origin;
  const host = window.location.hostname;
  const protocol = window.location.protocol || "http:";

  if (savedApiBase) candidates.push(savedApiBase);
  if (window.location.port === "8000" && origin.startsWith("http")) candidates.push(origin);
  if (host) candidates.push(`${protocol}//${host}:8000`);
  if (origin.startsWith("http")) candidates.push(origin);
  candidates.push("http://localhost:8000");
  candidates.push("http://127.0.0.1:8000");

  return [...new Set(candidates)];
}

async function probeApiBase(candidate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(`${candidate}/health`, {
      signal: controller.signal
    });
    if (!res.ok) return false;

    const text = await res.text();
    if (!text) return false;

    try {
      const data = JSON.parse(text);
      return data.status === "healthy";
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveApiBase() {
  const candidates = getApiCandidates();

  for (const candidate of candidates) {
    if (await probeApiBase(candidate)) {
      apiBase = candidate;
      localStorage.setItem("telemetry-api-base", apiBase);
      return apiBase;
    }
  }

  throw new Error(`Unable to reach API. Tried: ${candidates.join(", ")}`);
}

function setStatus(state, text, detail = "") {
  statusDot.className = state;
  statusText.textContent = text;
  lastSeen.textContent = detail ? `· ${detail}` : "";
}

function setControlsEnabled(enabled) {
  deviceSelect.disabled = !enabled;
  for (const btn of windowButtons) {
    btn.disabled = !enabled;
  }
}

function setWindowButtons() {
  for (const btn of windowButtons) {
    btn.classList.toggle("active", Number(btn.dataset.hours) === selectedHours);
  }

  document.getElementById("chart-t-title").textContent = `Temperature / ${selectedHours}hr window`;
  document.getElementById("chart-h-title").textContent = `Humidity / ${selectedHours}hr window`;
}

function getHistoryLimit() {
  return Math.min(5000, Math.max(MAX_HISTORY_POINTS, selectedHours * 180));
}

function formatChartLabel(ts) {
  if (selectedHours >= 24) {
    return ts.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return ts.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });
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

function downsamplePoints(points, maxPoints) {
  if (points.length <= maxPoints) {
    return points;
  }

  const sampled = [];
  const lastIndex = points.length - 1;

  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * lastIndex) / (maxPoints - 1));
    sampled.push(points[index]);
  }

  return sampled;
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

function setYAxisRange(chart, values, padding) {
  if (!chart.options || !chart.options.scales || !chart.options.scales.y) {
    return;
  }

  if (!values.length) {
    delete chart.options.scales.y.min;
    delete chart.options.scales.y.max;
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  chart.options.scales.y.min = Math.floor(min - padding);
  chart.options.scales.y.max = Math.ceil(max + padding);
}

function updateCharts() {
  const chartPoints = downsamplePoints(history, MAX_HISTORY_POINTS);
  const labels = chartPoints.map(r => formatChartLabel(r.ts));
  const tempValues = chartPoints.map(r => r.temperature);
  const humidValues = chartPoints.map(r => r.humidity);

  chartTemp.data.labels = labels;
  chartTemp.data.datasets[0].data = tempValues;
  setYAxisRange(chartTemp, tempValues, 2);
  chartTemp.update();

  chartHumid.data.labels = labels;
  chartHumid.data.datasets[0].data = humidValues;
  setYAxisRange(chartHumid, humidValues, 5);
  chartHumid.update();

  const pts = history.length;
  document.getElementById("nd-temp").style.display = pts > 0 ? "none" : "flex";
  document.getElementById("nd-humid").style.display = pts > 0 ? "none" : "flex";

  let meta = "collecting…";
  if (pts > 1) {
    const first = history[0].ts;
    const last = history[history.length - 1].ts;
    meta =
      `${formatChartLabel(first)}` +
      ` → ` +
      `${formatChartLabel(last)}` +
      ` · ${pts} pts`;
  } else if (pts === 1) {
    meta = `${formatChartLabel(history[0].ts)} · 1 pt`;
  }

  document.getElementById("chart-t-meta").textContent = meta;
  document.getElementById("chart-h-meta").textContent = meta;
}

async function fetchDevices() {
  setDeviceSelectState("Loading devices...");
  setControlsEnabled(false);
  const data = await fetchJson(`${apiBase}/devices`);
  const devices = Array.isArray(data.devices) ? data.devices : [];
  deviceSelect.innerHTML = "";
  deviceSelect.disabled = false;

  for (const dev of devices) {
    const opt = document.createElement("option");
    opt.value = dev;
    opt.textContent = dev;
    deviceSelect.appendChild(opt);
  }

  if (!devices.length) {
    setDeviceSelectState("No devices found");
    deviceId = "";
    return;
  }

  if (!devices.includes(deviceId)) {
    deviceId = devices[0];
    localStorage.setItem("telemetry-device-id", deviceId);
  }

  deviceSelect.value = deviceId;
  setControlsEnabled(true);
}

async function fetchHistory() {
  if (!deviceId) {
    setStatus("err", "ERROR", "No device selected");
    return;
  }

  setStatus("init", "LOADING", `${selectedHours}hr history`);

  const minutes = selectedHours * 60;
  const limit = getHistoryLimit();
  const url = `${apiBase}/history?device_id=${encodeURIComponent(deviceId)}&minutes=${minutes}&limit=${limit}&mode=time`;
  const data = await fetchJson(url);

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
      formatStatusTimestamp(latest.ts)
    );
  } else {
    setStatus("init", "LIVE", "no history yet");
  }
}

async function fetchLatest() {
  if (!deviceId) return;

  try {
    const url = `${apiBase}/latest?device_id=${encodeURIComponent(deviceId)}`;
    const data = await fetchJson(url);

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
      formatStatusTimestamp(point.ts)
    );
  } catch (err) {
    console.error("Fetch latest failed:", err);
    setStatus("err", "ERROR", err.message);
  }
}

async function fetchWeatherToday() {
  try {
    const data = await fetchJson(`${apiBase}/weather/today`);
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

    setStatus("init", "CONNECTING", "probing API");
    await resolveApiBase();
    setWindowButtons();
    await fetchDevices();
    await fetchHistory();
    await fetchLatest();
    await fetchWeatherToday();

    pollHandle = setInterval(fetchLatest, POLL_MS);
  } catch (err) {
    console.error("Initialisation failed:", err);
    setDeviceSelectState("API unavailable");
    setControlsEnabled(false);
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

setDeviceSelectState("Loading devices...");
initialiseDashboard();
