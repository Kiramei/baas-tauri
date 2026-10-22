"""Serve the production auth/provider/sync routes without creating a game runtime."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
from types import SimpleNamespace


source, bundle, cache = map(lambda value: Path(value).resolve(), sys.argv[1:4])
assert source.is_dir() and bundle.is_file() and cache.is_dir()
sys.path.insert(0, str(source))

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from service.api import http, security, ws_control, ws_provider, ws_sync
from service.auth import ServiceAuthManager
from service.conf.manager import ConfigManager


class FixtureLogs:
    async def subscribe(self):
        return asyncio.Queue()

    def get_history(self):
        return []

    def get_scopes(self):
        return ["fixture"]

    def unsubscribe(self, queue):
        pass


class FixtureRuntime:
    is_all_data_initialized = True

    def current_status(self):
        return {"fixture": {"running": False}, "is_all_data_initialized": True}

    async def subscribe_status(self):
        return asyncio.Queue()

    def unsubscribe_status(self, queue):
        pass


def loaded_sources():
    records = {}
    for module in tuple(sys.modules.values()):
        filename = getattr(module, "__file__", None)
        if not filename:
            continue
        path = Path(filename).resolve()
        if path.suffix == ".py" and path.is_relative_to(source):
            records[path.relative_to(source).as_posix()] = hashlib.sha256(
                path.read_bytes().replace(b"\r\n", b"\n")
            ).hexdigest()
    return records


with tempfile.TemporaryDirectory(prefix="service-protocol-", dir=cache) as temporary:
    root = Path(temporary)
    profile = root / "config" / "fixture"
    profile.mkdir(parents=True)
    (profile / "config.json").write_text(json.dumps({"name": "Protocol Demo", "value": 1}), encoding="utf-8")
    (profile / "event.json").write_text("[]", encoding="utf-8")
    context = SimpleNamespace(
        project_root=root,
        auth_manager=ServiceAuthManager(root),
        config_manager=ConfigManager(root),
        runtime=FixtureRuntime(),
        log_manager=FixtureLogs(),
    )
    for module in (http, security, ws_control, ws_provider, ws_sync):
        module.context = context
    @asynccontextmanager
    async def lifespan(app):
        context.config_manager.set_loop(asyncio.get_running_loop())
        yield

    app = FastAPI(lifespan=lifespan)
    # Deliberately exclude system-log, Android, Trigger and Remote routes.
    app.router.routes.extend(route for route in http.router.routes if route.path in {
        "/health", "/auth/remember", "/auth/logout"
    })
    for router in (ws_control.router, ws_provider.router, ws_sync.router):
        app.include_router(router)

    @app.get("/")
    async def index():
        return HTMLResponse("<!doctype html><html><head><title>Protocol fixture</title></head><body></body></html>")

    @app.get("/probe.js")
    async def javascript():
        return FileResponse(bundle, media_type="text/javascript")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False))

    def stop_on_input():
        sys.stdin.readline()
        server.should_exit = True

    threading.Thread(target=stop_on_input, daemon=True).start()
    print(json.dumps({
        "port": port,
        "pid": os.getpid(),
        "temporaryDirectory": root.name,
        "sources": loaded_sources(),
        "packages": {name: metadata.version(name) for name in ("cryptography", "PyNaCl", "fastapi", "uvicorn", "pydantic")},
    }), flush=True)
    try:
        server.run(sockets=[sock])
    finally:
        sock.close()
