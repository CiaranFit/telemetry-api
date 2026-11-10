from flask import Blueprint, jsonify

from .hue_client import HueError, get_resource

hue_bp = Blueprint("hue_api", __name__)


def _read(resource):
    try:
        return jsonify(data=get_resource(resource), error=None)
    except HueError as error:
        return jsonify(data=None, error=str(error)), error.status


@hue_bp.get("/api/hue/health")
def health():
    return _read("bridge")


@hue_bp.get("/api/hue/lights")
def lights():
    return _read("light")


@hue_bp.get("/api/hue/rooms")
def rooms():
    return _read("room")


@hue_bp.get("/api/hue/scenes")
def scenes():
    return _read("scene")
