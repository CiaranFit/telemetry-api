# Changelog

All notable changes to this project will be documented in this file.

The format loosely follows Keep a Changelog and Semantic Versioning principles.

---

## [v0.3-time-series] - 2026-03-04

### Added
- Append-only `readings` table for time-series telemetry storage
- Index on `(device_id, ts)` for efficient latest + history queries
- End-to-end ingestion from Raspberry Pico W
- Historical data storage (no longer overwriting device state)

### Changed
- Migrated ingestion logic from upsert-based `metrics` table to insert-only `readings`
- Updated `/latest` endpoint to query by `ORDER BY ts DESC LIMIT 1`

### Verified
- Full telemetry pipeline: Pico → HTTP → API → SQLite → Query
- Concurrent ingestion under WAL mode
- LAN connectivity + firewall resolution

---

## [v0.2-persistence-hardened] - 2026-03-04

### Added
- SQLite durable storage
- WAL (Write-Ahead Logging) mode
- `busy_timeout` configuration
- Centralised DB path via `Config`
- Indexed query support

### Verified
- Data durability across restarts
- Concurrent ingestion stress test
- Windows WSGI serving via Waitress

---

## [v0.1-initial-ingest] - 2026-03-04

### Added
- Flask application factory structure
- `/metrics` POST endpoint with validation
- `/latest` GET endpoint
- Structured logging
- LAN binding (`0.0.0.0`)
- Basic SQLite state table

### Initial Goal
Establish LAN-based telemetry ingestion API for embedded sensor devices.