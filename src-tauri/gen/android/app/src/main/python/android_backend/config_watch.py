"""Small, cancellable watchfiles adapter for Android configuration resources.

Only regular files under the supplied paths are polled. Directory metadata is
not reported: file additions/deletions already tell ConfigManager to rescan,
while directory mtimes also change when ignored runtime logs grow.
"""

import asyncio
import json
import os
import stat
import time
from enum import IntEnum


class Change(IntEnum):
    added = 1
    modified = 2
    deleted = 3


_IGNORED_DIRECTORIES = frozenset(("logs", ".git", "__pycache__", ".pytest_cache", ".mypy_cache"))


def _ignored(name):
    return name in _IGNORED_DIRECTORIES or name.endswith(".log") or ".log." in name


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _snapshot(roots, recursive, previous, ignore_permission_denied):
    files = {}
    denied = []

    def unavailable(path, error):
        if isinstance(error, PermissionError):
            if not ignore_permission_denied:
                raise error
            denied.append(path)

    def visit(path, descend):
        if _ignored(os.path.basename(path)):
            return
        try:
            info = os.stat(path, follow_symlinks=False)
        except OSError as error:
            unavailable(path, error)
            return
        if stat.S_ISREG(info.st_mode):
            files[path] = _signature(info)
        elif stat.S_ISDIR(info.st_mode):
            try:
                with os.scandir(path) as entries:
                    for entry in entries:
                        if _ignored(entry.name):
                            continue
                        try:
                            if entry.is_file(follow_symlinks=False):
                                # Windows DirEntry.stat caches zero st_dev/st_ino.
                                # JSON validation uses os.stat, so its identity must
                                # match this snapshot rather than remain pending.
                                info = (os.stat(entry.path, follow_symlinks=False) if os.name == "nt"
                                        else entry.stat(follow_symlinks=False))
                                files[entry.path] = _signature(info)
                            elif descend and entry.is_dir(follow_symlinks=False):
                                visit(entry.path, True)
                        except OSError as error:
                            unavailable(entry.path, error)
            except OSError as error:
                unavailable(path, error)

    for root in roots:
        visit(root, recursive)
    # A temporary access failure must not masquerade as resource deletion.
    for path, signature in previous.items():
        if any(path == root or path.startswith(root + os.sep) for root in denied):
            files[path] = signature
    return files


def _complete_json(path, signature):
    try:
        with open(path, "r", encoding="utf-8") as stream:
            json.load(stream)
        return _signature(os.stat(path, follow_symlinks=False)) == signature
    except (OSError, ValueError, UnicodeError):
        return False


def _stopped(event):
    return event is not None and event.is_set()


async def _pause(seconds, stop_event):
    deadline = time.monotonic() + seconds
    while not _stopped(stop_event):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        await asyncio.sleep(min(remaining, 0.05) if stop_event is not None else remaining)


async def awatch(
    *paths,
    watch_filter=None,
    debounce=200,
    step=50,
    stop_event=None,
    rust_timeout=None,
    yield_on_timeout=False,
    debug=False,
    raise_interrupt=None,
    force_polling=None,
    poll_delay_ms=250,
    recursive=True,
    ignore_permission_denied=True,
):
    """Yield ``{(Change, absolute_path)}`` after a configuration write settles.

    File scans/JSON validation run off the event loop. Changed sibling files are
    released together only when stable, so an event.json/config.json pair is not
    handed to a rescan halfway through a write. Invalid JSON remains pending,
    without blocking valid changes in other directories. No persistent worker
    or native filesystem watcher is required.

    The native-only tuning flags are accepted for watchfiles call compatibility;
    this adapter always polls. Cancellation propagates normally, and both asyncio
    and threading stop events are supported.
    """
    if not paths:
        raise ValueError("awatch requires at least one path")
    roots = tuple(dict.fromkeys(os.path.abspath(os.fsdecode(path)) for path in paths))
    interval = max(0.01, float(poll_delay_ms) / 1000)
    quiet = max(interval, float(debounce) / 1000, float(step) / 1000)
    timeout = max(0.01, float(rust_timeout if rust_timeout is not None else 1000) / 1000)
    if _stopped(stop_event):
        return
    known = await asyncio.to_thread(_snapshot, roots, recursive, {}, ignore_permission_denied)
    observed = known
    pending = {}
    json_checks = {}
    last_yield = time.monotonic()
    while not _stopped(stop_event):
        await _pause(interval, stop_event)
        if _stopped(stop_event):
            return
        observed = await asyncio.to_thread(
            _snapshot, roots, recursive, observed, ignore_permission_denied
        )
        now = time.monotonic()
        for path in known.keys() | observed.keys() | pending.keys():
            signature = observed.get(path)
            if signature == known.get(path):
                pending.pop(path, None)
                json_checks.pop(path, None)
            elif path not in pending or pending[path][0] != signature:
                pending[path] = (signature, now)
                json_checks.pop(path, None)

        groups = {}
        for path in pending:
            groups.setdefault(os.path.dirname(path), []).append(path)
        changes = set()
        for siblings in groups.values():
            if any(now - pending[path][1] < quiet for path in siblings):
                continue
            ready = True
            for path in siblings:
                signature = pending[path][0]
                if signature is not None and path.lower().endswith(".json"):
                    if path not in json_checks:
                        json_checks[path] = await asyncio.to_thread(_complete_json, path, signature)
                    if not json_checks[path]:
                        ready = False
            if not ready:
                continue
            for path in siblings:
                signature = pending.pop(path)[0]
                json_checks.pop(path, None)
                if signature is None:
                    known.pop(path, None)
                    change = Change.deleted
                else:
                    change = Change.modified if path in known else Change.added
                    known[path] = signature
                if watch_filter is None or watch_filter(change, path):
                    changes.add((change, path))
        if _stopped(stop_event):
            return
        if changes or (yield_on_timeout and now - last_yield >= timeout):
            last_yield = now
            yield changes
