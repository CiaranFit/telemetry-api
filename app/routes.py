import logging
import time
from pathlib import Path
from flask import request, jsonify, send_from_directory, redirect
from urllib.parse import urlencode
from urllib.request import urlopen
from .storage import save_metric, get_latest, list_devices, get_history, get_latest_points
from .config import Config

logger = logging.getLogger("telemetry")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PROJECT_ROOT / "dashboard"


def fetch_weather_today():
    if not Config.WEATHER_LAT or not Config.WEATHER_LON:
        raise ValueError("WEATHER_LAT and WEATHER_LON must be configured")

    params = urlencode({
        "latitude": Config.WEATHER_LAT,
        "longitude": Config.WEATHER_LON,
        "timezone": Config.WEATHER_TIMEZONE,
        "current": "temperature_2m,weather_code",
        "daily": "temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code",
        "forecast_days": 1,
    })
    url = f"https://api.open-meteo.com/v1/forecast?{params}"

    with urlopen(url, timeout=5) as response:
        payload = response.read().decode("utf-8")

    import json
    data = json.loads(payload)

    daily = data.get("daily", {})
    current = data.get("current", {})
    codes = daily.get("weather_code") or [current.get("weather_code")]
    code = codes[0] if codes else None

    weather_labels = {
        0: "Clear",
        1: "Mainly clear",
        2: "Partly cloudy",
        3: "Overcast",
        45: "Fog",
        48: "Depositing rime fog",
        51: "Light drizzle",
        53: "Moderate drizzle",
        55: "Dense drizzle",
        56: "Light freezing drizzle",
        57: "Dense freezing drizzle",
        61: "Slight rain",
        63: "Moderate rain",
        65: "Heavy rain",
        66: "Light freezing rain",
        67: "Heavy freezing rain",
        71: "Slight snow",
        73: "Moderate snow",
        75: "Heavy snow",
        77: "Snow grains",
        80: "Slight rain showers",
        81: "Moderate rain showers",
        82: "Violent rain showers",
        85: "Slight snow showers",
        86: "Heavy snow showers",
        95: "Thunderstorm",
        96: "Thunderstorm hail",
        99: "Heavy thunderstorm hail",
    }

    return {
        "temperature": current.get("temperature_2m"),
        "temp_min": (daily.get("temperature_2m_min") or [None])[0],
        "temp_max": (daily.get("temperature_2m_max") or [None])[0],
        "precip_chance": (daily.get("precipitation_probability_max") or [None])[0],
        "condition": weather_labels.get(code, "Unknown"),
    }


def register_routes(app):

    @app.route("/", methods=["GET"])
    def dashboard_index():
        return redirect("/dashboard/")

    @app.route("/dashboard", methods=["GET"])
    def dashboard_root_redirect():
        return redirect("/dashboard/")

    @app.route("/dashboard/", methods=["GET"])
    def dashboard_root():
        return send_from_directory(DASHBOARD_DIR, "index.html")

    @app.route("/dashboard/<path:filename>", methods=["GET"])
    def dashboard_assets(filename):
        return send_from_directory(DASHBOARD_DIR, filename)

    @app.route("/health", methods=["GET"])
    def health():
        return {"status": "healthy"}, 200

    @app.route("/metrics", methods=["POST"])
    def metrics():
        start = time.time()

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            logger.warning(
                "metric_rejected",
                extra={"fields": {
                    "event": "metric_rejected",
                    "reason": "invalid_json",
                    "remote_addr": request.remote_addr,
                    "user_agent": request.headers.get("User-Agent"),
                    "path": request.path,
                    "method": request.method,
                }},
            )
            return {"error": "invalid payload"}, 400

        required = ("device_id", "temperature", "humidity")
        missing = [k for k in required if k not in data]
        if missing:
            logger.warning(
                "metric_rejected",
                extra={"fields": {
                    "event": "metric_rejected",
                    "reason": "missing_fields",
                    "missing": missing,
                    "remote_addr": request.remote_addr,
                    "user_agent": request.headers.get("User-Agent"),
                }},
            )
            return {"error": "missing fields", "fields": missing}, 400

        try:
            payload = {
                "device_id": str(data["device_id"]).strip(),
                "temperature": float(data["temperature"]),
                "humidity": float(data["humidity"]),
                "ts": int(time.time()),
            }
        except (TypeError, ValueError):
            logger.warning(
                "metric_rejected",
                extra={"fields": {
                    "event": "metric_rejected",
                    "reason": "invalid_field_types",
                    "remote_addr": request.remote_addr,
                }},
            )
            return {"error": "invalid field types"}, 400

        if not payload["device_id"]:
            logger.warning(
                "metric_rejected",
                extra={"fields": {
                    "event": "metric_rejected",
                    "reason": "empty_device_id",
                    "remote_addr": request.remote_addr,
                }},
            )
            return {"error": "device_id must not be empty"}, 400

        try:
            save_metric(payload)
        except Exception:
            logger.exception(
                "metric_db_write_failed",
                extra={"fields": {
                    "event": "metric_db_write_failed",
                    "device_id": payload.get("device_id"),
                    "remote_addr": request.remote_addr,
                }},
            )
            return {"error": "server_error"}, 500

        latency_ms = int((time.time() - start) * 1000)
        logger.info(
            "metric_ingested",
            extra={"fields": {
                "event": "metric_ingested",
                "device_id": payload["device_id"],
                "temperature": payload["temperature"],
                "humidity": payload["humidity"],
                "ts_unix": payload["ts"],
                "remote_addr": request.remote_addr,
                "latency_ms": latency_ms,
            }},
        )

        return {"status": "ok"}, 200

    @app.route("/latest", methods=["GET"])
    def latest():
        device_id = request.args.get("device_id", "").strip()
        if not device_id:
            logger.warning(
                "latest_rejected",
                extra={"fields": {
                    "event": "latest_rejected",
                    "reason": "missing_device_id",
                    "remote_addr": request.remote_addr,
                }},
            )
            return {"error": "device_id required"}, 400

        result = get_latest(device_id)
        if not result:
            logger.info(
                "latest_not_found",
                extra={"fields": {
                    "event": "latest_not_found",
                    "device_id": device_id,
                    "remote_addr": request.remote_addr,
                }},
            )
            return {"error": "not found"}, 404

        logger.info(
            "latest_served",
            extra={"fields": {
                "event": "latest_served",
                "device_id": device_id,
                "remote_addr": request.remote_addr,
            }},
        )
        return jsonify(result), 200

    @app.route("/devices", methods=["GET"])
    def devices():
        return jsonify({"devices": list_devices()}), 200

    @app.route("/weather/today", methods=["GET"])
    def weather_today():
        try:
            return jsonify(fetch_weather_today()), 200
        except ValueError as err:
            return {"error": str(err)}, 503
        except Exception:
            logger.exception("weather_fetch_failed")
            return {"error": "weather unavailable"}, 502

    @app.route("/history", methods=["GET"])
    def history():
        device_id = request.args.get("device_id", "").strip()
        minutes_raw = request.args.get("minutes", "60")
        limit_raw = request.args.get("limit", "2000")
        mode = request.args.get("mode", "time").strip().lower()

        if not device_id:
            return {"error": "device_id required"}, 400

        try:
            minutes = int(minutes_raw)
            limit = int(limit_raw)
        except ValueError:
            return {"error": "minutes and limit must be integers"}, 400

        if limit < 10 or limit > 20000:
            return {"error": "limit must be between 10 and 20000"}, 400

        if mode == "latest":
            points = get_latest_points(device_id, limit=limit)
            return jsonify({
                "device_id": device_id,
                "mode": "latest",
                "history": points,
            }), 200

        if mode != "time":
            return {"error": "mode must be 'time' or 'latest'"}, 400

        if minutes < 1 or minutes > 1440:
            return {"error": "minutes must be between 1 and 1440"}, 400

        since_ts = int(time.time()) - (minutes * 60)
        points = get_history(device_id, since_ts, limit=limit)

        return jsonify({
            "device_id": device_id,
            "mode": "time",
            "since_ts": since_ts,
            "history": points,
        }), 200
