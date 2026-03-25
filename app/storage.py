import os
import sqlite3
from contextlib import contextmanager
from .config import Config


def _abs_db_path() -> str:
    """
    Resolve the database path from project root if Config.DB_PATH is relative.
    """
    if os.path.isabs(Config.DB_PATH):
        return Config.DB_PATH

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(project_root, Config.DB_PATH)


DB_PATH = _abs_db_path()


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row

    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                ts INTEGER NOT NULL
            )
        """)

        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_readings_device_ts
            ON readings(device_id, ts)
        """)


def save_metric(data: dict):
    with db() as conn:
        conn.execute("""
            INSERT INTO readings (device_id, temperature, humidity, ts)
            VALUES (?, ?, ?, ?)
        """, (
            data["device_id"],
            data["temperature"],
            data["humidity"],
            data["ts"],
        ))


def get_latest(device_id: str):
    with db() as conn:
        row = conn.execute("""
            SELECT device_id, temperature, humidity, ts
            FROM readings
            WHERE device_id = ?
            ORDER BY ts DESC
            LIMIT 1
        """, (device_id,)).fetchone()

    if row is None:
        return None

    return {
        "device_id": row["device_id"],
        "temperature": row["temperature"],
        "humidity": row["humidity"],
        "ts": row["ts"],
    }


def list_devices():
    with db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT device_id
            FROM readings
            ORDER BY device_id ASC
        """).fetchall()

    return [row["device_id"] for row in rows]


def get_history(device_id: str, since_ts: int, limit: int = 5000):
    """
    Return points from oldest to newest for a rolling time window.
    """
    with db() as conn:
        rows = conn.execute("""
            SELECT device_id, temperature, humidity, ts
            FROM (
                SELECT device_id, temperature, humidity, ts
                FROM readings
                WHERE device_id = ?
                  AND ts >= ?
                ORDER BY ts DESC
                LIMIT ?
            ) recent
            ORDER BY ts ASC
        """, (device_id, since_ts, limit)).fetchall()

    return [
        {
            "device_id": row["device_id"],
            "temperature": row["temperature"],
            "humidity": row["humidity"],
            "ts": row["ts"],
        }
        for row in rows
    ]


def get_latest_points(device_id: str, limit: int = 2000):
    """
    Return the most recent N points, but ordered oldest to newest for charting.
    """
    with db() as conn:
        rows = conn.execute("""
            SELECT device_id, temperature, humidity, ts
            FROM readings
            WHERE device_id = ?
            ORDER BY ts DESC
            LIMIT ?
        """, (device_id, limit)).fetchall()

    rows = list(reversed(rows))

    return [
        {
            "device_id": row["device_id"],
            "temperature": row["temperature"],
            "humidity": row["humidity"],
            "ts": row["ts"],
        }
        for row in rows
    ]
