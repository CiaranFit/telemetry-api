"""Weather strip regression tests without external network requests."""
import json
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.routes import fetch_weather_today


class Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self):
        return self.payload


class HourlyWeatherTests(unittest.TestCase):
    def test_next_seven_hours_and_existing_daily_fields(self):
        now = datetime.now(ZoneInfo("Europe/London")).replace(minute=0, second=0, microsecond=0)
        times = [(now + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(14)]
        payload = {
            "current": {"temperature_2m": 6, "weather_code": 61},
            "daily": {
                "temperature_2m_min": [3],
                "temperature_2m_max": [8],
                "precipitation_probability_max": [92],
                "weather_code": [61],
            },
            "hourly": {
                "time": times,
                "temperature_2m": list(range(14)),
                "precipitation_probability": [80] * 14,
                "weather_code": [61] * 14,
            },
        }

        with patch("app.routes.urlopen", return_value=Response(payload)) as mock_open:
            response = fetch_weather_today()

        self.assertEqual(len(response["hours"]), 7)
        self.assertEqual(response["hours"][0]["time"], times[0])
        self.assertEqual(response["hours"][-1]["time"], times[6])
        self.assertEqual(response["hours"][0]["temperature"], 0)
        self.assertEqual(response["hours"][0]["precip_chance"], 80)
        self.assertEqual(response["hours"][0]["weather_code"], 61)
        self.assertEqual(response["temperature"], 6)
        self.assertEqual(response["temp_min"], 3)
        self.assertEqual(response["temp_max"], 8)
        self.assertEqual(response["condition"], "Slight rain")
        self.assertIn("hourly=", mock_open.call_args.args[0])

    def test_missing_hourly_forecast_is_graceful(self):
        with patch("app.routes.urlopen", return_value=Response({
            "current": {}, "daily": {}, "hourly": {}
        })):
            response = fetch_weather_today()
        self.assertEqual(response["hours"], [])


if __name__ == "__main__":
    unittest.main()
