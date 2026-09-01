#!/usr/bin/python3

"""
Original code (tornado based) by Matthew May - mcmay.web@gmail.com
Adjusted code for asyncio, aiohttp and redis (asynchronous support) by t3chn0m4g3
"""

import argparse
import asyncio
import json
import time

import redis.asyncio as redis
from aiohttp import web

from demo_events import DEMO_BANNER, DemoEventGenerator, add_demo_arguments

# Configuration defaults (override via CLI flags, HANDOFF-v2 D21)
DEFAULT_REDIS_URL = 'redis://map_redis:6379'
DEFAULT_WEB_PORT = 64299
version = 'Attack Map Server 3.0.1'

redis_url = DEFAULT_REDIS_URL


@web.middleware
async def mjs_content_type(request, handler):
    # D31 — the .mjs MIME guarantee. Public API only: FileResponse.prepare() guesses
    # the type only when Content-Type is not already set (aiohttp 3.14.3
    # web_fileresponse.py:385), and its guesser is a module-private MimeTypes()
    # instance that mimetypes.add_type() never reaches (line 52). Do not touch
    # aiohttp internals.
    resp = await handler(request)
    if request.path.endswith(".mjs") and isinstance(resp, web.FileResponse):
        resp.content_type = "text/javascript"
    return resp


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
                        # Process all connected websockets in parallel
                        await asyncio.gather(*[ws.send_str(json_data) for ws in websockets], return_exceptions=True)
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
        data = json.dumps(message)
        await asyncio.gather(*[ws.send_str(data) for ws in websockets], return_exceptions=True)

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
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    request.app['websockets'].append(ws)
    print(f"[*] New WebSocket connection opened. Clients active: {len(request.app['websockets'])}")
    async for msg in ws:
        if msg.type == web.WSMsgType.TEXT:
            await ws.send_str(msg.data)
        elif msg.type == web.WSMsgType.ERROR:
            print(f'WebSocket connection closed with exception {ws.exception()}')
    request.app['websockets'].remove(ws)
    print(f"[-] WebSocket connection closed. Clients active: {len(request.app['websockets'])}")
    return ws

async def my_index_handler(request):
    return web.FileResponse('static/index.html')

async def my_poc_handler(request):
    # TEMPORARY (WP4 PoC gate only, removed with static/poc.html): serves the
    # PoC at the real base directory '/', mirroring production's '/map/' via
    # nginx — static/poc.html at /map/static/poc.html would have the wrong
    # base directory (HANDOFF-v2 §11 WP4).
    return web.FileResponse('static/poc.html')

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
    app = web.Application(middlewares=[mjs_content_type])
    app['args'] = args
    app.add_routes([
        web.get('/', my_index_handler),
        web.get('/poc.html', my_poc_handler),  # TEMPORARY — WP4 PoC gate
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
    web.run_app(make_webapp(cli_args), port=cli_args.port)
