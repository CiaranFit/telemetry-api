
from flask import Blueprint, jsonify, request
from .storage import db

history_bp = Blueprint("history_api", __name__)

ALLOWED_BUCKETS = {60, 300, 900, 3600, 86400}
MAX_RANGE_SECONDS = 90 * 86400
MAX_BUCKETS = 5000


@history_bp.get("/api/history")
def historical_readings():
    device_id = request.args.get("device_id", "").strip()

    try:
        start = int(request.args["start"])
        end = int(request.args["end"])
        bucket = int(request.args.get("bucket", 300))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Invalid time parameters"), 400

    if not device_id:
        return jsonify(error="device_id required"), 400

    if start < 0 or end <= start:
        return jsonify(error="Invalid date range"), 400

    if end - start > MAX_RANGE_SECONDS:
        return jsonify(error="Maximum range is 90 days"), 400

    if bucket not in ALLOWED_BUCKETS:
        return jsonify(error="Unsupported bucket size"), 400

    if (end - start + bucket - 1) // bucket > MAX_BUCKETS:
        return jsonify(error="Increase bucket size"), 400

    with db() as conn:
        rows = conn.execute("""
            SELECT
                ((ts - ?) / ?) * ? + ? AS ts,
                AVG(temperature) AS temperature,
                AVG(humidity) AS humidity,
                MIN(temperature) AS temp_min,
                MAX(temperature) AS temp_max,
                MIN(humidity) AS humid_min,
                MAX(humidity) AS humid_max,
                COUNT(*) AS samples
            FROM readings
            WHERE device_id = ?
              AND ts >= ?
              AND ts < ?
            GROUP BY ((ts - ?) / ?) * ? + ?
            ORDER BY ts
        """, (
            start, bucket, bucket, start,
            device_id, start, end,
            start, bucket, bucket, start
        )).fetchall()

    return jsonify({
        "device_id": device_id,
        "start": start,
        "end": end,
        "bucket_seconds": bucket,
        "history": [dict(row) for row in rows]
    })
