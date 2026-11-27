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


## Dashboard pages

The Flask-hosted dashboard at `/dashboard/` uses data-driven room navigation instead
of a device selector. The default `Overview` uses the `Livingroom` sensor for
the combined open-plan living room and kitchen. Overview and Floorplan are
always available; other room tabs appear after their first stored reading and
remain available for history if a sensor goes offline.
Links can be bookmarked (for example, `/dashboard/?room=bedroom` or
`/dashboard/?room=floorplan`).

| Page | Expected Pico `device_id` |
|---|---|
| Overview (living room / kitchen) | `Livingroom` |
| Bedroom | `Bedroom` |
| Hallway | `Hallway` |
| Bathroom | `Bathroom` |
| Spare room | `Spare_Room` |

Each room page has temperature, relative humidity, eCO₂ and TVOC live readings,
with synchronized 4/8/24-hour charts and the existing historical date picker.
The Overview additionally shows seven hourly weather forecast entries from
Open-Meteo via `/weather/today`. The floorplan uses the same `/latest`
endpoint as the charts. A Temperature / Humidity toggle switches the live
labels, colours and legend immediately using cached readings without additional
API requests. Temperature uses a blue → green (20°C) → red scale across
16–24°C. Relative humidity uses a blue → green (50% RH) → red scale
across 30–70% RH. The selected mode persists in the browser. Rooms without
the selected measurement or with readings older than two minutes stay grey;
rooms not registered in `/devices` show "Sensor not installed" on their
detail page. Navigation refreshes with each 30-second poll. The old `?room=kitchen`
URL opens the Overview; the floorplan reports five climate zones.

SGP30 eCO₂ is **not** a direct atmospheric CO₂ measurement. Its values
and the TVOC readings are indicative, with a startup baseline settling period.

No new database schema or sensor firmware change is required for these UI
pages beyond the existing optional `eco2` and `tvoc` fields. If a sensor
uses a different device ID, update the `ROOM_PAGES` mapping in
`dashboard/app.js`; the dashboard expects the exact identifiers above.

After pulling the updated project on the Pi, run:

```bash
.venv/bin/python -m unittest discover -s tests -v
sudo systemctl restart telemetry-api
```

The dashboard CSS and JS references include a new asset version to help
browsers reload the updated code after deployment.
