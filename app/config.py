import os

class Config:
    DB_PATH = os.getenv("DB_PATH", "data/telemetry.db")
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
    WEATHER_LAT = os.getenv("WEATHER_LAT", "53.2574")
    WEATHER_LON = os.getenv("WEATHER_LON", "-1.9128")
    WEATHER_TIMEZONE = os.getenv("WEATHER_TIMEZONE", "Europe/London")
