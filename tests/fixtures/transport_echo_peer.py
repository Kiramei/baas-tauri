"""One isolated Python process serving the three Linux transport probes.

SHM and Pipe use the production backend servers and endpoint implementations.
WebSocket is a loopback RFC 6455 baseline without compression or SecureWS
encryption. It deliberately does not claim to represent the product WS path.
Only EchoHandler runs; no BAAS, device, OCR, or emulator is initialized.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import platform
import signal
import socket
import sys
from pathlib import Path
from types import SimpleNamespace


class EchoHandler:
    def __init__(self, context) -> None:
        pass

    async def handle(self, endpoint) -> None:
        while True:
            plan = await endpoint.recv_json()
            if plan.get("operation") == "close":
                return
            kind = plan["kind"]
            for _ in range(int(plan["count"])):
                if kind == "json":
                    await endpoint.send_json(await endpoint.recv_json())
                elif kind == "bytes":
                    await endpoint.send_bytes(await endpoint.recv_bytes())
                else:
                    raise ValueError(f"Unsupported echo kind: {kind}")


class PlainWebSocketEndpoint:
    def __init__(self, connection) -> None:
        self.connection = connection

    async def recv_json(self):
        return json.loads((await self.recv_bytes()).decode("utf-8"))

    async def recv_bytes(self) -> bytes:
        packet = await self.connection.recv()
        if not isinstance(packet, bytes):
            raise TypeError("The probe uses binary WebSocket messages")
        return packet

    async def send_json(self, payload) -> None:
        await self.send_bytes(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    async def send_bytes(self, payload: bytes) -> None:
        await self.connection.send(payload)


async def run(options) -> None:
    sys.path.insert(0, str(Path(options.backend).resolve()))
    from service.transport.pipe_server import PipeTransportServer, _HANDLERS
    from service.transport.shm_server import SharedMemoryTransportServer
    from websockets.legacy.server import serve
    import websockets

    _HANDLERS["echo"] = EchoHandler
    context = SimpleNamespace()
    shm = SharedMemoryTransportServer(options.shm_name, context)
    pipe = PipeTransportServer(options.pipe_name, context)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for item in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(item, stopped.set)

    async def websocket_echo(connection, path) -> None:
        connection.transport.get_extra_info("socket").setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        endpoint = PlainWebSocketEndpoint(connection)
        try:
            request = await endpoint.recv_json()
            if request.get("type") != "open" or request.get("channel") != "echo":
                raise ValueError("Expected an echo open request")
            await endpoint.send_json({"type": "open_ok", "channel": "echo"})
            await EchoHandler(context).handle(endpoint)
        except websockets.exceptions.ConnectionClosed:
            pass

    try:
        await shm.start()
        await pipe.start()
        async with serve(websocket_echo, "127.0.0.1", 0, compression=None,
                         ping_interval=None, max_size=64 * 1024 * 1024,
                         close_timeout=1) as server:
            print(json.dumps({"ready": True, "python": sys.version, "pythonExecutable": sys.executable,
                              "websockets": websockets.__version__, "pid": os.getpid(),
                              "platform": platform.platform(), "wsPort": server.sockets[0].getsockname()[1],
                              "handler": "one shared EchoHandler, identical JSON parse/dump and binary echo",
                              "websocket": "plain RFC6455 binary messages, compression=None, no SecureWS encryption"}),
                  flush=True)
            await stopped.wait()
    finally:
        with contextlib.suppress(Exception):
            await pipe.close()
        with contextlib.suppress(Exception):
            await shm.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--shm-name", required=True)
    parser.add_argument("--pipe-name", required=True)
    asyncio.run(run(parser.parse_args()))
