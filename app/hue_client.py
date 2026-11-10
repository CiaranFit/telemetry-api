"""Read-only access to the local Hue bridge's CLIP v2 resources."""

import http.client
import ipaddress
import json
import os
import re
import socket
import ssl


class HueError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


class HueHTTPSConnection(http.client.HTTPSConnection):
    """Connect to the bridge IP while verifying its certificate's bridge ID."""

    def __init__(self, host, bridge_id, *, context, timeout):
        super().__init__(host, context=context, timeout=timeout)
        self.bridge_id = bridge_id

    def connect(self):
        http.client.HTTPConnection.connect(self)
        try:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.bridge_id)
        except Exception:
            self.close()
            raise


def _redact(value, secret):
    if isinstance(value, str):
        return value.replace(secret, "[redacted]")
    if isinstance(value, list):
        return [_redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {_redact(key, secret): _redact(item, secret)
                for key, item in value.items()}
    return value


def get_resource(resource):
    if resource not in {"light", "room", "scene", "bridge"}:
        raise ValueError("Unsupported Hue resource")

    bridge = os.environ.get("HUE_BRIDGE_IP", "").strip()
    bridge_id = os.environ.get("HUE_BRIDGE_ID", "").strip()
    ca_file = os.environ.get("HUE_BRIDGE_CA_FILE", "").strip()
    key = os.environ.get("HUE_APPLICATION_KEY", "").strip()
    if not bridge or not bridge_id or not ca_file or not key:
        raise HueError("Hue is not configured", 503)
    if not re.fullmatch(r"[0-9a-fA-F]{16}", bridge_id):
        raise HueError("Hue configuration is invalid", 503)
    try:
        bridge = str(ipaddress.ip_address(bridge))
    except ValueError:
        raise HueError("Hue configuration is invalid", 503) from None

    try:
        context = ssl.create_default_context(cafile=ca_file)
        context.hostname_checks_common_name = True
    except (OSError, ValueError):
        raise HueError("Hue configuration is invalid", 503) from None

    connection = None
    try:
        connection = HueHTTPSConnection(bridge, bridge_id, timeout=5, context=context)
        connection.request("GET", "/clip/v2/resource/" + resource,
                           headers={"hue-application-key": key, "Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise HueError("Hue bridge returned an error", 502)
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise HueError("Hue bridge returned an invalid response", 502)
        payload = json.loads(body)
        if (not isinstance(payload, dict) or not isinstance(payload.get("data"), list)
                or not isinstance(payload.get("errors"), list) or payload["errors"]):
            raise HueError("Hue bridge returned an invalid response", 502)
        return _redact(payload["data"], key)
    except (socket.timeout, TimeoutError):
        raise HueError("Hue bridge timed out", 504) from None
    except (OSError, http.client.HTTPException, ValueError, UnicodeError):
        raise HueError("Hue bridge unavailable or returned an invalid response", 502) from None
    finally:
        if connection is not None:
            connection.close()
