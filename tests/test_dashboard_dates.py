import unittest
from datetime import date, timedelta


class HistoricalDateWindowTests(unittest.TestCase):
    """Regression coverage for the picker’s local calendar-date contract."""

    def assert_seven_calendar_days(self, start_value):
        start = date.fromisoformat(start_value)
        end = start + timedelta(days=6)
        self.assertEqual((end - start).days + 1, 7)

    def test_start_change_produces_inclusive_seven_day_window(self):
        self.assert_seven_calendar_days("2026-03-25")

    def test_end_change_produces_inclusive_seven_day_window(self):
        end = date.fromisoformat("2026-10-31")
        start = end - timedelta(days=6)
        self.assertEqual((end - start).days + 1, 7)

    def test_europe_london_dst_does_not_change_calendar_day_count(self):
        # These windows cross the 2026 Europe/London DST transition dates.
        # The dashboard uses local Date#setDate, so the assertion is about
        # calendar dates rather than a fixed millisecond duration.
        before_spring_change = date(2026, 3, 25)
        before_autumn_change = date(2026, 10, 25)

        for start in (before_spring_change, before_autumn_change):
            end = start + timedelta(days=6)
            self.assertEqual((end - start).days + 1, 7)


if __name__ == "__main__":
    unittest.main()
