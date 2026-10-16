"""Offline updater before/after benchmark; only creates temporary fixtures.

Usage: python scripts/benchmark-updater.py --uv C:/path/to/uv.exe --output result.json
All Git remotes and wheel downloads are local. No BAAS installation is changed.
"""

from __future__ import annotations

import argparse
import base64
import csv
import functools
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import zipfile


def run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(args, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.strip()}")


def timed(action) -> float:
    started = time.perf_counter()
    action()
    return (time.perf_counter() - started) * 1000


def git(path: Path, *args: str) -> None:
    run(["git", "-C", str(path), *args])


def commit(path: Path, message: str) -> None:
    git(path, "add", ".")
    git(path, "-c", "user.name=updater benchmark", "-c",
        "user.email=updater@example.invalid", "commit", "-qm", message)


def benchmark_git(root: Path, rounds: int) -> dict:
    source = root / "source"
    source.mkdir()
    git(source, "init", "-q", "-b", "master")
    git(source, "config", "core.autocrlf", "false")
    rng = random.Random(20261015)
    for index in range(96):
        (source / f"asset-{index:03}.bin").write_bytes(rng.randbytes(128 * 1024))
    commit(source, "initial 12 MiB binary fixture")
    url = source.as_uri()
    targets = {name: root / name for name in ("legacy", "retained")}
    for target in targets.values():
        run(["git", "clone", "-q", "--depth", "1", "--branch", "master", url, str(target)])

    samples = {name: [] for name in targets}
    for index in range(rounds):
        (source / "update.txt").write_text(f"revision {index}\n", encoding="utf-8")
        commit(source, f"update {index}")
        names = list(targets) if index % 2 == 0 else list(reversed(targets))
        for name in names:
            target = targets[name]

            def fetch_reset():
                git(target, "remote", "set-url", "origin", url)
                git(target, "fetch", "--depth", "1", "origin", "master")
                git(target, "reset", "--hard", "FETCH_HEAD")

            update_ms = timed(fetch_reset)
            cleanup_ms = 0.0
            if name == "legacy":
                def cleanup():
                    git(target, "reflog", "expire", "--expire=now", "--all")
                    git(target, "gc", "--prune=now")
                cleanup_ms = timed(cleanup)
            assert (target / "update.txt").read_bytes() == (source / "update.txt").read_bytes()
            samples[name].append({"update_ms": update_ms, "cleanup_ms": cleanup_ms,
                                  "total_ms": update_ms + cleanup_ms})

    return {"fixture": "12 MiB binary tree, shallow local file:// remote, small revision changes",
            "samples": samples,
            "median_ms": {name: statistics.median(s["total_ms"] for s in values)
                          for name, values in samples.items()}}


def make_wheel(path: Path, version: str) -> None:
    dist_info = f"baas_perf_fixture-{version}.dist-info"
    records = []
    rng = random.Random(version)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as wheel:
        def entry(name: str, data: bytes):
            wheel.writestr(name, data)
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            records.append((name, f"sha256={digest}", str(len(data))))

        entry("baas_perf_fixture/__init__.py", b"")
        for index in range(128):
            entry(f"baas_perf_fixture/data-{index:03}.bin", rng.randbytes(64 * 1024))
        entry(f"{dist_info}/METADATA",
              f"Metadata-Version: 2.1\nName: baas-perf-fixture\nVersion: {version}\n".encode())
        entry(f"{dist_info}/WHEEL", b"Wheel-Version: 1.0\nGenerator: baas-updater-benchmark\n"
              b"Root-Is-Purelib: true\nTag: py3-none-any\n")
        record = io.StringIO(newline="")
        csv.writer(record).writerows([*records, (f"{dist_info}/RECORD", "", "")])
        wheel.writestr(f"{dist_info}/RECORD", record.getvalue())


class CountingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.bytes_sent = 0
        self.counter_lock = threading.Lock()


class WheelHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def send_head(self):
        self.range_remaining = None
        path = Path(self.translate_path(self.path))
        requested = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if not requested or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        first, last = requested.groups()
        if first:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        else:
            start, end = max(0, size - int(last)), size - 1
        if start > end or start >= size:
            self.send_error(416)
            return None
        stream = path.open("rb")
        stream.seek(start)
        self.range_remaining = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.range_remaining))
        self.end_headers()
        return stream

    def copyfile(self, source, outputfile):
        remaining = self.range_remaining
        while remaining is None or remaining > 0:
            data = source.read(min(remaining, 64 * 1024) if remaining is not None else 64 * 1024)
            if not data:
                break
            try:
                outputfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                break
            with self.server.counter_lock:
                self.server.bytes_sent += len(data)
            if remaining is not None:
                remaining -= len(data)


def benchmark_uv(root: Path, executable: str, rounds: int) -> dict:
    wheels = root / "wheels"
    wheels.mkdir()
    for version in ("1.0.0", "2.0.0"):
        make_wheel(wheels / f"baas_perf_fixture-{version}-py3-none-any.whl", version)
    handler = functools.partial(WheelHandler, directory=str(wheels))
    server = CountingServer(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    index = f"http://127.0.0.1:{server.server_port}/"
    env = {**os.environ, "UV_PYTHON_DOWNLOADS": "never"}
    samples = {}
    try:
        for name in ("legacy", "retained"):
            work = root / name
            work.mkdir()
            cache = work / "cache"
            prefix = [executable, "--no-config", "--no-progress", "--cache-dir", str(cache)]
            venv = work / ".venv"
            run([*prefix, "venv", str(venv), "--python", sys.executable], env=env)
            python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            requirements = work / "requirements.txt"
            lock = work / "requirements.lock"

            def sync(version):
                requirements.write_text(f"baas-perf-fixture=={version}\n", encoding="utf-8")
                run([*prefix, "pip", "compile", str(requirements), "-o", str(lock),
                     "--python", str(python), "--no-index", "--find-links", index], env=env)
                run([*prefix, "pip", "sync", str(lock), "--python", str(python),
                     "--no-index", "--find-links", index], env=env)
                if name == "legacy":
                    run([*prefix, "cache", "clean"], env=env)

            # Warm both revisions; measured rounds alternate updates/rollbacks.
            sync("1.0.0")
            sync("2.0.0")
            samples[name] = []
            for iteration in range(rounds):
                before_bytes = server.bytes_sent
                version = "1.0.0" if iteration % 2 == 0 else "2.0.0"
                elapsed_ms = timed(lambda: sync(version))
                samples[name].append({"total_ms": elapsed_ms,
                                      "http_bytes": server.bytes_sent - before_bytes})
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
    return {"fixture": "8 MiB wheel, local HTTP, warmed alternating versions; compile + sync + legacy cleanup",
            "samples": samples,
            "median_ms": {name: statistics.median(s["total_ms"] for s in values)
                          for name, values in samples.items()},
            "http_bytes": {name: sum(s["http_bytes"] for s in values)
                           for name, values in samples.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=4)
    parser.add_argument("--uv", default=shutil.which("uv"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    result = {"scope": "Local fixture timings only; does not measure public network download speed",
              "platform": sys.platform, "rounds": args.rounds}
    with tempfile.TemporaryDirectory(prefix="baas-updater-bench-") as temp:
        root = Path(temp)
        git_root = root / "git"
        git_root.mkdir()
        result["git"] = benchmark_git(git_root, args.rounds)
        if args.uv:
            uv_root = root / "uv"
            uv_root.mkdir()
            result["uv"] = benchmark_uv(uv_root, args.uv, args.rounds)
        else:
            result["uv"] = {"skipped": "Pass --uv path/to/uv to include the wheel cache benchmark"}
    output = json.dumps(result, indent=2)
    print(output)
    if args.output:
        args.output.write_text(output + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
