# WebSocket hardening and security headers (security review 2026-09-02):
# origin check (CSWSH), connection limit, no echo, slow-consumer isolation,
# and the header middleware.
import asyncio
import unittest

import aiohttp
from aiohttp.test_utils import AioHTTPTestCase

import AttackMapServer
from AttackMapServer import broadcast, make_webapp, parse_args


def demo_args():
    return parse_args(['--demo', '--demo-rate', '0.001'])


class WebSocketHardeningTest(AioHTTPTestCase):
    async def get_application(self):
        return await make_webapp(demo_args())

    def ws_headers(self, origin):
        h = {}
        if origin is not None:
            h['Origin'] = origin
        return h

    async def test_mismatching_origin_is_rejected(self):
        with self.assertRaises(aiohttp.WSServerHandshakeError) as ctx:
            await self.client.ws_connect(
                '/websocket', headers=self.ws_headers('https://evil.example'))
        self.assertEqual(ctx.exception.status, 403)

    async def test_matching_origin_is_accepted(self):
        host = self.client.host
        port = self.client.port
        ws = await self.client.ws_connect(
            '/websocket', headers=self.ws_headers(f'http://{host}:{port}'))
        self.assertFalse(ws.closed)
        await ws.close()

    async def test_missing_origin_is_accepted(self):
        # non-browser clients (curl, monitoring) carry no Origin header;
        # authentication is the reverse proxy's job
        ws = await self.client.ws_connect('/websocket')
        self.assertFalse(ws.closed)
        await ws.close()

    async def test_incoming_text_is_not_echoed(self):
        ws = await self.client.ws_connect('/websocket')
        await ws.send_str('hello?')
        with self.assertRaises(asyncio.TimeoutError):
            await ws.receive(timeout=0.5)
        await ws.close()

    async def test_connection_limit(self):
        old = AttackMapServer.MAX_WS_CLIENTS
        AttackMapServer.MAX_WS_CLIENTS = 2
        try:
            ws1 = await self.client.ws_connect('/websocket')
            ws2 = await self.client.ws_connect('/websocket')
            with self.assertRaises(aiohttp.WSServerHandshakeError) as ctx:
                await self.client.ws_connect('/websocket')
            self.assertEqual(ctx.exception.status, 503)
            await ws1.close()
            await ws2.close()
        finally:
            AttackMapServer.MAX_WS_CLIENTS = old

    async def test_security_headers_on_index_and_static(self):
        for path in ('/', '/static/map.js'):
            resp = await self.client.get(path)
            self.assertEqual(resp.status, 200, path)
            csp = resp.headers.get('Content-Security-Policy', '')
            self.assertIn("default-src 'self'", csp, path)
            self.assertIn("frame-ancestors 'self'", csp, path)
            self.assertEqual(resp.headers.get('X-Content-Type-Options'), 'nosniff', path)
            self.assertEqual(resp.headers.get('Referrer-Policy'), 'no-referrer', path)
            await resp.release()

    async def test_csp_header_matches_meta_tag(self):
        # the header is read from index.html at import time — no drift possible
        resp = await self.client.get('/')
        body = await resp.text()
        self.assertIn(AttackMapServer.CSP_HEADER, body)
        self.assertTrue(resp.headers['Content-Security-Policy']
                        .startswith(AttackMapServer.CSP_HEADER))


class FakeWs:
    def __init__(self, hang=False):
        self.hang = hang
        self.sent = []
        self.closed = False

    async def send_str(self, data):
        if self.hang:
            await asyncio.sleep(3600)
        self.sent.append(data)

    async def close(self):
        self.closed = True


class BroadcastTest(unittest.IsolatedAsyncioTestCase):
    async def test_slow_consumer_is_dropped_others_receive(self):
        old = AttackMapServer.WS_SEND_TIMEOUT_S
        AttackMapServer.WS_SEND_TIMEOUT_S = 0.1
        try:
            good1, slow, good2 = FakeWs(), FakeWs(hang=True), FakeWs()
            clients = [good1, slow, good2]
            await broadcast(clients, 'msg')
            self.assertEqual(good1.sent, ['msg'])
            self.assertEqual(good2.sent, ['msg'])
            self.assertNotIn(slow, clients, 'slow consumer removed')
            self.assertTrue(slow.closed)
            self.assertEqual(clients, [good1, good2])
        finally:
            AttackMapServer.WS_SEND_TIMEOUT_S = old

    async def test_broadcast_tolerates_failing_close(self):
        class Broken(FakeWs):
            async def send_str(self, data):
                raise ConnectionResetError()

            async def close(self):
                raise RuntimeError('already gone')

        clients = [Broken(), FakeWs()]
        await broadcast(clients, 'msg')
        self.assertEqual(len(clients), 1)
        self.assertEqual(clients[0].sent, ['msg'])


if __name__ == '__main__':
    unittest.main()
