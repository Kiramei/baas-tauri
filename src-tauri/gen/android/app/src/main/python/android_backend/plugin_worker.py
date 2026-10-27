"""One trusted compute action in a disposable Android Service process.

This is process/lifecycle isolation, not a Python security sandbox. The worker
uses the app UID and may access its private data. Never load untrusted plugins.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys

MAX_REQUEST = 131072
MAX_RESPONSE = 131072


def _reject_constant(_value):
    raise ValueError("finite JSON required")


def run(package_dir, request_path, result_path):
    """Load the host worker from a private job and atomically publish its result."""
    response = {"ok": False, "code": "ACTION_FAILED", "message": "Plugin action failed."}
    # A worker owns a disposable process. Never restore these streams: plugin
    # background threads must not write secrets to Logcat after returning.
    sink = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stderr = sink
    # Match desktop -B; package digests deliberately reject generated pycache.
    sys.dont_write_bytecode = True
    try:
        request_file = Path(request_path).resolve(strict=True)
        with request_file.open("rb") as stream:
            content = stream.read(MAX_REQUEST + 1)
        if not 0 < len(content) <= MAX_REQUEST:
            raise ValueError("invalid request size")
        request = json.loads(content.decode("utf-8"), parse_constant=_reject_constant)
        worker = request_file.parent / "worker.py"
        spec = importlib.util.spec_from_file_location("_baas_android_host_worker", worker)
        if spec is None or spec.loader is None:
            raise ValueError("host worker unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        response = module.execute_request(package_dir, request)
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_RESPONSE:
            raise ValueError("invalid host response")
    except BaseException:
        response = {"ok": False, "code": "ACTION_FAILED", "message": "Plugin action failed."}
    result_file = Path(result_path)
    temporary = result_file.with_name(result_file.name + ".tmp")
    encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")
    with temporary.open("wb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, result_file)
