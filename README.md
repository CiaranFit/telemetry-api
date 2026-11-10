# Telemetry Ingestion Service

Internal LAN telemetry ingestion API for IoT sensors.

## Features
- POST /metrics
- GET /latest
- SQLite persistence
- Structured logging
- Gunicorn runtime

## Stack
- Python
- Flask
- SQLite
- Gunicorn

## Philips Hue (read-only)

The API exposes `GET /api/hue/health`, `/api/hue/lights`,
`/api/hue/rooms`, and `/api/hue/scenes`. Each returns `data` and `error`:
on success `data` is the bridge's resource array and `error` is null; on
failure `data` is null and `error` is a safe message. Health reads the bridge
resource, so it checks connectivity and authorization. No control endpoints
are provided.

On the Pi, keep the existing `~/.config/telemetry-api/hue.env` private (for
example, owned by the service account with mode 600). Set the following there,
using the bridge's IP address and a Hue application key obtained separately:

```ini
HUE_BRIDGE_IP=<bridge-ip-address>
HUE_BRIDGE_ID=ecb5fafffe19ef1d
HUE_APPLICATION_KEY=<application-key>
# Required: path to a trusted bridge CA certificate in PEM format
HUE_BRIDGE_CA_FILE=/absolute/path/to/bridge-ca.pem
```

Do not commit this file. Configure `telemetry-api.service` with a systemd
drop-in via `systemctl edit telemetry-api.service`:

```ini
[Service]
EnvironmentFile=/home/<service-user>/.config/telemetry-api/hue.env
```

Replace the path with the actual absolute path; systemd does not expand `~`
in `EnvironmentFile`. The service account must be able to read both files.
After saving the drop-in, reload systemd and restart the service on the Pi.
The connection goes to `HUE_BRIDGE_IP`; TLS verifies the certificate chain
against `HUE_BRIDGE_CA_FILE` and the certificate identity against the 16-digit
hexadecimal `HUE_BRIDGE_ID`. The bridge's common name is accepted when the
certificate has no subjectAltName. Provision the correct trusted bridge CA
through a trusted channel. A certificate trust or identity failure appears as
a bridge error until trust is configured correctly. This project does not
declare a supported Python version range; this implementation is tested on the
configured Python 3.10 environment.

Hue endpoints do not grant cross-origin browser access, but CORS is not
authentication or a network firewall. LAN access alone does not prevent local
clients or server-side requests from reading these endpoints. Restrict network
access to trusted clients; future control actions require authentication,
authorization, and appropriate CSRF/origin protections before being exposed.
