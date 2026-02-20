#!/usr/bin/python3

"""
Original code (tornado based) by Matthew May - mcmay.web@gmail.com
Adjusted code for asyncio, aiohttp and redis (asynchronous support) by t3chn0m4g3
"""

import asyncio
import json

import valkey.asyncio as valkey
from aiohttp import web

import config as _config
cfg = _config.load()

valkey_url = f"valkey://{cfg['valkey']['host']}:{cfg['valkey']['port']}"
valkey_channel = cfg['valkey']['channel']
web_port = cfg['server']['web_port']
version = 'Attack Map Server 3.0.0'



async def valkey_subscriber(websockets):
    was_disconnected = False
    while True:
        try:
            # Create a Valkey connection
            r = valkey.Valkey.from_url(valkey_url)
            # Get the pubsub object for channel subscription
            pubsub = r.pubsub()
            await pubsub.subscribe(valkey_channel)
            
            # Print reconnection message if we were previously disconnected
            if was_disconnected:
                print("[*] Valkey connection re-established")
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
        except valkey.ValkeyError as e:
            print(f"[ ] Connection lost to Valkey ({type(e).__name__}), retrying...")
            was_disconnected = True
            await asyncio.sleep(5)

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

async def start_background_tasks(app):
    app['websockets'] = []
    app['valkey_subscriber'] = asyncio.create_task(valkey_subscriber(app['websockets']))

async def cleanup_background_tasks(app):
    app['valkey_subscriber'].cancel()
    await app['valkey_subscriber']

async def check_valkey_connection():
    """Check Valkey connection on startup and wait until available."""
    print("[*] Checking Valkey connection...")
    waiting_printed = False
    
    while True:
        try:
            r = valkey.Valkey.from_url(valkey_url)
            await r.ping()  # Simple connection test
            await r.aclose()  # Clean up test connection
            print("[*] Valkey connection established")
            return True
        except Exception as e:
            if not waiting_printed:
                print(f"[...] Waiting for Valkey... (Error: {type(e).__name__})")
                waiting_printed = True
            await asyncio.sleep(5)

async def make_webapp():
    app = web.Application()
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

if __name__ == '__main__':
    print(version)
    # Check Valkey connection on startup
    asyncio.run(check_valkey_connection())
    print("[*] Starting web server...\n")
    web.run_app(make_webapp(), port=web_port)
    