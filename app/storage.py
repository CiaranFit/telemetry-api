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
            CREATE TABLE IF NOT EXISTS metrics (
                device_id TEXT PRIMARY KEY,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                ts INTEGER NOT NULL
            )
        """)
        mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]

def save_metric(data):
    with db() as conn:
        conn.execute("""
            INSERT INTO metrics (device_id, temperature, humidity, ts)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(device_id)
            DO UPDATE SET
                temperature=excluded.temperature,
                humidity=excluded.humidity,
                ts=excluded.ts
        """, (
            data["device_id"],
            data["temperature"],
            data["humidity"],
            data["ts"]
        ))

def get_latest(device_id):
    with db() as conn:
        cur = conn.execute(
            "SELECT device_id, temperature, humidity, ts FROM metrics WHERE device_id = ?",
            (device_id,)
        )
        row = cur.fetchone()

    if row:
        return {
            "device_id": row[0],
            "temperature": row[1],
            "humidity": row[2],
            "ts": row[3]
        }
    return None