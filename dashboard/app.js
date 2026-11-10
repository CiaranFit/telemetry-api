const POLL_MS = 30000;
const MAX_HISTORY_POINTS = 480;
const savedApiBase = localStorage.getItem("telemetry-api-base") || "";
let apiBase = savedApiBase || "";

const history = [];
const validWindows = [4, 8, 24];

const storedHours = Number(
  localStorage.getItem("telemetry-window-hours")
);

let selectedHours = validWindows.includes(storedHours)
  ? storedHours
  : 4;
let deviceId = localStorage.getItem("telemetry-device-id") || "";

const deviceSelect = document.getElementById("device-select");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const lastSeen = document.getElementById("last-seen");
const windowButtons = Array.from(document.querySelectorAll(".window-btn"));

let pollHandle = null;
let dashboardMode = "live";
let historyRequestId = 0;

const liveButton = document.getElementById("mode-live");
const historyButton = document.getElementById("mode-history");
const historyPicker = document.getElementById("history-picker");
const historyStats = document.getElementById("history-stats");
const historyLoad = document.getElementById("history-load");
const historyStart = document.getElementById("history-start");
const historyEnd = document.getElementById("history-end");

function createChartOptions() {
  return {
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
    },
    zoom: {
      pan: {
        onPan({ chart }) {
          syncChartZoom(chart);
        },
        enabled: true,
        mode: "x",
        modifierKey: "shift"
      },
      zoom: {
        onZoom({ chart }) {
          syncChartZoom(chart);
        },
        wheel: {
          enabled: true,
          modifierKey: "ctrl"
        },
        pinch: {
          enabled: true
        },
        drag: {
          enabled: true,
          backgroundColor: "rgba(61, 214, 140, 0.08)",
          borderColor: "#3dd68c",
          borderWidth: 1
        },
        mode: "x"
      }
    }
  },
  scales: {
    x: {
      type: "time",
      time: {
        tooltipFormat: "dd MMM yyyy, HH:mm:ss",
        displayFormats: {
          minute: "HH:mm",
          hour: "HH:mm",
          day: "dd MMM"
        }
      },
      grid: {
        color: "#1a1e26"
      },
      ticks: {
        color: "#4a5568",
        maxTicksLimit: 8,
        maxRotation: 0
      },
      border: {
        display: false
      }
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
}

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
    options: createChartOptions()
  });
}

const chartTemp = makeChart("chart-temp", "#e8834a");
const chartHumid = makeChart("chart-humid", "#4ab8e8");

let syncingZoom = false;
let sharedXRange = null;
let historicalXRange = null;

function isValidXRange(range) {
  return range && Number.isFinite(range.min) && Number.isFinite(range.max)
    && range.min < range.max;
}

function getDefaultXRange() {
  if (dashboardMode === "history" && isValidXRange(historicalXRange)) {
    return { ...historicalXRange };
  }

  const end = Date.now();
  return {
    min: end - selectedHours * 3600000,
    max: end
  };
}

function getEffectiveXRange() {
  return isValidXRange(sharedXRange)
    ? { ...sharedXRange }
    : getDefaultXRange();
}

function applyXRange(range) {
  if (!isValidXRange(range)) return;

  syncingZoom = true;
  try {
    for (const chart of [chartTemp, chartHumid]) {
      if (typeof chart.zoomScale === "function") {
        chart.zoomScale("x", range, "none");
      } else if (chart.options?.scales?.x) {
        chart.options.scales.x.min = range.min;
        chart.options.scales.x.max = range.max;
        chart.update("none");
      }
    }
  } finally {
    syncingZoom = false;
  }
}

function syncChartZoom(source) {
  if (syncingZoom || !source.scales?.x) return;

  sharedXRange = {
    min: source.scales.x.min,
    max: source.scales.x.max
  };
  applyXRange(sharedXRange);
}

function resetChartZoomState() {
  sharedXRange = null;

  for (const chart of [chartTemp, chartHumid]) {
    if (typeof chart.resetZoom === "function") {
      chart.resetZoom("none");
    }
    if (chart.options?.scales?.x) {
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
    }
  }
}

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
  // Pico W reports approximately every 15 seconds.
  // Allow sufficient samples for the complete selected window.
  const samplesPerHour = 3600 / 15;

  return Math.min(
    20000,
    Math.ceil(selectedHours * samplesPerHour * 1.25)
  );
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

  chartTemp.data.labels = [];
  chartTemp.data.datasets[0].data = chartPoints.map(p => ({
    x: p.ts.getTime(),
    y: p.temperature
  }));
  setYAxisRange(chartTemp, tempValues, 2);
  chartTemp.update();

  chartHumid.data.labels = [];
  chartHumid.data.datasets[0].data = chartPoints.map(p => ({
    x: p.ts.getTime(),
    y: p.humidity
  }));
  setYAxisRange(chartHumid, humidValues, 5);
  chartHumid.update();
  applyXRange(getEffectiveXRange());

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
  if (dashboardMode !== "live") return;

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
  if (dashboardMode !== "live") return;
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


function localDayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Select valid dates");
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error("Invalid calendar date");
  }

  return date;
}

function chooseBucket(seconds) {
  const buckets = [60, 300, 900, 3600, 86400];
  return buckets.find(bucket =>
    Math.ceil(seconds / bucket) <= 480
  ) ?? 86400;
}

function renderHistoricalCharts(points, start, end) {
  historicalXRange = {
    min: start * 1000,
    max: end * 1000
  };

  const temperatures = points.map(p => p.temperature);
  const humidities = points.map(p => p.humidity);

  const labels = points.map(p =>
    new Date(p.ts * 1000).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    })
  );

  chartTemp.data.labels = [];
  chartTemp.data.datasets[0].data = points.map(p => ({
    x: p.ts * 1000,
    y: p.temperature
  }));

  chartHumid.data.labels = [];
  chartHumid.data.datasets[0].data = points.map(p => ({
    x: p.ts * 1000,
    y: p.humidity
  }));

  setYAxisRange(chartTemp, temperatures, 2);
  chartTemp.update();

  setYAxisRange(chartHumid, humidities, 5);
  chartHumid.update();
  applyXRange(getEffectiveXRange());

  document.getElementById("nd-temp").style.display =
    points.length ? "none" : "flex";
  document.getElementById("nd-humid").style.display =
    points.length ? "none" : "flex";

  const meta = `${points.length} intervals`;

  document.getElementById("chart-t-meta").textContent = meta;
  document.getElementById("chart-h-meta").textContent = meta;

  document.getElementById("chart-t-title").textContent =
    "Temperature / historical";

  document.getElementById("chart-h-title").textContent =
    "Humidity / historical";

  const totalSamples = points.reduce(
    (sum, p) => sum + p.samples, 0
  );

  const weightedAverage = key =>
    totalSamples
      ? points.reduce(
          (sum, p) => sum + p[key] * p.samples, 0
        ) / totalSamples
      : null;

  const avgTemp = weightedAverage("temperature");
  const avgHumid = weightedAverage("humidity");

  const minTemp = points.length
    ? Math.min(...points.map(p => p.temp_min))
    : null;

  const maxTemp = points.length
    ? Math.max(...points.map(p => p.temp_max))
    : null;

  document.getElementById("history-temp-avg").textContent =
    avgTemp === null ? "--" : `${avgTemp.toFixed(1)}°C`;

  document.getElementById("history-temp-range").textContent =
    minTemp === null
      ? "--"
      : `${minTemp.toFixed(1)}–${maxTemp.toFixed(1)}°C`;

  document.getElementById("history-humid-avg").textContent =
    avgHumid === null ? "--" : `${avgHumid.toFixed(1)}%`;
}

function resetAllZoom() {
  resetChartZoomState();
  for (const chart of [chartTemp, chartHumid]) {
    chart.update("none");
  }
  applyXRange(getDefaultXRange());
}

async function loadHistoricalData() {
  if (!deviceId) {
    setStatus("err", "ERROR", "No device selected");
    return;
  }

  const requestId = ++historyRequestId;
  resetChartZoomState();
  historicalXRange = null;
  historyLoad.disabled = true;

  try {
    const startDate = localDayStart(historyStart.value);
    const endDate = localDayStart(historyEnd.value);

    // End date is inclusive for the user.
    const exclusiveEnd = new Date(endDate);
    exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);

    const start = Math.floor(startDate.getTime() / 1000);
    const end = Math.floor(exclusiveEnd.getTime() / 1000);
    const seconds = end - start;

    if (seconds <= 0 || seconds > 90 * 86400) {
      throw new Error("Select a range of 1–90 days");
    }

    const bucket = chooseBucket(seconds);

    setStatus("init", "LOADING", "historical data");

    const params = new URLSearchParams({
      device_id: deviceId,
      start: String(start),
      end: String(end),
      bucket: String(bucket)
    });

    const data = await fetchJson(
      `${apiBase}/api/history?${params}`
    );

    if (
      dashboardMode !== "history" ||
      requestId !== historyRequestId
    ) return;

    renderHistoricalCharts(data.history, start, end);
    setStatus(
      "ok",
      "HISTORY",
      `${data.history.length} intervals loaded`
    );

  } catch (err) {
    if (
      dashboardMode === "history" &&
      requestId === historyRequestId
    ) {
      setStatus("err", "ERROR", err.message);
    }
  } finally {
    historyLoad.disabled = false;
  }
}

function setDashboardMode(mode) {
  dashboardMode = mode;
  historyRequestId++;
  historicalXRange = null;
  resetChartZoomState();

  const historical = mode === "history";

  liveButton.classList.toggle("active", !historical);
  historyButton.classList.toggle("active", historical);

  historyPicker.hidden = !historical;
  historyStats.hidden = !historical;

  for (const btn of windowButtons) {
    btn.disabled = historical;
  }

  if (historical) {
    loadHistoricalData();
  } else {
    setWindowButtons();
    fetchHistory().then(() => fetchLatest()).catch(err => {
      setStatus("err", "ERROR", err.message);
    });
  }
}

liveButton.addEventListener("click", () => {
  if (dashboardMode !== "live") {
    setDashboardMode("live");
  }
});

historyButton.addEventListener("click", () => {
  if (dashboardMode !== "history") {
    setDashboardMode("history");
  }
});

historyLoad.addEventListener("click", loadHistoricalData);

const today = new Date();
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

historyStart.value = dateInputValue(yesterday);
historyEnd.value = dateInputValue(today);



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

    pollHandle = setInterval(() => {
      if (dashboardMode === "live") fetchLatest();
    }, POLL_MS);

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
  historicalXRange = null;
  resetChartZoomState();
  history.length = 0;
  updateCharts();
  await initialiseDashboard();
});

for (const btn of windowButtons) {
  btn.addEventListener("click", async () => {
    const hours = Number(btn.dataset.hours);

    if (!validWindows.includes(hours)) return;
    if (dashboardMode !== "live") return;

    selectedHours = hours;
    localStorage.setItem("telemetry-window-hours", String(selectedHours));
    resetChartZoomState();
    history.length = 0;
    setWindowButtons();
    updateCharts();
    await fetchHistory();
    await fetchLatest();
  });
}

// Reset graph zoom buttons
document.getElementById("reset-temp-zoom")
  ?.addEventListener("click", resetAllZoom);

document.getElementById("reset-humid-zoom")
  ?.addEventListener("click", resetAllZoom);

// Start the dashboard
setDeviceSelectState("Loading devices...");
initialiseDashboard();
