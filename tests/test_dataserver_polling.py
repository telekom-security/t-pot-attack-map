# Deterministic ES event polling (security reviews 2026-09-02): sorted,
# search_after-paged inside a PIT (unique _shard_doc tiebreaker), bounded per
# tick; watermark policy: catch up on bursts, skip ahead only under sustained
# overload (bounded lag).
import unittest

from DataServer import (
    EVENT_PAGE_SIZE,
    MAX_EVENT_PAGES_PER_POLL,
    MAX_WATERMARK_LAG_S,
    advance_watermark,
    build_event_query,
    fetch_new_events,
)


def make_hit(i, ts=None):
    ts = ts or f"2026-09-02T12:00:{i // 1000:02d}.{i % 1000:03d}"
    # PIT searches sort by [@timestamp, _shard_doc]; the tuple is unique even
    # when timestamps collide
    return {"_source": {"@timestamp": ts}, "sort": [ts, i]}


class StubEs:
    """Serves a fixed, ordered hit list the way ES would inside a PIT:
    sorted pages of `size`, continuing after the `search_after` tuple."""

    def __init__(self, hits, fail_on_call=None):
        self.hits = hits
        self.calls = []
        self.pit_opened = 0
        self.pit_closed = []
        self.fail_on_call = fail_on_call

    def open_point_in_time(self, index, keep_alive):
        self.pit_opened += 1
        self.pit_index = index
        return {"id": "pit-1"}

    def close_point_in_time(self, id):
        self.pit_closed.append(id)

    def search(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail_on_call is not None and len(self.calls) == self.fail_on_call:
            raise RuntimeError("search blew up")
        start = 0
        if "search_after" in kwargs:
            cursor = tuple(kwargs["search_after"])
            start = next(i for i, h in enumerate(self.hits) if tuple(h["sort"]) > cursor)
        page = self.hits[start:start + kwargs["size"]]
        return {"pit_id": "pit-1", "hits": {"hits": page}}


class FetchNewEventsTest(unittest.TestCase):
    def test_all_hits_beyond_one_page_are_returned(self):
        es = StubEs([make_hit(i) for i in range(250)])
        hits, last_ts, saturated = fetch_new_events(es, "2026-09-02T11:59:00", "2026-09-02T12:01:00")
        self.assertEqual(len(hits), 250)
        self.assertFalse(saturated)
        self.assertEqual(last_ts, es.hits[-1]["_source"]["@timestamp"])
        self.assertEqual(len(es.calls), 3)
        self.assertNotIn("search_after", es.calls[0])
        self.assertEqual(es.calls[1]["search_after"], es.hits[99]["sort"])
        self.assertEqual(es.calls[2]["search_after"], es.hits[199]["sort"])

    def test_searches_run_inside_a_pit_and_close_it(self):
        es = StubEs([make_hit(i) for i in range(5)])
        fetch_new_events(es, "a", "b")
        self.assertEqual(es.pit_opened, 1)
        self.assertEqual(es.pit_closed, ["pit-1"])
        self.assertEqual(es.pit_index, "logstash-*")
        for call in es.calls:
            self.assertEqual(call["pit"]["id"], "pit-1")
            self.assertNotIn("index", call, "PIT searches must not name an index")
            self.assertEqual(call["sort"], [{"@timestamp": "asc"}])
            self.assertEqual(call["size"], EVENT_PAGE_SIZE)

    def test_pit_is_closed_even_when_a_search_fails(self):
        es = StubEs([make_hit(i) for i in range(250)], fail_on_call=2)
        with self.assertRaises(RuntimeError):
            fetch_new_events(es, "a", "b")
        self.assertEqual(es.pit_closed, ["pit-1"])

    def test_page_boundary_inside_equal_timestamps_loses_nothing(self):
        # 150 hits sharing ONE timestamp: the page boundary falls inside the
        # group; the unique [ts, shard_doc] sort tuple must carry across it
        ts = "2026-09-02T12:00:00.000"
        es = StubEs([make_hit(i, ts=ts) for i in range(150)])
        hits, last_ts, saturated = fetch_new_events(es, "a", "b")
        self.assertEqual(len(hits), 150, "no loss at the equal-timestamp page boundary")
        self.assertFalse(saturated)
        self.assertEqual(last_ts, ts)

    def test_page_cap_bounds_one_poll_and_reports_saturation(self):
        cap = EVENT_PAGE_SIZE * MAX_EVENT_PAGES_PER_POLL
        es = StubEs([make_hit(i) for i in range(cap + 500)])
        hits, last_ts, saturated = fetch_new_events(es, "a", "b")
        self.assertEqual(len(hits), cap)
        self.assertTrue(saturated)
        self.assertEqual(last_ts, es.hits[cap - 1]["_source"]["@timestamp"])
        self.assertEqual(len(es.calls), MAX_EVENT_PAGES_PER_POLL)

    def test_empty_window_returns_no_watermark(self):
        es = StubEs([])
        hits, last_ts, saturated = fetch_new_events(es, "a", "b")
        self.assertEqual(hits, [])
        self.assertIsNone(last_ts)
        self.assertFalse(saturated)

    def test_window_bounds_are_exclusive_start_inclusive_end(self):
        q = build_event_query("2026-09-02T12:00:00", "2026-09-02T12:00:30")
        rng = q["bool"]["filter"][0]["range"]["@timestamp"]
        self.assertEqual(rng, {"gt": "2026-09-02T12:00:00", "lte": "2026-09-02T12:00:30"})


class AdvanceWatermarkTest(unittest.TestCase):
    END = "2026-09-02T12:05:00"

    def test_idle_keeps_the_watermark(self):
        self.assertEqual(advance_watermark("w0", None, self.END, False), ("w0", "idle"))

    def test_unsaturated_moves_to_last_processed(self):
        self.assertEqual(
            advance_watermark("w0", "2026-09-02T12:04:59", self.END, False),
            ("2026-09-02T12:04:59", "current"))

    def test_saturated_within_lag_backs_off_and_catches_up(self):
        last = "2026-09-02T12:04:30"   # 30s behind, <= 60s
        self.assertEqual(advance_watermark("w0", last, self.END, True), (last, "backlog"))

    def test_sustained_overload_skips_to_window_end(self):
        last = "2026-09-02T12:03:00"   # 120s behind, > 60s
        self.assertEqual(advance_watermark("w0", last, self.END, True),
                         (self.END, "skipped"))

    def test_aware_es_timestamps_are_handled(self):
        last = "2026-09-02T12:04:30.500Z"   # tz-aware, 29.5s behind
        wm, action = advance_watermark("w0", last, self.END, True)
        self.assertEqual((wm, action), (last, "backlog"))

    def test_lag_boundary_is_exclusive(self):
        last = "2026-09-02T12:04:00"   # exactly MAX_WATERMARK_LAG_S behind
        self.assertEqual(advance_watermark("w0", last, self.END, True,
                                           max_lag_s=MAX_WATERMARK_LAG_S)[1], "backlog")


if __name__ == "__main__":
    unittest.main()
