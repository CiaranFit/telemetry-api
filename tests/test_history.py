
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

class HistoryAPITests(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test.db"

        # Set DB_PATH before importing the app.
        self.old_db_path = os.environ.get("DB_PATH")
        os.environ["DB_PATH"] = str(self.db_path)

        import app.storage
        self.old_storage_path = app.storage.DB_PATH
        app.storage.DB_PATH = str(self.db_path)

        from app import create_app
        self.client = create_app().test_client()

    def tearDown(self):
        import app.storage
        app.storage.DB_PATH = self.old_storage_path

        if self.old_db_path is None:
            os.environ.pop("DB_PATH", None)
        else:
            os.environ["DB_PATH"] = self.old_db_path

        self.temp_dir.cleanup()

    def test_aggregated_history(self):
        readings = [
            ("Test_01", 20.0, 40.0, 1800000000),
            ("Test_01", 22.0, 44.0, 1800000060),
            ("Test_01", 24.0, 50.0, 1800000300),
            ("Test_01", 26.0, 54.0, 1800000360),
        ]

        with sqlite3.connect(self.db_path) as conn:
            conn.executemany("""
                INSERT INTO readings
                (device_id, temperature, humidity, ts)
                VALUES (?, ?, ?, ?)
            """, readings)

        response = self.client.get("/api/history", query_string={
            "device_id": "Test_01",
            "start": 1800000000,
            "end": 1800000600,
            "bucket": 300,
        })

        self.assertEqual(response.status_code, 200)

        data = response.get_json()
        points = data["history"]

        self.assertEqual(len(points), 2)
        self.assertAlmostEqual(points[0]["temperature"], 21.0)
        self.assertAlmostEqual(points[0]["humidity"], 42.0)
        self.assertEqual(points[0]["samples"], 2)

        self.assertAlmostEqual(points[1]["temperature"], 25.0)
        self.assertAlmostEqual(points[1]["humidity"], 52.0)
        self.assertEqual(points[1]["samples"], 2)

        self.assertEqual(points[0]["temp_min"], 20.0)
        self.assertEqual(points[1]["temp_max"], 26.0)


    def test_empty_history(self):
        response = self.client.get("/api/history", query_string={
            "device_id": "Unknown",
            "start": 1800000000,
            "end": 1800003600,
            "bucket": 300,
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["history"], [])

    def test_invalid_date_range(self):
        response = self.client.get("/api/history", query_string={
            "device_id": "Test_01",
            "start": 1800003600,
            "end": 1800000000,
            "bucket": 300,
        })

        self.assertEqual(response.status_code, 400)

    def test_excessive_date_range(self):
        response = self.client.get("/api/history", query_string={
            "device_id": "Test_01",
            "start": 1800000000,
            "end": 1800000000 + 91 * 86400,
            "bucket": 3600,
        })

        self.assertEqual(response.status_code, 400)

    def test_invalid_bucket(self):
        response = self.client.get("/api/history", query_string={
            "device_id": "Test_01",
            "start": 1800000000,
            "end": 1800003600,
            "bucket": 123,
        })

        self.assertEqual(response.status_code, 400)

if __name__ == "__main__":
    unittest.main()
