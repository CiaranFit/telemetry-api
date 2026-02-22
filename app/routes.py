from flask import request, jsonify
from .storage import save_metric, get_latest

def register_routes(app):

    @app.route("/metrics", methods=["POST"])
    def metrics():
        data = request.get_json()

        required = ["device_id", "temperature", "humidity", "ts"]
        if not all(k in data for k in required):
            return {"error": "invalid payload"}, 400

        save_metric(data)

        return {"status": "ok"}, 200

    @app.route("/latest", methods=["GET"])
    def latest():
        device_id = request.args.get("device_id")
        if not device_id:
            return {"error": "device_id required"}, 400

        result = get_latest(device_id)
        if not result:
            return {"error": "not found"}, 404

        return jsonify(result), 200
    
    @app.route("/")
    def root():
        return {"service": "telemetry-api"}, 200

    @app.route("/health")
    def health():
        return {"status": "healthy"}, 200