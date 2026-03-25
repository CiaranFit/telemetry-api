import logging
import time
from pathlib import Path
from flask import request, jsonify, send_from_directory
from .storage import save_metric, get_latest, list_devices, get_history, get_latest_points

logger = logging.getLogger("telemetry")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PROJECT_ROOT / "dashboard"


def register_routes(app):

    @app.route("/", methods=["GET"])
    def dashboard_index():
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
