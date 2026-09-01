#!/usr/bin/python3

"""
Deterministic demo event generator for the T-Pot Attack Map (HANDOFF-v2 §16, D20).

Standard library only at import time (the optional Redis publisher imports `redis`
lazily). Emits exactly the `Traffic` field set produced by DataServer.py:362-384
plus `"demo": true`, and a `Stats` message derived from what was emitted.

DEMO DATA ONLY — never enabled by default, never via environment variable.
Entry points:
    python3 AttackMapServer.py --demo [--demo-seed N] [--demo-rate R]
                               [--demo-burst N] [--demo-scenario S]
    python3 -m demo_events --publish-redis redis://127.0.0.1:6379 [same flags]
"""

import argparse
import datetime
import json
import random
import time

SCENARIOS = ("basic", "antimeridian", "single-location", "flood")

DEMO_BANNER = (
    "=======================================================================\n"
    "  DEMO MODE ACTIVE — all emitted events are SYNTHETIC (demo: true).\n"
    "  Never run demo mode in production.\n"
    "======================================================================="
)

# Curated protocol subset. Colours and port mapping are duplicated from the
# single source of truth in DataServer.py:30 (service_rgb) and DataServer.py:85
# (PORT_MAP) so that DataServer.py and its tests stay untouched (HANDOFF §11 WP1).
# Ordered so the first len(DEMO_PROTOCOLS) events cover every protocol once.
DEMO_PROTOCOLS = [
    # (protocol, color, dst_port)
    ("SSH",      "#FF9800", 22),
    ("TELNET",   "#FFC107", 23),
    ("HTTP",     "#3F51B5", 80),
    ("HTTPS",    "#0080FF", 443),
    ("SMB",      "#BF00FF", 445),
    ("FTP",      "#FF5722", 21),
    ("SMTP",     "#8BC34A", 25),
    ("DNS",      "#00BCD4", 53),
    ("RDP",      "#FF0060", 3389),
    ("VNC",      "#0000FF", 5900),
    ("MYSQL",    "#00FF00", 3306),
    ("REDIS",    "#CC00FF", 6379),
    ("SIP",      "#FFCCFF", 5060),
    ("MQTT",     "#00FF40", 1883),
    ("OTHER",    "#78909C", 48721),   # unmapped port -> OTHER (DataServer.port_to_type)
]

# ~26 source cities on all continents (HANDOFF §11 WP1): antimeridian pairs
# (Tokyo -> San Jose, Auckland -> Seattle), high latitudes (Reykjavík, Ushuaia),
# the equator/prime-meridian region (Accra, Quito), and the §8.5 choropleth ISO
# cases SG, HK, MO, MT, MC, LI, GF, RE, XK plus the intentionally unsupported GI.
# (city, country, iso_code, continent_code, lat, lng)
DEMO_CITIES = [
    ("Tokyo",        "Japan",          "JP", "AS",  35.6762,  139.6503),
    ("Auckland",     "New Zealand",    "NZ", "OC", -36.8485,  174.7633),
    ("Beijing",      "China",          "CN", "AS",  39.9042,  116.4074),
    ("Moscow",       "Russia",         "RU", "EU",  55.7558,   37.6173),
    ("Sao Paulo",    "Brazil",         "BR", "SA", -23.5505,  -46.6333),
    ("Lagos",        "Nigeria",        "NG", "AF",   6.5244,    3.3792),
    ("Reykjavik",    "Iceland",        "IS", "EU",  64.1466,  -21.9426),
    ("Ushuaia",      "Argentina",      "AR", "SA", -54.8019,  -68.3030),
    ("Singapore",    "Singapore",      "SG", "AS",   1.3521,  103.8198),
    ("Hong Kong",    "Hong Kong",      "HK", "AS",  22.3193,  114.1694),
    ("Macao",        "Macao",          "MO", "AS",  22.1987,  113.5439),
    ("Valletta",     "Malta",          "MT", "EU",  35.8989,   14.5146),
    ("Monaco",       "Monaco",         "MC", "EU",  43.7384,    7.4246),
    ("Vaduz",        "Liechtenstein",  "LI", "EU",  47.1410,    9.5209),
    ("Cayenne",      "French Guiana",  "GF", "SA",   4.9224,  -52.3135),
    ("Saint-Denis",  "Reunion",        "RE", "AF", -20.8789,   55.4481),
    ("Pristina",     "Kosovo",         "XK", "EU",  42.6629,   21.1655),
    ("Gibraltar",    "Gibraltar",      "GI", "EU",  36.1408,   -5.3536),
    ("Mumbai",       "India",          "IN", "AS",  19.0760,   72.8777),
    ("Sydney",       "Australia",      "AU", "OC", -33.8688,  151.2093),
    ("Cairo",        "Egypt",          "EG", "AF",  30.0444,   31.2357),
    ("New York",     "United States",  "US", "NA",  40.7128,  -74.0060),
    ("Mexico City",  "Mexico",         "MX", "NA",  19.4326,  -99.1332),
    ("London",       "United Kingdom", "GB", "EU",  51.5074,   -0.1278),
    ("Accra",        "Ghana",          "GH", "AF",   5.6037,   -0.1870),
    ("Quito",        "Ecuador",        "EC", "SA",  -0.1807,  -78.4678),
]

# Three synthetic sensors (destination honeypot hosts).
# (tpot_hostname, dst_ip, country, iso_code, lat, lng)
DEMO_SENSORS = [
    ("demo-sensor-fra", "10.10.0.1", "Germany",       "DE", 50.1109,    8.6821),   # Frankfurt
    ("demo-sensor-sjc", "10.10.0.2", "United States", "US", 37.3382, -121.8863),   # San Jose
    ("demo-sensor-sea", "10.10.0.3", "United States", "US", 47.6062, -122.3321),   # Seattle
]

# Real honeypot names (subset of the DataServer.py ES query list).
DEMO_HONEYPOTS = [
    "Cowrie", "Dionaea", "Honeytrap", "Sentrypeer", "Tanner",
    "Heralding", "ConPot", "Mailoney", "ElasticPot", "RDPHoneypot",
]

DEMO_IP_REPS = [
    "Known Attacker", "Mass Scanner", "Bot, Crawler", "Reputation Unknown",
]

# One exact repeated coordinate with several src_ips (aggregation test case):
# Beijing always uses one of these five addresses.
REPEATED_COORD_CITY = "Beijing"
REPEATED_COORD_IPS = [
    "203.0.113.10", "203.0.113.24", "203.0.113.57", "203.0.113.101", "203.0.113.222",
]

# Antimeridian scenario pairs: (city name, sensor hostname).
ANTIMERIDIAN_PAIRS = [
    ("Tokyo",    "demo-sensor-sjc"),   # Tokyo    -> San Jose
    ("Auckland", "demo-sensor-sea"),   # Auckland -> Seattle
]


class DemoEventGenerator:
    """Deterministic Traffic/Stats generator.

    Same (seed, scenario, base_time) -> identical event sequence. With
    base_time=None, event_time uses the wall clock (live mode); tests pass a
    fixed base_time and get one synthetic second per event.
    """

    def __init__(self, seed=42, scenario="basic", base_time=None):
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; expected one of {SCENARIOS}")
        self.seed = seed
        self.scenario = scenario
        self.base_time = base_time
        self.rng = random.Random(seed)
        self.event_count = 1
        self.emitted_monotonic = []     # emit timestamps for Stats derivation
        self._cities_by_name = {c[0]: c for c in DEMO_CITIES}
        self._sensors_by_name = {s[0]: s for s in DEMO_SENSORS}

    # -- internals --------------------------------------------------------

    def _event_time(self):
        if self.base_time is not None:
            dt = self.base_time + datetime.timedelta(seconds=self.event_count - 1)
        else:
            dt = datetime.datetime.now(datetime.UTC)
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    def _src_ip(self, city_name):
        if city_name == REPEATED_COORD_CITY:
            return self.rng.choice(REPEATED_COORD_IPS)
        return (
            f"{self.rng.randint(1, 223)}.{self.rng.randint(0, 255)}."
            f"{self.rng.randint(0, 255)}.{self.rng.randint(1, 254)}"
        )

    def _pick_city(self):
        if self.scenario == "single-location":
            return self._cities_by_name[REPEATED_COORD_CITY]
        if self.scenario == "antimeridian":
            city_name, _ = ANTIMERIDIAN_PAIRS[(self.event_count - 1) % len(ANTIMERIDIAN_PAIRS)]
            return self._cities_by_name[city_name]
        # basic / flood: first pass covers every city once (deterministic order),
        # afterwards random choice.
        idx = self.event_count - 1
        if idx < len(DEMO_CITIES):
            return DEMO_CITIES[idx]
        return self.rng.choice(DEMO_CITIES)

    def _pick_sensor(self, city_name):
        if self.scenario == "antimeridian":
            for pair_city, sensor_name in ANTIMERIDIAN_PAIRS:
                if pair_city == city_name:
                    return self._sensors_by_name[sensor_name]
        # keep the curated antimeridian pairs in every scenario
        if city_name == "Tokyo":
            return self._sensors_by_name["demo-sensor-sjc"]
        if city_name == "Auckland":
            return self._sensors_by_name["demo-sensor-sea"]
        return self.rng.choice(DEMO_SENSORS)

    def _pick_protocol(self):
        # First len(DEMO_PROTOCOLS) events cover every curated protocol once.
        idx = self.event_count - 1
        if idx < len(DEMO_PROTOCOLS):
            return DEMO_PROTOCOLS[idx]
        return self.rng.choice(DEMO_PROTOCOLS)

    # -- public API -------------------------------------------------------

    def next_event(self):
        """One Traffic message — exactly the DataServer.py:362-384 field set
        plus "demo": true."""
        city, country, iso, continent, lat, lng = self._pick_city()
        hostname, dst_ip, _dst_country, dst_iso, dst_lat, dst_lng = self._pick_sensor(city)
        protocol, color, dst_port = self._pick_protocol()
        event = {
            "protocol": protocol,
            "color": color,
            "iso_code": iso,
            "honeypot": self.rng.choice(DEMO_HONEYPOTS),
            "src_port": self.rng.randint(1024, 65535),
            "event_time": self._event_time(),
            "src_lat": lat,
            "src_ip": self._src_ip(city),
            "ip_rep": self.rng.choice(DEMO_IP_REPS),
            "type": "Traffic",
            "dst_long": dst_lng,
            "continent_code": continent,
            "dst_lat": dst_lat,
            "event_count": self.event_count,
            "country": country,
            "src_long": lng,
            "dst_port": dst_port,
            "dst_ip": dst_ip,
            "dst_iso_code": dst_iso,
            "dst_country_name": _dst_country,
            "tpot_hostname": hostname,
            "demo": True,
        }
        self.event_count += 1
        self.emitted_monotonic.append(time.monotonic())
        return event

    def stats_message(self):
        """A Stats message with counters derived from what was emitted."""
        now = time.monotonic()
        total = len(self.emitted_monotonic)
        last_1m = sum(1 for t in self.emitted_monotonic if now - t <= 60)
        last_1h = sum(1 for t in self.emitted_monotonic if now - t <= 3600)
        # keep the timestamp list bounded (Stats only needs the last hour)
        if total > 200_000:
            self.emitted_monotonic = self.emitted_monotonic[-100_000:]
        return {
            "last_1m": last_1m,
            "last_1h": last_1h,
            "last_24h": total,
            "type": "Stats",
            "demo": True,
        }


def add_demo_arguments(parser):
    """Shared --demo-* flags (used by AttackMapServer.py and the CLI below)."""
    parser.add_argument("--demo-seed", type=int, default=42,
                        help="deterministic RNG seed (default: 42)")
    parser.add_argument("--demo-rate", type=float, default=2.0,
                        help="events per second (default: 2)")
    parser.add_argument("--demo-burst", type=int, default=0,
                        help="emit N events immediately at startup")
    parser.add_argument("--demo-scenario", choices=SCENARIOS, default="basic",
                        help="event scenario (default: basic)")


def _publish_redis_main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python3 -m demo_events",
        description="Publish synthetic demo events to a Redis channel "
                    "(full-chain test, HANDOFF §16).")
    parser.add_argument("--publish-redis", required=True, metavar="REDIS_URL",
                        help="e.g. redis://127.0.0.1:6379")
    parser.add_argument("--channel", default="attack-map-production")
    add_demo_arguments(parser)
    args = parser.parse_args(argv)

    import redis  # lazy: keeps demo_events stdlib-only at import time

    client = redis.Redis.from_url(args.publish_redis)
    gen = DemoEventGenerator(seed=args.demo_seed, scenario=args.demo_scenario)
    interval = 1.0 / args.demo_rate if args.demo_rate > 0 else 0.5
    if args.demo_scenario == "flood":
        interval = min(interval, 0.02)

    print(DEMO_BANNER)
    last_banner = time.monotonic()
    last_stats = time.monotonic()

    for _ in range(args.demo_burst):
        client.publish(args.channel, json.dumps(gen.next_event()))

    try:
        while True:
            client.publish(args.channel, json.dumps(gen.next_event()))
            now = time.monotonic()
            if now - last_stats >= 10:
                client.publish(args.channel, json.dumps(gen.stats_message()))
                last_stats = now
            if now - last_banner >= 60:
                print(DEMO_BANNER)
                last_banner = now
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nDemo publisher stopped.")


if __name__ == "__main__":
    _publish_redis_main()
