import logging
import time
from flask import request, jsonify
from .storage import save_metric, get_latest, list_devices, get_history, get_latest_points
logger = logging.getLogger("telemetry")

def register_routes(app):

    @app.route("/health")
    def health():
        return {"status": "healthy"}, 200

    @app.route("/metrics", methods=["POST"])
    def metrics():
        start = time.time()

        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            logger.warning("metric_rejected", extra={"fields": {
                "event": "metric_rejected",
                "reason": "invalid_json",
                "remote_addr": request.remote_addr,
                "user_agent": request.headers.get("User-Agent"),
                "path": request.path,
                "method": request.method,
            }})
            return {"error": "invalid payload"}, 400

        required = ("device_id", "temperature", "humidity", "ts")
        missing = [k for k in required if k not in data]
        if missing:
            logger.warning("metric_rejected", extra={"fields": {
                "event": "metric_rejected",
                "reason": "missing_fields",
                "missing": missing,
                "remote_addr": request.remote_addr,
                "user_agent": request.headers.get("User-Agent"),
            }})
            return {"error": "missing fields", "fields": missing}, 400

        try:
            payload = {
                "device_id": str(data["device_id"]).strip(),
                "temperature": float(data["temperature"]),
                "humidity": float(data["humidity"]),
                "ts": int(data["ts"]),
            }
            payload["ts"] = int(time.time())
        except (TypeError, ValueError):
            logger.warning("metric_rejected", extra={"fields": {
                "event": "metric_rejected",
                "reason": "invalid_field_types",
                "remote_addr": request.remote_addr,
            }})
            return {"error": "invalid field types"}, 400
        
        try:
            save_metric(payload)
        except Exception:
            logger.exception("metric_db_write_failed", extra={"fields": {
                "event": "metric_db_write_failed",
                "device_id": payload.get("device_id"),
                "remote_addr": request.remote_addr,
            }})
            return {"error": "server_error"}, 500
        
        latency_ms = int((time.time() - start) * 1000)
        logger.info("metric_ingested", extra={"fields": {
            "event": "metric_ingested",
            "device_id": payload["device_id"],
            "temperature": payload["temperature"],
            "humidity": payload["humidity"],
            "ts_unix": payload["ts"],
            "remote_addr": request.remote_addr,
            "latency_ms": latency_ms,
        }})

        return {"status": "ok"}, 200

    @app.route("/latest", methods=["GET"])
    def latest():
        device_id = request.args.get("device_id")
        if not device_id:
            logger.warning("latest_rejected", extra={"fields": {
                "event": "latest_rejected",
                "reason": "missing_device_id",
                "remote_addr": request.remote_addr,
            }})
            return {"error": "device_id required"}, 400

        result = get_latest(device_id)
        if not result:
            logger.info("latest_not_found", extra={"fields": {
                "event": "latest_not_found",
                "device_id": device_id,
                "remote_addr": request.remote_addr,
            }})
            return {"error": "not found"}, 404

        logger.info("latest_served", extra={"fields": {
            "event": "latest_served",
            "device_id": device_id,
            "remote_addr": request.remote_addr,
        }})
        return jsonify(result), 200
    
    @app.route("/devices", methods=["GET"])
    def devices():
        return jsonify({"devices": list_devices()}), 200

    @app.route("/history", methods=["GET"])
    def history():
        device_id = request.args.get("device_id")
        minutes = request.args.get("minutes", "60")
        limit = request.args.get("limit", "2000")
        mode = request.args.get("mode", "time")

        if not device_id:
            return {"error": "device_id required"}, 400

        try:
            minutes = int(minutes)
            limit = int(limit)
        except ValueError:
            return {"error": "minutes and limit must be integers"}, 400

        if limit < 10 or limit > 20000:
            return {"error": "limit must be between 10 and 20000"}, 400

        if mode == "latest":
            points = get_latest_points(device_id, limit=limit)
            return jsonify({"device_id": device_id, "mode": "latest", "points": points}), 200

        # default: mode == "time"
        if minutes < 1 or minutes > (24 * 60):
            return {"error": "minutes must be between 1 and 1440"}, 400

        since_ts = int(time.time()) - minutes * 60
        points = get_history(device_id, since_ts, limit=limit)

        return jsonify({
            "device_id": device_id,
            "mode": "time",
            "since_ts": since_ts,
            "points": points
        }), 200