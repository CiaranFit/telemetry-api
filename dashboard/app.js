const POLL_MS = 30000;
const MAX_HISTORY_POINTS = 480;
const savedApiBase = localStorage.getItem("telemetry-api-base") || "";
let apiBase = savedApiBase || "";

const history = [];
const validWindows = [4, 8, 24];
const HISTORY_WINDOW_DAYS = 7;
const HISTORY_WINDOW_OFFSET_DAYS = HISTORY_WINDOW_DAYS - 1;
const MIN_ZOOM_RANGE_MS = 15 * 60 * 1000;

const storedHours = Number(
  localStorage.getItem("telemetry-window-hours")
);

let selectedHours = validWindows.includes(storedHours)
  ? storedHours
  : 4;
// The Overview is always Livingroom; other pages use fixed device IDs.
const ROOM_PAGES = {
  "overview": { label: "Living room", deviceId: "Livingroom" },
  "bedroom": { label: "Bedroom", deviceId: "Bedroom" },
  "kitchen": { label: "Kitchen", deviceId: "Kitchen" },
  "hallway": { label: "Hallway", deviceId: "Hallway" },
  "bathroom": { label: "Bathroom", deviceId: "Bathroom" },
  "spare-room": { label: "Spare room", deviceId: "Spare_Room" },
  "floorplan": { label: "Floorplan", deviceId: null }
};
const ROOM_KEYS = Object.keys(ROOM_PAGES).filter(key => key !== "floorplan");
const STALE_MS = 120000;
const storedFloorplanMetric = localStorage.getItem("telemetry-floorplan-metric");
let floorplanMetric = storedFloorplanMetric === "humidity" ? "humidity" : "temperature";
const floorplanReadings = new Map();
const floorplanMetricButtons = Array.from(
  document.querySelectorAll(".floorplan-metric-btn")
);
const queryPage = new URLSearchParams(window.location.search).get("room");
let currentPage = Object.prototype.hasOwnProperty.call(ROOM_PAGES, queryPage) ? queryPage : "overview";
let deviceId = ROOM_PAGES[currentPage].deviceId;
let knownDevices = new Set();
let navigationToken = 0;
let pollTick = 0;
let polling = false;
const navLinks = Array.from(document.querySelectorAll("#room-nav a[data-page]"));
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const lastSeen = document.getElementById("last-seen");
const windowButtons = Array.from(
  document.querySelectorAll(".window-btn[data-hours]")
);

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
      limits: {
        x: {
          minRange: MIN_ZOOM_RANGE_MS
        }
      },
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
const chartEco2 = makeChart("chart-eco2", "#3dd68c");
const chartTvoc = makeChart("chart-tvoc", "#b399f8");
const allCharts = [chartTemp, chartHumid, chartEco2, chartTvoc];

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
    for (const chart of allCharts) {
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

  const nextRange = {
    min: source.scales.x.min,
    max: source.scales.x.max
  };

  if (!isValidXRange(nextRange)) return;

  const hasVisiblePoint = source.data?.datasets?.some(dataset =>
    dataset.data?.some(point => {
      const timestamp = typeof point === "object" ? point.x : NaN;
      return Number.isFinite(timestamp) &&
        timestamp >= nextRange.min && timestamp <= nextRange.max;
    })
  );

  if (source.data?.datasets?.length && !hasVisiblePoint) {
    applyXRange(getEffectiveXRange());
    return;
  }

  sharedXRange = nextRange;
  applyXRange(sharedXRange);
}

function resetChartZoomState() {
  sharedXRange = null;

  for (const chart of allCharts) {
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
  for (const btn of windowButtons) {
    btn.disabled = !enabled || dashboardMode === "history";
  }
  liveButton.disabled = !enabled;
  historyButton.disabled = !enabled;
  historyLoad.disabled = !enabled;
}

function setWindowButtons() {
  for (const btn of windowButtons) {
    btn.classList.toggle("active", Number(btn.dataset.hours) === selectedHours);
  }

  document.getElementById("chart-t-title").textContent = `Temperature / ${selectedHours}hr window`;
  document.getElementById("chart-h-title").textContent = `Humidity / ${selectedHours}hr window`;
  document.getElementById("chart-eco2-title").textContent = `eCO₂ / ${selectedHours}hr window`;
  document.getElementById("chart-tvoc-title").textContent = `TVOC / ${selectedHours}hr window`;
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

function iconForWeatherCode(code) {
  if (code === 0) return ["☀️", "Clear"];
  if ([1, 2].includes(code)) return ["🌤️", "Partly cloudy"];
  if (code === 3) return ["☁️", "Cloudy"];
  if ([45, 48].includes(code)) return ["🌫️", "Fog"];
  if ([51, 53, 55, 56, 57].includes(code)) return ["🌦️", "Drizzle"];
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ["🌧️", "Rain"];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ["🌨️", "Snow"];
  if ([95, 96, 99].includes(code)) return ["⛈️", "Thunderstorm"];
  return ["☁️", "Forecast"];
}

function renderHourlyWeather(hours) {
  const container = document.getElementById("weather-hours");
  const status = document.getElementById("forecast-status");
  container.replaceChildren();

  if (!Array.isArray(hours) || hours.length === 0) {
    status.textContent = "Forecast unavailable";
    container.textContent = "Hourly forecast unavailable";
    return;
  }

  status.textContent = "Next seven hours · local time";
  for (const hour of hours) {
    const card = document.createElement("div");
    card.className = "weather-hour";
    const time = document.createElement("span");
    time.className = "weather-hour-time";
    // Timestamps from the weather API are already expressed in local time.
    const hourNumber = Number(String(hour.time).slice(11, 13));
    time.textContent = Number.isInteger(hourNumber) && hourNumber >= 0 && hourNumber <= 23
      ? `${hourNumber % 12 || 12}${hourNumber < 12 ? "am" : "pm"}`
      : "—";
    const icon = document.createElement("span");
    icon.className = "weather-hour-icon";
    const [symbol, description] = iconForWeatherCode(hour.weather_code);
    icon.textContent = symbol;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", description);
    const temperature = document.createElement("span");
    temperature.className = "weather-hour-temp";
    temperature.textContent = hour.temperature == null ? "—" : `${Math.round(Number(hour.temperature))}°`;
    const precip = document.createElement("span");
    precip.className = "weather-hour-rain";
    precip.textContent = hour.precip_chance == null
      ? "—"
      : `${Math.round(Number(hour.precip_chance))}% rain`;
    card.append(time, icon, temperature, precip);
    container.appendChild(card);
  }
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
    humidity: humid,
    eco2: row.eco2 == null ? null : Number(row.eco2),
    tvoc: row.tvoc == null ? null : Number(row.tvoc)
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

function updateGasTile(valId, subId, value, unit) {
  const val = document.getElementById(valId);
  const sub = document.getElementById(subId);
  if (!Number.isFinite(value)) {
    val.innerHTML = `--<span class="tile-unit">${unit}</span>`;
    sub.textContent = "NO GAS SENSOR DATA";
    return;
  }
  val.innerHTML = `${Math.round(value)}<span class="tile-unit">${unit}</span>`;
  sub.textContent = "SGP30 ESTIMATE";
}

function updateCurrentTiles(point) {
  updateTile("val-temp", "sub-temp", point.temperature, "°C", 18, 25, "temp");
  updateTile("val-humid", "sub-humid", point.humidity, "%", 40, 60, "humid");
  updateGasTile("val-eco2", "sub-eco2", point.eco2, "ppm");
  updateGasTile("val-tvoc", "sub-tvoc", point.tvoc, "ppb");
}

function resetTiles(label = "Awaiting readings") {
  for (const [id, sub, unit] of [
    ["val-temp", "sub-temp", "°C"],
    ["val-humid", "sub-humid", "%"],
    ["val-eco2", "sub-eco2", "ppm"],
    ["val-tvoc", "sub-tvoc", "ppb"]
  ]) {
    const value = document.getElementById(id);
    value.innerHTML = `--<span class="tile-unit">${unit}</span>`;
    value.style.color = "";
    document.getElementById(sub).textContent = label;
  }
}

const chartSpecs = [
  { chart: chartTemp, key: "temperature", padding: 2, emptyId: "nd-temp", metaId: "chart-t-meta" },
  { chart: chartHumid, key: "humidity", padding: 5, emptyId: "nd-humid", metaId: "chart-h-meta" },
  { chart: chartEco2, key: "eco2", padding: 80, emptyId: "nd-eco2", metaId: "chart-eco2-meta" },
  { chart: chartTvoc, key: "tvoc", padding: 15, emptyId: "nd-tvoc", metaId: "chart-tvoc-meta" }
];

function renderChartSeries(points, meta) {
  for (const spec of chartSpecs) {
    const values = points.filter(p => Number.isFinite(p[spec.key]));
    spec.chart.data.labels = [];
    spec.chart.data.datasets[0].data = values.map(p => ({
      x: p.ts instanceof Date ? p.ts.getTime() : p.ts * 1000,
      y: p[spec.key]
    }));
    setYAxisRange(spec.chart, values.map(p => p[spec.key]), spec.padding);
    spec.chart.update();
    const overlay = document.getElementById(spec.emptyId);
    overlay.style.display = values.length > 0 ? "none" : "flex";
    overlay.textContent = points.length ? "NO DATA FOR THIS METRIC" : "NO DATA FOR THIS ROOM";
    document.getElementById(spec.metaId).textContent = meta;
  }
  applyXRange(getEffectiveXRange());
}

function updateCharts() {
  const points = downsamplePoints(history, MAX_HISTORY_POINTS);
  let meta = "collecting…";
  if (history.length > 1) {
    const first = history[0].ts;
    const last = history[history.length - 1].ts;
    meta = `${formatChartLabel(first)} → ${formatChartLabel(last)} · ${history.length} pts`;
  } else if (history.length === 1) {
    meta = `${formatChartLabel(history[0].ts)} · 1 pt`;
  }
  renderChartSeries(points, meta);
}

async function fetchDevices() {
  const data = await fetchJson(`${apiBase}/devices`);
  knownDevices = new Set(Array.isArray(data.devices) ? data.devices : []);
  return knownDevices;
}

async function fetchHistory() {
  if (dashboardMode !== "live" || !deviceId || !knownDevices.has(deviceId)) return;

  const requestedDevice = deviceId;
  const token = navigationToken;
  setStatus("init", "LOADING", `${selectedHours}hr history`);

  const minutes = selectedHours * 60;
  const limit = getHistoryLimit();
  const url = `${apiBase}/history?device_id=${encodeURIComponent(requestedDevice)}&minutes=${minutes}&limit=${limit}&mode=time`;
  const data = await fetchJson(url);
  if (token !== navigationToken || requestedDevice !== deviceId || dashboardMode !== "live") return;

  history.length = 0;
  for (const row of Array.isArray(data.history) ? data.history : []) {
    const point = normaliseRecord(row);
    if (point) history.push(point);
  }
  sortHistory();
  dedupeHistory();
  trimHistoryWindow();
  updateCharts();

  if (history.length) {
    const latest = history[history.length - 1];
    updateCurrentTiles(latest);
    updateLatestStatus(latest.ts);
  } else {
    setStatus("init", "NO DATA", "Awaiting first sensor reading");
  }
}

function updateLatestStatus(ts) {
  const timestamp = ts instanceof Date ? ts : parseTimestamp(ts);
  if (Date.now() - timestamp.getTime() > STALE_MS) {
    setStatus("stale", "STALE", `Last update ${formatStatusTimestamp(timestamp)}`);
  } else {
    setStatus("ok", "LIVE", formatStatusTimestamp(timestamp));
  }
}

async function fetchLatest() {
  if (dashboardMode !== "live" || !deviceId || !knownDevices.has(deviceId)) return;
  const requestedDevice = deviceId;
  const token = navigationToken;
  try {
    const data = await fetchJson(
      `${apiBase}/latest?device_id=${encodeURIComponent(requestedDevice)}`
    );
    if (token !== navigationToken || requestedDevice !== deviceId || dashboardMode !== "live") return;
    const point = normaliseRecord(data);
    if (!point) throw new Error("Latest reading is incomplete");
    updateCurrentTiles(point);
    addOrReplacePoint(point);
    updateCharts();
    updateLatestStatus(point.ts);
  } catch (err) {
    if (token !== navigationToken || requestedDevice !== deviceId) return;
    console.error("Fetch latest failed:", err);
    setStatus("err", "ERROR", err.message);
  }
}

async function fetchWeatherToday() {
  try {
    const data = await fetchJson(`${apiBase}/weather/today`);
    renderHourlyWeather(data.hours);
  } catch (err) {
    console.error("Weather fetch failed:", err);
    renderHourlyWeather(null);
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

function shiftLocalCalendarDate(value, days) {
  const date = localDayStart(value);
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
}

function syncHistoricalDateRange(changedInput) {
  if (!changedInput.value) return;

  if (changedInput === historyStart) {
    historyEnd.value = shiftLocalCalendarDate(
      historyStart.value,
      HISTORY_WINDOW_OFFSET_DAYS
    );
  } else if (changedInput === historyEnd) {
    historyStart.value = shiftLocalCalendarDate(
      historyEnd.value,
      -HISTORY_WINDOW_OFFSET_DAYS
    );
  }
}

function renderHistoricalCharts(points, start, end) {
  historicalXRange = { min: start * 1000, max: end * 1000 };
  renderChartSeries(points, `${points.length} intervals`);
  for (const [id, label] of [
    ["chart-t-title", "Temperature"], ["chart-h-title", "Humidity"],
    ["chart-eco2-title", "eCO₂"], ["chart-tvoc-title", "TVOC"]
  ]) {
    document.getElementById(id).textContent = `${label} / historical`;
  }

  const totalSamples = points.reduce((sum, p) => sum + p.samples, 0);
  const weightedAverage = key => totalSamples
    ? points.reduce((sum, p) => sum + p[key] * p.samples, 0) / totalSamples
    : null;
  const avgTemp = weightedAverage("temperature");
  const avgHumid = weightedAverage("humidity");
  const minTemp = points.length ? Math.min(...points.map(p => p.temp_min)) : null;
  const maxTemp = points.length ? Math.max(...points.map(p => p.temp_max)) : null;

  document.getElementById("history-temp-avg").textContent =
    avgTemp === null ? "--" : `${avgTemp.toFixed(1)}°C`;
  document.getElementById("history-temp-range").textContent =
    minTemp === null ? "--" : `${minTemp.toFixed(1)}–${maxTemp.toFixed(1)}°C`;
  document.getElementById("history-humid-avg").textContent =
    avgHumid === null ? "--" : `${avgHumid.toFixed(1)}%`;
}

function resetAllZoom() {
  resetChartZoomState();
  for (const chart of allCharts) {
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
  const token = navigationToken;
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
      requestId !== historyRequestId ||
      token !== navigationToken
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
      requestId === historyRequestId &&
      token === navigationToken
    ) {
      setStatus("err", "ERROR", err.message);
    }
  } finally {
    // Don't re-enable a stale page's controls after navigating elsewhere.
    if (token === navigationToken && dashboardMode === "history") {
      historyLoad.disabled = false;
    }
  }
}

function setDashboardMode(mode) {
  if (!deviceId || !knownDevices.has(deviceId)) return;
  dashboardMode = mode;
  historyRequestId++;
  historicalXRange = null;
  resetChartZoomState();
  const historical = mode === "history";
  liveButton.classList.toggle("active", !historical);
  historyButton.classList.toggle("active", historical);
  historyPicker.hidden = !historical;
  historyStats.hidden = !historical;
  setControlsEnabled(true);

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
const initialStart = new Date(today);
initialStart.setDate(initialStart.getDate() - HISTORY_WINDOW_OFFSET_DAYS);

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

historyStart.value = dateInputValue(initialStart);
historyEnd.value = dateInputValue(today);

historyStart.addEventListener("change", () => {
  syncHistoricalDateRange(historyStart);
});

historyEnd.addEventListener("change", () => {
  syncHistoricalDateRange(historyEnd);
});



function interpolateFloorplanColour(value, stops) {
  const clamped = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], value));
  const index = Math.max(0, stops.findIndex((stop, i) =>
    i < stops.length - 1 && clamped <= stops[i + 1][0]
  ));
  const a = stops[Math.min(index, stops.length - 2)];
  const b = stops[Math.min(index + 1, stops.length - 1)];
  const fraction = (clamped - a[0]) / (b[0] - a[0]);
  const rgb = a[1].map((channel, i) =>
    Math.round(channel + (b[1][i] - channel) * fraction)
  );
  return `rgb(${rgb.join(",")})`;
}

function temperatureColour(temp) {
  return interpolateFloorplanColour(temp, [
    [16, [35, 91, 146]], [18, [53, 119, 155]],
    [20, [42, 129, 104]], [22, [165, 107, 57]], [24, [169, 71, 71]]
  ]);
}

function humidityColour(humidity) {
  // Blue: dry. Green: around 50% RH. Red: humid.
  return interpolateFloorplanColour(humidity, [
    [30, [35, 91, 146]], [40, [53, 119, 155]],
    [50, [42, 129, 104]], [60, [165, 107, 57]], [70, [169, 71, 71]]
  ]);
}

function updateFloorplanRoom(key, point) {
  const group = document.querySelector(`#home-floorplan .map-room[data-page="${key}"]`);
  if (!group) return false;
  const shape = group.querySelector(".room-shape");
  const reading = group.querySelector(".room-reading");
  const value = point?.[floorplanMetric];
  const timestamp = point?.ts;
  const elapsedMs = Date.now() - timestamp * 1000;
  const valid = typeof value === "number" && Number.isFinite(value)
    && typeof timestamp === "number" && Number.isFinite(timestamp)
    && elapsedMs >= -30000 && elapsedMs <= STALE_MS;

  shape.style.fill = valid
    ? (floorplanMetric === "temperature" ? temperatureColour(value) : humidityColour(value))
    : "#283038";
  reading.textContent = valid
    ? (floorplanMetric === "temperature" ? `${value.toFixed(1)}°C` : `${value.toFixed(1)}%`)
    : "—";
  const label = valid
    ? (floorplanMetric === "temperature"
      ? `${value.toFixed(1)} degrees Celsius`
      : `${value.toFixed(1)} percent relative humidity`)
    : "reading unavailable or stale";
  group.setAttribute("aria-label", `Open ${ROOM_PAGES[key].label}, ${label}`);
  return valid;
}

function renderFloorplan() {
  const isHumidity = floorplanMetric === "humidity";
  for (const button of floorplanMetricButtons) {
    const active = button.dataset.metric === floorplanMetric;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  document.getElementById("floorplan-heading").textContent =
    isHumidity ? "ROOM HUMIDITY" : "ROOM TEMPERATURES";
  document.getElementById("floorplan-description").textContent =
    isHumidity
      ? "Relative humidity · Around 40–60% RH is a useful indoor reference · Select a room for its history"
      : "Colours relative to 20°C · Select a room for its history";
  const legend = document.getElementById("floorplan-legend");
  legend.setAttribute("aria-label", isHumidity
    ? "Relative humidity colour scale, 30 to 70 percent"
    : "Temperature colour scale, 16 to 24 degrees Celsius");
  document.getElementById("legend-low").textContent =
    isHumidity ? "30% · Dry" : "16°C · Cool";
  document.getElementById("legend-mid").textContent =
    isHumidity ? "50% · Comfortable" : "20°C · Ideal";
  document.getElementById("legend-high").textContent =
    isHumidity ? "70% · Humid" : "24°C · Warm";
  document.getElementById("floorplan-scale").classList.toggle("humidity-scale", isHumidity);

  let active = 0;
  for (const key of ROOM_KEYS) {
    if (updateFloorplanRoom(key, floorplanReadings.get(key))) active++;
  }
  const message = `${active} of ${ROOM_KEYS.length} rooms reporting`;
  document.getElementById("floorplan-status").textContent = message;
  if (currentPage === "floorplan") setStatus("ok", "FLOORPLAN", message);
}

for (const button of floorplanMetricButtons) {
  button.addEventListener("click", () => {
    const metric = button.dataset.metric;
    if (metric !== "temperature" && metric !== "humidity") return;
    floorplanMetric = metric;
    localStorage.setItem("telemetry-floorplan-metric", metric);
    renderFloorplan(); // Recolour immediately using cached readings, no network request.
  });
}

async function refreshFloorplan() {
  const token = navigationToken;
  const responses = await Promise.all(ROOM_KEYS.map(async key => {
    const id = ROOM_PAGES[key].deviceId;
    if (!knownDevices.has(id)) return [key, null];
    try {
      const result = await fetchJson(`${apiBase}/latest?device_id=${encodeURIComponent(id)}`);
      return [key, result];
    } catch (error) {
      console.warn("Room reading unavailable:", id, error);
      return [key, null];
    }
  }));
  if (token !== navigationToken || currentPage !== "floorplan") return;
  for (const [key, point] of responses) floorplanReadings.set(key, point);
  renderFloorplan();
}

function clearRoomView(message) {
  history.length = 0;
  resetChartZoomState();
  resetTiles(message);
  updateCharts();
}

async function loadSelectedPage(token) {
  await fetchDevices();
  if (token !== navigationToken) return;

  if (currentPage === "floorplan") {
    await refreshFloorplan();
    return;
  }

  // Weather belongs to the Overview, independently of sensor availability.
  if (currentPage === "overview") fetchWeatherToday();

  if (!knownDevices.has(deviceId)) {
    setControlsEnabled(false);
    clearRoomView("Sensor not installed");
    setStatus("init", "NO SENSOR", "No readings for this room");
    return;
  }

  setControlsEnabled(true);
  if (dashboardMode === "history") {
    await loadHistoricalData();
  } else {
    await fetchHistory();
    await fetchLatest();
  }
}

async function navigateTo(page, { push = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ROOM_PAGES, page)) page = "overview";
  const token = ++navigationToken;
  historyRequestId++;
  currentPage = page;
  deviceId = ROOM_PAGES[page].deviceId;
  dashboardMode = "live";
  historicalXRange = null;
  document.getElementById("sensor-content").hidden = page === "floorplan";
  document.getElementById("floorplan-content").hidden = page !== "floorplan";
  document.getElementById("weather-section").hidden = page !== "overview";
  if (page === "floorplan") renderFloorplan();
  document.getElementById("page-title").textContent =
    page === "overview" ? "Living room · Overview" : ROOM_PAGES[page].label;
  document.getElementById("page-subtitle").textContent =
    page === "overview" ? "Primary sensor · Livingroom" : `Room sensor · ${deviceId || ""}`;
  for (const link of navLinks) {
    const active = link.dataset.page === page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (push) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", page);
    window.history.pushState({}, "", url);
  }
  liveButton.classList.add("active");
  historyButton.classList.remove("active");
  historyPicker.hidden = true;
  historyStats.hidden = true;
  setWindowButtons();
  clearRoomView("Awaiting readings");
  setStatus("init", "LOADING", ROOM_PAGES[page].label);

  if (!apiBase) return;
  try {
    await loadSelectedPage(token);
  } catch (err) {
    if (token !== navigationToken) return;
    console.error("Page load failed:", err);
    setStatus("err", "ERROR", err.message);
  }
}

for (const link of navLinks) {
  link.addEventListener("click", event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateTo(link.dataset.page, { push: true });
  });
}
for (const group of document.querySelectorAll("#home-floorplan .map-room")) {
  const visit = () => navigateTo(group.dataset.page, { push: true });
  group.addEventListener("click", visit);
  group.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      visit();
    }
  });
}
window.addEventListener("popstate", () => {
  const query = new URLSearchParams(window.location.search).get("room");
  navigateTo(query, { push: false });
});

async function initialiseDashboard() {
  try {
    setStatus("init", "CONNECTING", "probing API");
    await resolveApiBase();
    await navigateTo(currentPage);
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      if (polling) return;
      polling = true;
      const token = navigationToken;
      try {
        const hadDevice = knownDevices.has(deviceId);
        if (currentPage === "floorplan" || !hadDevice || ++pollTick % 4 === 0) {
          await fetchDevices();
          if (token !== navigationToken) return;
        }
        if (currentPage === "floorplan") {
          await refreshFloorplan();
        } else if (!hadDevice && knownDevices.has(deviceId)) {
          await loadSelectedPage(token);
        } else if (dashboardMode === "live") {
          await fetchLatest();
        }
      } catch (error) {
        if (token === navigationToken) console.error("Polling failed", error);
      } finally {
        polling = false;
      }
    }, POLL_MS);
  } catch (err) {
    console.error("Initialisation failed:", err);
    setControlsEnabled(false);
    setStatus("err", "ERROR", err.message);
  }
}

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
document.getElementById("reset-eco2-zoom")
  ?.addEventListener("click", resetAllZoom);
document.getElementById("reset-tvoc-zoom")
  ?.addEventListener("click", resetAllZoom);

// Start the dashboard
initialiseDashboard();
