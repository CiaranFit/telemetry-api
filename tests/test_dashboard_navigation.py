"""Static dashboard contracts for room and chart navigation."""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent
ROOM_PAGES = {"overview", "bedroom", "kitchen", "hallway", "bathroom", "spare-room", "floorplan"}


class Elements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = set()
        self.map_rooms = set()

    def handle_starttag(self, tag, attrs):
        props = dict(attrs)
        if props.get("id"):
            self.ids.add(props["id"])
        if tag == "a" and props.get("data-page"):
            self.links.add(props["data-page"])
        if tag == "g" and props.get("data-page"):
            self.map_rooms.add(props["data-page"])


class DashboardContractTests(unittest.TestCase):
    def test_navigation_and_room_map(self):
        parser = Elements()
        parser.feed((ROOT / "dashboard" / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(parser.links, ROOM_PAGES)
        self.assertEqual(parser.map_rooms, ROOM_PAGES - {"floorplan"})

    def test_instantaneous_tiles_and_four_graphs(self):
        parser = Elements()
        parser.feed((ROOT / "dashboard" / "index.html").read_text(encoding="utf-8"))
        for field in ("temp", "humid", "eco2", "tvoc"):
            self.assertIn("val-" + field, parser.ids)
            self.assertIn("chart-" + field, parser.ids)
            self.assertIn("nd-" + field, parser.ids)
        self.assertTrue({"weather-hours", "sensor-content", "floorplan-content"}.issubset(parser.ids))

    def test_legacy_device_dropdown_removed(self):
        contents = (ROOT / "dashboard" / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
        self.assertNotIn('id="device-select"', contents)
        self.assertNotIn("deviceSelect", script)
        self.assertIn("URLSearchParams(window.location.search)", script)


if __name__ == "__main__":
    unittest.main()
