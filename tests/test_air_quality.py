"""Regression tests for optional SGP30 eCO2/TVOC measurements."""
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path


class AirQualityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "readings.db"
        self.old_env = os.environ.get("DB_PATH")
        os.environ["DB_PATH"] = str(self.path)
        import app.storage
        self.old_path = app.storage.DB_PATH
        app.storage.DB_PATH = str(self.path)

        # Start from the exact historical schema, with an existing reading.
        with sqlite3.connect(self.path) as con:
            con.execute("""CREATE TABLE readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                temperature REAL NOT NULL,
                humidity REAL NOT NULL,
                ts INTEGER NOT NULL
            )""")
            con.execute(
                "INSERT INTO readings (device_id,temperature,humidity,ts) VALUES (?,?,?,?)",
                ("Test_01", 19.0, 50.0, int(time.time()) - 30),
            )

        from app import create_app
        self.client = create_app().test_client()

    def tearDown(self):
        import app.storage
        app.storage.DB_PATH = self.old_path
        if self.old_env is None:
            os.environ.pop("DB_PATH", None)
        else:
            os.environ["DB_PATH"] = self.old_env
        self.tmp.cleanup()

    def test_migration_preserves_old_data_and_is_idempotent(self):
        from app.storage import init_db
        init_db()
        with sqlite3.connect(self.path) as con:
            columns = {r[1] for r in con.execute("PRAGMA table_info(readings)")}
            self.assertTrue({"eco2", "tvoc"}.issubset(columns))
            old = con.execute(
                "SELECT temperature,humidity,eco2,tvoc FROM readings WHERE device_id='Test_01'"
            ).fetchone()
        self.assertEqual(old, (19.0, 50.0, None, None))

    def test_legacy_payload_remains_valid(self):
        resp = self.client.post("/metrics", json={
            "device_id": "Livingroom", "temperature": 20.1, "humidity": 52.0
        })
        self.assertEqual(resp.status_code, 200)
        latest = self.client.get("/latest?device_id=Livingroom").get_json()
        self.assertIsNone(latest["eco2"])
        self.assertIsNone(latest["tvoc"])

    def test_air_quality_round_trip(self):
        resp = self.client.post("/metrics", json={
            "device_id": "Livingroom", "temperature": 20.3, "humidity": 49.0,
            "eco2": 525, "tvoc": 17
        })
        self.assertEqual(resp.status_code, 200)
        latest = self.client.get("/latest?device_id=Livingroom").get_json()
        self.assertEqual((latest["eco2"], latest["tvoc"]), (525, 17))

        series = self.client.get("/history", query_string={
            "device_id": "Livingroom", "minutes": 5
        }).get_json()["history"]
        self.assertEqual((series[-1]["eco2"], series[-1]["tvoc"]), (525, 17))

        ts = latest["ts"]
        aggregated = self.client.get("/api/history", query_string={
            "device_id": "Livingroom", "start": ts - 5, "end": ts + 5, "bucket": 60
        }).get_json()["history"]
        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0]["eco2"], 525)
        self.assertEqual(aggregated[0]["tvoc"], 17)

    def test_missing_gas_readings_do_not_change_averages(self):
        self.client.post("/metrics", json={
            "device_id": "Livingroom", "temperature": 20, "humidity": 50
        })
        self.client.post("/metrics", json={
            "device_id": "Livingroom", "temperature": 22, "humidity": 52,
            "eco2": 600, "tvoc": 40
        })
        now = int(time.time())
        series = self.client.get("/api/history", query_string={
            "device_id": "Livingroom", "start": now - 5, "end": now + 5, "bucket": 60
        }).get_json()["history"]
        self.assertEqual(len(series), 1)
        self.assertEqual(series[0]["samples"], 2)
        self.assertEqual(series[0]["eco2"], 600)
        self.assertEqual(series[0]["tvoc"], 40)

    def test_invalid_air_quality_is_rejected(self):
        for name in ("eco2", "tvoc"):
            for value in (-1, 65536, 12.5, "bad", True, {}, []):
                with self.subTest(name=name, value=value):
                    response = self.client.post("/metrics", json={
                        "device_id": "Livingroom",
                        "temperature": 20, "humidity": 50,
                        name: value
                    })
                    self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/latest?device_id=Livingroom").status_code, 404)


if __name__ == "__main__":
    unittest.main()
