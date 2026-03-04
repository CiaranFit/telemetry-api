import os
import sqlite3
from contextlib import contextmanager
from .config import Config

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "telemetry.db")

def _abs_db_path():
    # Make relative paths resolve from project root, not current working directory
    if os.path.isabs(Config.DB_PATH):
        return Config.DB_PATH

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
    return os.path.join(base_dir, Config.DB_PATH)

DB_PATH = _abs_db_path()

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=5)
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

def save_metric(data):
    with db() as conn:
        conn.execute("""
            INSERT INTO readings (device_id, temperature, humidity, ts)
            VALUES (?, ?, ?, ?)
        """, (
            data["device_id"],
            data["temperature"],
            data["humidity"],
            data["ts"]
        ))

def get_latest(device_id):
    with db() as conn:
        cur = conn.execute("""
            SELECT device_id, temperature, humidity, ts
            FROM readings
            WHERE device_id = ?
            ORDER BY ts DESC
            LIMIT 1
        """, (device_id,))
        row = cur.fetchone()

    if row:
        return {
            "device_id": row[0],
            "temperature": row[1],
            "humidity": row[2],
            "ts": row[3]
        }
    return None

def list_devices():
    with db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT device_id
            FROM readings
            ORDER BY device_id ASC
        """).fetchall()
    return [r[0] for r in rows]


def get_history(device_id: str, since_ts: int, limit: int = 5000):
    with db() as conn:
        rows = conn.execute("""
            SELECT temperature, humidity, ts
            FROM readings
            WHERE device_id = ?
              AND ts >= ?
            ORDER BY ts ASC
            LIMIT ?
        """, (device_id, since_ts, limit)).fetchall()

    return [{"temperature": r[0], "humidity": r[1], "ts": r[2]} for r in rows]

def get_latest_points(device_id: str, limit: int = 2000):
    with db() as conn:
        rows = conn.execute("""
            SELECT temperature, humidity, ts
            FROM readings
            WHERE device_id = ?
            ORDER BY ts DESC
            LIMIT ?
        """, (device_id, limit)).fetchall()

    rows.reverse()  # return ASC for charting
    return [{"temperature": r[0], "humidity": r[1], "ts": r[2]} for r in rows]