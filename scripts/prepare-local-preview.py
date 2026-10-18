"""Snapshot the local Python backend for an isolated, unpublished UI preview.

Usage: python scripts/prepare-local-preview.py --backend-source ../baas-dev
       --destination ../.codex_tmp/appearance-validation/backend

Configuration and the desktop executable stay in place. Replaced runtime files
are moved to a timestamped sibling backup; junctions are moved as links, never
traversed or recursively deleted. The source checkout and daily installation
are never modified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


def prepare(source: Path, destination: Path) -> dict:
    source = source.resolve(strict=True)
    destination = destination.resolve(strict=True)
    repository = Path(__file__).resolve().parents[1]
    allowed = repository.parent / ".codex_tmp"
    if allowed.resolve() not in destination.parents:
        raise ValueError(f"Preview destination must be under {allowed}")
    if source == destination or not (source / "service/transport/shm_server.py").is_file():
        raise ValueError("Expected a local baas-dev checkout with shared-memory support")
    if not (destination / "setup.toml").is_file():
        raise ValueError("Expected an existing isolated backend with setup.toml")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = destination.parent / f"backend-before-repair-{timestamp}"
    backup.mkdir()
    runtime_items = ["core", "module", "service", "deploy", "src", "main.py", "main.service.py",
                     "pyproject.toml", "requirements.txt", "requirements.service.lock"]
    for name in runtime_items:
        incoming = source / name
        if not incoming.exists():
            continue
        existing = destination / name
        if existing.exists() or existing.is_symlink():
            existing.rename(backup / name)
        if incoming.is_dir():
            shutil.copytree(incoming, existing, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"))
        else:
            shutil.copy2(incoming, existing)

    # This snapshot contains unpublished local code. Keep the preview on that
    # coherent version rather than replacing only part of it with remote HEAD.
    setup = destination / "setup.toml"
    shutil.copy2(setup, backup / "setup.toml")
    lines = setup.read_text(encoding="utf-8").splitlines()
    in_general = False
    found_no_update = False
    general_start = None
    for index, line in enumerate(lines):
        if line.strip().startswith("["):
            in_general = line.strip() == "[general]"
            if in_general:
                general_start = index
        if in_general and line.strip().startswith("no_update ="):
            lines[index] = "no_update = true"
            found_no_update = True
    if not found_no_update:
        if general_start is None:
            lines.extend(["", "[general]", "no_update = true"])
        else:
            lines.insert(general_start + 1, "no_update = true")
    setup.write_text("\n".join(lines) + "\n", encoding="utf-8")

    manifest = {"createdAt": timestamp, "backendSource": str(source), "backup": str(backup),
                "transport": "shm", "noUpdate": True, "files": {}}
    for item in runtime_items:
        copied = destination / item
        for file in copied.rglob("*.py") if copied.is_dir() else [copied]:
            if file.is_file():
                manifest["files"][str(file.relative_to(destination)).replace("\\", "/")] = hashlib.sha256(file.read_bytes()).hexdigest()
    (destination.parent / "backend-snapshot.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {key: value for key, value in manifest.items() if key != "files"} | {"fileCount": len(manifest["files"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend-source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.backend_source, args.destination), ensure_ascii=False))
