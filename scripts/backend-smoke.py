"""Exercise the Bun CLI against an unchanged Python BAAS service in a temporary root.

The real routers, signing/password authentication, ConfigManager, provider and pipe
server are used. ServiceContext.startup() is intentionally skipped, so this never
initializes OCR, ADB, emulators, game tasks or the user's backend configuration.

Run from the repository root with the service's Python dependencies installed:
    python scripts/backend-smoke.py --backend-path ../baas-dev
Build the CLI first with `bun run cli:build`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import queue
import secrets
import signal
import socket
import sys
import tempfile
import threading
from types import SimpleNamespace
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-path", "--backend", dest="backend", type=Path, required=True)
    parser.add_argument("--cli-path", type=Path, help="Bun CLI entry or compiled executable; defaults to cli/bin/baax.mjs")
    parser.add_argument("--bun", default="bun")
    return parser.parse_args()


async def run(args) -> None:
    backend = args.backend.resolve()
    if not (backend / "service" / "app.py").is_file():
        raise RuntimeError("--backend must point to a BAAS service checkout")
    root = Path(__file__).resolve().parents[1]
    entry = args.cli_path.resolve() if args.cli_path else root / "cli" / "bin" / "baax.mjs"
    if not args.cli_path and not (root / "cli" / "dist" / "baax.js").is_file():
        raise RuntimeError("Build the CLI first: bun run cli:build")
    if not entry.is_file():
        raise RuntimeError("CLI entry does not exist")
    sys.path.insert(0, str(backend))
    for name in ["BAAS_ANDROID", "BAAS_SERVICE_SIGN_SEED_B64", "BAAS_SERVICE_TICKET_KEY_B64"]:
        os.environ.pop(name, None)

    import uvicorn
    from service.app import app
    from service.api.state import context
    from service.context import ServiceContext
    from service.transport.pipe_server import PipeTransportServer

    with tempfile.TemporaryDirectory(prefix="baas-cli-real-service-") as temporary:
        fixture_root = Path(temporary)
        profile_root = fixture_root / "config" / "alpha"
        profile_root.mkdir(parents=True)
        (profile_root / "config.json").write_text(json.dumps({
            "name": "CLI compatibility fixture", "server": "官服",
            "control_method": "ADB", "autostart": False,
        }, ensure_ascii=False), encoding="utf-8")
        (profile_root / "event.json").write_text(json.dumps([{
            "func_name": "arena", "event_name": "竞技场", "enabled": True,
            "priority": 1, "interval": 3600, "next_tick": 0,
            "daily_reset": [], "disabled_time_range": [], "pre_task": [], "post_task": [],
        }, {
            "func_name": "fixture_failure", "event_name": "Fixture failure", "enabled": True,
            "priority": 2, "interval": 3600, "next_tick": 0,
            "daily_reset": [], "disabled_time_range": [], "pre_task": [], "post_task": [],
        }], ensure_ascii=False), encoding="utf-8")

        # This replaces only the lazy service dependency in this isolated process.
        service_context = ServiceContext(fixture_root)
        context._context = service_context
        loop = asyncio.get_running_loop()
        service_context.config_manager.set_loop(loop)
        service_context.runtime.set_loop(loop)
        service_context.log_manager.set_loop(loop)
        service_context.runtime._statuses["alpha"] = {"running": False, "current_task": None}
        stop_worker = threading.Event()

        class IsolatedWorker:
            # Device work is a fixture; the real service owns all threading,
            # Trigger dispatch, run identities, provider updates and completion.
            logger = SimpleNamespace(log_collector=queue.Queue())
            flag_run = True
            scheduler = SimpleNamespace(event_map={"arena": "竞技场"}, update_signal=None)

            def init_all_data(self):
                self.flag_run = True
                return True

            def send(self, message, task=None):
                if message == "stop":
                    self.flag_run = False
                    stop_worker.set()
                    return None
                stop_worker.clear()
                stop_worker.wait(timeout=0.2)
                return task != "fixture_failure"

        service_context.runtime._sessions["alpha"] = SimpleNamespace(
            config_id="alpha", baas=IsolatedWorker(), thread=None, run_id=None,
        )
        password = secrets.token_urlsafe(24)
        service_context.auth_manager.initialize_password(password)
        service_context.log_manager._history_all.append({
            "scope": "config:alpha", "time": "2026-10-29T00:00:00+00:00",
            "level": "INFO", "message": "Isolated real service fixture ready",
        })

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, lifespan="off", log_level="error",
            access_log=False, ws="websockets",
        ))
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        pipe_name = str(fixture_root / "service.sock") if os.name != "nt" else rf"\\.\pipe\baas-cli-smoke-{os.getpid()}"
        pipe_server = PipeTransportServer(pipe_name, service_context)
        await pipe_server.start()
        environment = {**os.environ, "BAAS_KEY": password}
        # Remove inherited connection choices so the fixture is fully isolated.
        for name in ["BAAS_SERVER", "BAAS_PIPE", "BAAS_PROFILE", "BAAS_SERVER_SIGN_PUBLIC_KEY"]:
            environment.pop(name, None)

        async def cli(*arguments: str, pipe=False, expected_exit=0):
            connection = ["--pipe", pipe_name] if pipe else ["--server", f"ws://127.0.0.1:{port}"]
            process = await asyncio.create_subprocess_exec(
                *([args.bun, str(entry)] if entry.suffix in {".ts", ".js", ".mjs", ".cjs"} else [str(entry)]),
                "--json", "--config-home", str(fixture_root / "cli"),
                *connection, *arguments, cwd=str(root), env=environment,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
            if process.returncode != expected_exit:
                raise RuntimeError(f"CLI command {arguments!r} failed: {stderr.decode(errors='replace')}")
            try:
                return json.loads(stdout)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"CLI JSON output was polluted for {arguments!r}") from exc

        try:
            for _ in range(500):
                if server.started:
                    break
                if server_task.done():
                    await server_task
                    raise RuntimeError("Service did not start")
                await asyncio.sleep(0.01)
            else:
                raise RuntimeError("Service startup timed out")

            for pipe in [False, True]:
                transport = "pipe" if pipe else "encrypted-websocket"
                profiles = await cli("profiles", pipe=pipe)
                assert profiles == {"alpha": "CLI compatibility fixture"}, profiles
                tasks = await cli("--profile", "alpha", "tasks", pipe=pipe)
                assert tasks["arena"]["event_name"] == "竞技场", tasks
                status = await cli("status", pipe=pipe)
                assert status["alpha"]["running"] is False, status
                name = await cli("--profile", "alpha", "config", "get", "/name", pipe=pipe)
                assert name == "CLI compatibility fixture", name
                logs = await cli("--profile", "alpha", "logs", "5", pipe=pipe)
                assert logs[-1]["message"] == "Isolated real service fixture ready", logs
                print(f"PASS {transport}: profiles, task descriptors, runtime status, configuration read, provider logs")

            await cli("--profile", "alpha", "--yes", "config", "set", "/autostart", "true")
            saved = json.loads((profile_root / "config.json").read_text(encoding="utf-8"))
            assert saved["autostart"] is True, saved
            print("PASS encrypted-websocket: acknowledged configuration patch persisted in isolated root")

            successful = await cli("--profile", "alpha", "--yes", "run", "arena", "--wait", "--wait-timeout", "2")
            assert successful["completed"] is True and successful["succeeded"] is True, successful
            assert successful["run_id"] == successful["status"]["run_id"], successful
            failed = await cli("--profile", "alpha", "--yes", "run", "fixture_failure", "--wait", "--wait-timeout", "2", expected_exit=1)
            assert failed["completed"] is True and failed["succeeded"] is False, failed
            assert failed["status"]["exit_code"] == 1 and failed["run_id"] != successful["run_id"], failed
            print("PASS Bun CLI --wait: correlated successful completion exits0 and failed completion exits1")

            for command, expected_type in [("watch", "run-status"), ("logs", "live-log")]:
                arguments = ["--follow"] if command == "logs" else []
                process = await asyncio.create_subprocess_exec(
                    *([args.bun, str(entry)] if entry.suffix in {".ts", ".js", ".mjs", ".cjs"} else [str(entry)]),
                    "--json", "--config-home", str(fixture_root / "cli"),
                    "--server", f"ws://127.0.0.1:{port}", "--profile", "alpha", command, *arguments,
                    cwd=str(root), env=environment, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                first = await asyncio.wait_for(process.stdout.readline(), timeout=10)
                assert json.loads(first)["type"] == expected_type, first
                process.send_signal(signal.SIGINT)
                remaining, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
                assert process.returncode == 130, (process.returncode, stderr.decode(errors="replace"))
                for line in remaining.splitlines():
                    json.loads(line)
                print(f"PASS Bun CLI {command}: JSON event stream and SIGINT cleanup exits130")

            probe = root / "packages" / "baas-client" / "tests" / "lifecycle-probe.ts"
            for pipe in [False, True]:
                probe_environment = {**environment, "BAAS_SMOKE_ISOLATED": "1", "BAAS_SMOKE_URL": f"ws://127.0.0.1:{port}"}
                if pipe:
                    probe_environment["BAAS_SMOKE_PIPE"] = pipe_name
                process = await asyncio.create_subprocess_exec(
                    args.bun, str(probe), cwd=str(root), env=probe_environment,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
                if process.returncode:
                    raise RuntimeError(f"Lifecycle compatibility probe failed: {stderr.decode(errors='replace')}")
                result = json.loads(stdout)
                assert result["success"]["exit_code"] == 0
                assert result["failure"]["exit_code"] == 1
                assert result["stop"]["running"] is False
                print(f"PASS {'pipe' if pipe else 'encrypted-websocket'}: accepted run identity, busy identity, success/failure/stop correlation and provider subscriptions")
        finally:
            await pipe_server.close()
            server.should_exit = True
            await asyncio.wait_for(server_task, timeout=10)
            listener.close()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
