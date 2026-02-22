import sqlite3

DB_PATH = "data/telemetry.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            device_id TEXT PRIMARY KEY,
            temperature REAL,
            humidity REAL,
            ts INTEGER
        )
    """)
    conn.commit()
    conn.close()


def save_metric(data):
    conn = sqlite3.connect(DB_PATH)
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
    conn.commit()
    conn.close()


def get_latest(device_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.execute(
        "SELECT device_id, temperature, humidity, ts FROM metrics WHERE device_id = ?",
        (device_id,)
    )
    row = cursor.fetchone()
    conn.close()

    if row:
        return {
            "device_id": row[0],
            "temperature": row[1],
            "humidity": row[2],
            "ts": row[3]
        }