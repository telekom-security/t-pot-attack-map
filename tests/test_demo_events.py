import datetime
import os
import sys
import unittest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import demo_events
from demo_events import DemoEventGenerator, DEMO_PROTOCOLS, DEMO_CITIES

BASE_TIME = datetime.datetime(2026, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)

# Exactly the Traffic field set of DataServer.py:362-384 plus "demo".
EXPECTED_TRAFFIC_KEYS = {
    "protocol", "color", "iso_code", "honeypot", "src_port", "event_time",
    "src_lat", "src_ip", "ip_rep", "type", "dst_long", "continent_code",
    "dst_lat", "event_count", "country", "src_long", "dst_port", "dst_ip",
    "dst_iso_code", "dst_country_name", "tpot_hostname", "demo",
}

# ISO codes the fixtures must exercise (HANDOFF §11 WP1 / §8.5).
REQUIRED_ISO_CODES = {"SG", "HK", "MO", "MT", "MC", "LI", "GF", "RE", "XK", "GI"}


def take(gen, n):
    return [gen.next_event() for _ in range(n)]


class TestDemoEvents(unittest.TestCase):

    def test_same_seed_identical_sequence(self):
        a = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        b = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        self.assertEqual(take(a, 200), take(b, 200))

    def test_different_seed_differs(self):
        a = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        b = DemoEventGenerator(seed=43, base_time=BASE_TIME)
        self.assertNotEqual(take(a, 200), take(b, 200))

    def test_exact_traffic_field_set(self):
        gen = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        for event in take(gen, 50):
            self.assertEqual(set(event.keys()), EXPECTED_TRAFFIC_KEYS)
            self.assertEqual(event["type"], "Traffic")

    def test_every_event_is_demo(self):
        for scenario in demo_events.SCENARIOS:
            gen = DemoEventGenerator(seed=42, scenario=scenario, base_time=BASE_TIME)
            for event in take(gen, 60):
                self.assertIs(event["demo"], True)
            self.assertIs(gen.stats_message()["demo"], True)

    def test_first_events_cover_every_curated_protocol(self):
        gen = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        events = take(gen, len(DEMO_PROTOCOLS))
        self.assertEqual(
            [e["protocol"] for e in events],
            [p[0] for p in DEMO_PROTOCOLS],
        )

    def test_antimeridian_scenario_has_wide_pair(self):
        gen = DemoEventGenerator(seed=42, scenario="antimeridian", base_time=BASE_TIME)
        events = take(gen, 10)
        self.assertTrue(
            any(abs(e["src_long"] - e["dst_long"]) > 180 for e in events),
            "antimeridian scenario must contain a |src_long - dst_long| > 180 pair",
        )

    def test_required_iso_codes_appear(self):
        gen = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        seen = {e["iso_code"] for e in take(gen, len(DEMO_CITIES))}
        missing = REQUIRED_ISO_CODES - seen
        self.assertFalse(missing, f"fixture ISO codes missing: {missing}")

    def test_single_location_repeats_coordinate_with_multiple_ips(self):
        gen = DemoEventGenerator(seed=42, scenario="single-location", base_time=BASE_TIME)
        events = take(gen, 40)
        coords = {(e["src_lat"], e["src_long"]) for e in events}
        ips = {e["src_ip"] for e in events}
        self.assertEqual(len(coords), 1)
        self.assertGreater(len(ips), 1)

    def test_stats_derived_from_emitted(self):
        gen = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        take(gen, 25)
        stats = gen.stats_message()
        self.assertEqual(stats["type"], "Stats")
        self.assertEqual(stats["last_24h"], 25)
        self.assertEqual(stats["last_1m"], 25)

    def test_event_count_increments(self):
        gen = DemoEventGenerator(seed=42, base_time=BASE_TIME)
        events = take(gen, 10)
        self.assertEqual([e["event_count"] for e in events], list(range(1, 11)))

    def test_unknown_scenario_rejected(self):
        with self.assertRaises(ValueError):
            DemoEventGenerator(seed=42, scenario="nope")


if __name__ == "__main__":
    unittest.main()
