import unittest
from unittest.mock import patch, MagicMock, ANY
import sys
import os
import datetime

# Add parent directory to path to import DataServer
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import DataServer

class StopLoop(Exception):
    """Exception to break the infinite loop in tests"""
    pass

class TestDataServerTiming(unittest.TestCase):
    
    def setUp(self):
        # Base time for tests
        self.start_time = datetime.datetime(2023, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        self.current_time = self.start_time

    def _fake_now(self, tz=None):
        # Ignore tz argument for simplicity, or handle if needed
        return self.current_time

    def _fake_sleep(self, seconds):
        # Advance time when sleep is called
        self.current_time += datetime.timedelta(seconds=seconds)
        # Raise exception to stop loop after some time
        if (self.current_time - self.start_time).total_seconds() > 12:
            raise StopLoop("Test finished")

    @patch('DataServer.es')
    @patch('DataServer.connect_valkey')
    @patch('DataServer.time.sleep')
    @patch('DataServer.datetime')
    def test_update_honeypot_data_timing(self, mock_datetime_module, mock_sleep, mock_connect_valkey, mock_es):
        """
        Test that:
        1. Stats are collected initially (due to -10s offset).
        2. Stats are NOT collected in subsequent immediate loops.
        3. Stats ARE collected again after 10 seconds.
        4. Events are collected every loop.
        """
        
        # Setup mocks
        mock_valkey = MagicMock()
        mock_connect_valkey.return_value = mock_valkey
        
        # Mock datetime.datetime.now to return our controlled time
        # We need to mock the class datetime.datetime, but keep timedelta working
        mock_datetime_class = MagicMock()
        mock_datetime_class.now.side_effect = self._fake_now
        mock_datetime_class.UTC = datetime.timezone.utc
        
        # We need to ensure datetime.timedelta is the real one because it's used in the code
        mock_datetime_module.datetime = mock_datetime_class
        mock_datetime_module.timedelta = datetime.timedelta
        mock_datetime_module.timezone = datetime.timezone
        mock_datetime_module.UTC = datetime.timezone.utc
        
        # Mock sleep to advance time
        mock_sleep.side_effect = self._fake_sleep
        
        # Mock ES search to return empty hits to avoid processing logic complexity
        mock_es.search.return_value = {'hits': {'total': {'value': 0}, 'hits': []}}

        # Run the function
        try:
            DataServer.update_honeypot_data()
        except StopLoop:
            pass

        # Verification
        
        # 1. Verify ES search calls
        # We expect stats calls (size=0) and event calls (size=100)
        
        # Filter calls by size argument
        stats_calls = [call for call in mock_es.search.call_args_list if call.kwargs.get('size') == 0]
        event_calls = [call for call in mock_es.search.call_args_list if call.kwargs.get('size') == 100]
        
        # Analysis of time progression:
        # Start: T0
        # Init: last_stats_time = T0 - 10s
        # Loop 1: T0. (T0 - (T0-10)) = 10s >= 10s. Stats fetch! last_stats_time = T0.
        #         Sleep 0.5s. Time -> T0 + 0.5s.
        # Loop 2: T0 + 0.5s. Diff = 0.5s. No stats.
        #         Sleep 0.5s. Time -> T0 + 1.0s.
        # ...
        # Loop 21: T0 + 10.0s. Diff = 10.0s. Stats fetch! last_stats_time = T0 + 10.0s.
        #         Sleep 0.5s. Time -> T0 + 10.5s.
        # ...
        # Loop ends when time > T0 + 12s.
        
        # So we expect stats calls at T0 and T0+10s. Total 2 updates.
        # Each update calls es.search 3 times (for 1m, 1h, 24h).
        # So total stats calls = 2 * 3 = 6.
        
        print(f"Stats calls: {len(stats_calls)}")
        print(f"Event calls: {len(event_calls)}")
        
        self.assertGreaterEqual(len(stats_calls), 6, "Should have fetched stats at least twice (initially and after 10s) * 3 queries")
        self.assertLess(len(stats_calls), 9, "Should not have fetched stats too many times")
        
        self.assertGreater(len(event_calls), 20, "Should have fetched events roughly every 0.5s")

        # Verify that stats calls are for the correct indices/types
        # Just checking one call args to be sure
        self.assertEqual(stats_calls[0].kwargs['index'], "logstash-*")
        
        # Verify that we are using the new datetime logic (checking if datetime.now was called)
        self.assertTrue(mock_datetime_class.now.called)

if __name__ == '__main__':
    unittest.main()
