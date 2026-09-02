# Deterministic ES event polling (security review 2026-09-02): sorted,
# search_after-paged, bounded per tick; watermark = last processed event.
import unittest

from DataServer import (
    EVENT_PAGE_SIZE,
    MAX_EVENT_PAGES_PER_POLL,
    build_event_query,
    fetch_new_events,
)


def make_hit(i):
    ts = f"2026-09-02T12:00:{i // 1000:02d}.{i % 1000:03d}"
    return {"_source": {"@timestamp": ts}, "sort": [i]}


class StubEs:
    """Serves a fixed, ordered hit list the way ES would: sorted pages of
    `size`, continuing after the `search_after` cursor."""

    def __init__(self, hits):
        self.hits = hits
        self.calls = []

    def search(self, **kwargs):
        self.calls.append(kwargs)
        start = 0
        if "search_after" in kwargs:
            cursor = kwargs["search_after"][0]
            start = next(i for i, h in enumerate(self.hits) if h["sort"][0] > cursor)
        page = self.hits[start:start + kwargs["size"]]
        return {"hits": {"hits": page}}


class FetchNewEventsTest(unittest.TestCase):
    def test_all_hits_beyond_one_page_are_returned(self):
        es = StubEs([make_hit(i) for i in range(250)])
        hits, last_ts, saturated = fetch_new_events(es, "2026-09-02T11:59:00", "2026-09-02T12:01:00")
        self.assertEqual(len(hits), 250)
        self.assertFalse(saturated)
        self.assertEqual(last_ts, es.hits[-1]["_source"]["@timestamp"])
        # three pages: 100 + 100 + 50, cursors handed forward
        self.assertEqual(len(es.calls), 3)
        self.assertNotIn("search_after", es.calls[0])
        self.assertEqual(es.calls[1]["search_after"], [99])
        self.assertEqual(es.calls[2]["search_after"], [199])

    def test_every_page_is_sorted_by_timestamp(self):
        es = StubEs([make_hit(i) for i in range(5)])
        fetch_new_events(es, "a", "b")
        for call in es.calls:
            self.assertEqual(call["sort"], [{"@timestamp": "asc"}])
            self.assertEqual(call["size"], EVENT_PAGE_SIZE)

    def test_page_cap_bounds_one_poll_and_reports_saturation(self):
        cap = EVENT_PAGE_SIZE * MAX_EVENT_PAGES_PER_POLL
        es = StubEs([make_hit(i) for i in range(cap + 500)])
        hits, last_ts, saturated = fetch_new_events(es, "a", "b")
        self.assertEqual(len(hits), cap)
        self.assertTrue(saturated)
        # watermark points at the LAST PROCESSED event, so the next poll
        # resumes exactly there — nothing is silently skipped
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


if __name__ == "__main__":
    unittest.main()
