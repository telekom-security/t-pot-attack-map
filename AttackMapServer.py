#!/usr/bin/python3

"""
Original code (tornado based) by Matthew May - mcmay.web@gmail.com
Adjusted code for asyncio, aiohttp and redis (asynchronous support) by t3chn0m4g3
"""

import argparse
import asyncio
import json
import re
import time
from urllib.parse import urlparse

import redis.asyncio as redis
from aiohttp import web

from demo_events import DEMO_BANNER, DemoEventGenerator, add_demo_arguments

# Configuration defaults (override via CLI flags, HANDOFF-v2 D21)
DEFAULT_REDIS_URL = 'redis://map_redis:6379'
DEFAULT_WEB_HOST = '127.0.0.1'   # loopback by default; containers pass --host 0.0.0.0
DEFAULT_WEB_PORT = 64299

# WebSocket hardening (security review 2026-09-02): authentication is the
# reverse proxy's job (T-Pot nginx, TLS + basic auth), but the origin check
# must live here — browsers attach cached credentials to cross-site WebSocket
# handshakes and WebSockets are not subject to CORS, so without it any website
# open in an operator's browser could read the live attack feed (CSWSH).
MAX_WS_CLIENTS = 64
WS_MAX_MSG_SIZE = 64 * 1024
WS_HEARTBEAT_S = 30
WS_SEND_TIMEOUT_S = 5

version = 'Attack Map Server 4.0.0'

redis_url = DEFAULT_REDIS_URL


def read_csp_from_index(path='static/index.html'):
    """The <meta> CSP in index.html is the single source of truth; the HTTP
    header mirrors it (plus frame-ancestors, which meta CSP cannot express)."""
    try:
        with open(path, encoding='utf-8') as fh:
            head = fh.read(8192)
        m = re.search(
            r'http-equiv="Content-Security-Policy"\s+content="([^"]+)"', head)
        if m:
            return m.group(1)
    except OSError:
        pass
    return None


CSP_HEADER = read_csp_from_index()


@web.middleware
async def security_headers(request, handler):
    # D31 — the .mjs MIME guarantee. Public API only: FileResponse.prepare() guesses
    # the type only when Content-Type is not already set (aiohttp 3.14.3
    # web_fileresponse.py:385), and its guesser is a module-private MimeTypes()
    # instance that mimetypes.add_type() never reaches (line 52). Do not touch
    # aiohttp internals.
    resp = await handler(request)
    if request.path.endswith(".mjs") and isinstance(resp, web.FileResponse):
        resp.content_type = "text/javascript"
    # Security headers (2026-09-02): the CSP header mirrors the meta tag
    # (header AND meta are enforced as an intersection — identical policies,
    # plus frame-ancestors which only works as a header). 'self' instead of
    # 'none' so same-origin embedding behind T-Pot's nginx stays possible.
    if CSP_HEADER:
        resp.headers.setdefault('Content-Security-Policy',
                                CSP_HEADER + "; frame-ancestors 'self'")
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('Referrer-Policy', 'no-referrer')
    return resp


async def broadcast(websockets, data):
    """Send one message to every connected client, isolating slow consumers:
    a client that cannot take the message within WS_SEND_TIMEOUT_S (stuck TCP,
    dead proxy connection) is closed and dropped instead of stalling the
    broadcast loop for everyone (the old bare gather() awaited the slowest
    client each tick, with nginx read timeouts of two hours)."""
    async def send_one(ws):
        try:
            await asyncio.wait_for(ws.send_str(data), timeout=WS_SEND_TIMEOUT_S)
            return None
        except Exception:
            return ws

    results = await asyncio.gather(*[send_one(ws) for ws in list(websockets)])
    for dead in filter(None, results):
        if dead in websockets:
            websockets.remove(dead)
        try:
            await asyncio.wait_for(dead.close(), timeout=1)
        except Exception:
            pass
        print(f"[-] Dropped unresponsive WebSocket client. Clients active: {len(websockets)}")


async def redis_subscriber(websockets):
    was_disconnected = False
    while True:
        try:
            # Create a Redis connection
            r = redis.Redis.from_url(redis_url)
            # Get the pubsub object for channel subscription
            pubsub = r.pubsub()
            # Subscribe to a Redis channel
            channel = "attack-map-production"
            await pubsub.subscribe(channel)

            # Print reconnection message if we were previously disconnected
            if was_disconnected:
                print("[*] Redis connection re-established")
                was_disconnected = False

            # Start a loop to listen for messages on the channel
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True)
                if message:
                    try:
                        # Only take the data and forward as JSON to the connected websocket clients
                        # Decode bytes directly instead of load/dump cycle
                        json_data = message['data'].decode('utf-8')
                        # Parallel send with slow-consumer isolation
                        await broadcast(websockets, json_data)
                    except:
                        print("Something went wrong while sending JSON data.")
                else:
                    await asyncio.sleep(0.1)
        except redis.RedisError as e:
            print(f"[ ] Connection lost to Redis ({type(e).__name__}), retrying...")
            was_disconnected = True
            await asyncio.sleep(5)


async def demo_publisher(websockets, args):
    """Demo mode (D20): synthetic events straight to the connected websockets.
    No Redis, no Elasticsearch. Banner at start and every 60 s; every message
    carries "demo": true."""
    generator = DemoEventGenerator(seed=args.demo_seed, scenario=args.demo_scenario)
    interval = 1.0 / args.demo_rate if args.demo_rate > 0 else 0.5
    if args.demo_scenario == "flood":
        interval = min(interval, 0.02)

    async def send(message):
        await broadcast(websockets, json.dumps(message))

    print(DEMO_BANNER)
    last_banner = time.monotonic()
    last_stats = time.monotonic()

    for _ in range(args.demo_burst):
        await send(generator.next_event())

    while True:
        await send(generator.next_event())
        now = time.monotonic()
        if now - last_stats >= 10:
            await send(generator.stats_message())
            last_stats = now
        if now - last_banner >= 60:
            print(DEMO_BANNER)
            last_banner = now
        await asyncio.sleep(interval)

async def my_websocket_handler(request):
    # CSWSH protection: a browser handshake carries an Origin header, and it
    # must match the host the request was addressed to. Non-browser clients
    # without an Origin stay allowed — authentication is the reverse proxy's
    # job, this check only stops foreign websites riding the browser session.
    origin = request.headers.get('Origin')
    if origin is not None:
        if urlparse(origin).netloc != request.headers.get('Host', ''):
            raise web.HTTPForbidden(text='WebSocket origin not allowed')

    if len(request.app['websockets']) >= MAX_WS_CLIENTS:
        raise web.HTTPServiceUnavailable(text='WebSocket client limit reached')

    ws = web.WebSocketResponse(max_msg_size=WS_MAX_MSG_SIZE, heartbeat=WS_HEARTBEAT_S)
    await ws.prepare(request)
    request.app['websockets'].append(ws)
    print(f"[*] New WebSocket connection opened. Clients active: {len(request.app['websockets'])}")
    try:
        async for msg in ws:
            # The feed is one-way: incoming frames are drained, never echoed
            # (the old echo served no client and only reflected input).
            if msg.type == web.WSMsgType.ERROR:
                print(f'WebSocket connection closed with exception {ws.exception()}')
    finally:
        if ws in request.app['websockets']:
            request.app['websockets'].remove(ws)
    print(f"[-] WebSocket connection closed. Clients active: {len(request.app['websockets'])}")
    return ws

async def my_index_handler(request):
    return web.FileResponse('static/index.html')

async def start_background_tasks(app):
    app['websockets'] = []
    args = app['args']
    if args is not None and args.demo:
        app['event_source'] = asyncio.create_task(demo_publisher(app['websockets'], args))
    else:
        app['event_source'] = asyncio.create_task(redis_subscriber(app['websockets']))

async def cleanup_background_tasks(app):
    app['event_source'].cancel()
    try:
        await app['event_source']
    except asyncio.CancelledError:
        pass

async def check_redis_connection():
    """Check Redis connection on startup and wait until available."""
    print("[*] Checking Redis connection...")
    waiting_printed = False

    while True:
        try:
            r = redis.Redis.from_url(redis_url)
            await r.ping()  # Simple connection test
            await r.aclose()  # Clean up test connection
            print("[*] Redis connection established")
            return True
        except Exception as e:
            if not waiting_printed:
                print(f"[...] Waiting for Redis... (Error: {type(e).__name__})")
                waiting_printed = True
            await asyncio.sleep(5)

async def make_webapp(args=None):
    app = web.Application(middlewares=[security_headers])
    app['args'] = args
    app.add_routes([
        web.get('/', my_index_handler),
        web.get('/websocket', my_websocket_handler),
        web.static('/static/', 'static'),
        web.static('/images/', 'static/images'),
        web.static('/flags/', 'static/flags')
    ])
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)
    return app


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=version)
    parser.add_argument('--host', default=DEFAULT_WEB_HOST,
                        help=f'listen address (default: {DEFAULT_WEB_HOST}; '
                             'containers pass --host 0.0.0.0 explicitly)')
    parser.add_argument('--port', type=int, default=DEFAULT_WEB_PORT,
                        help=f'web server port (default: {DEFAULT_WEB_PORT})')
    parser.add_argument('--redis-url', default=DEFAULT_REDIS_URL,
                        help=f'Redis URL (default: {DEFAULT_REDIS_URL})')
    parser.add_argument('--demo', action='store_true',
                        help='serve synthetic demo events — DEMO ONLY, never in production')
    add_demo_arguments(parser)
    return parser.parse_args(argv)


if __name__ == '__main__':
    cli_args = parse_args()
    redis_url = cli_args.redis_url
    print(version)
    if cli_args.demo:
        print("[!] Demo mode requested — no Redis required.")
    else:
        # Check Redis connection on startup
        asyncio.run(check_redis_connection())
    print("[*] Starting web server...\n")
    web.run_app(make_webapp(cli_args), host=cli_args.host, port=cli_args.port)
