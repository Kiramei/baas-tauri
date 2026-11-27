"""Run the mounted BAAS service with updates owned by the Docker deployment."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys


def remote_revision(remote, branch, timeout, *, cwd=None):
    ref = "refs/heads/" + branch
    result = subprocess.run(
        ["git", "ls-remote", "--exit-code", "--refs", "--", remote, ref],
        cwd=cwd, env=dict(os.environ, GIT_TERMINAL_PROMPT="0"),
        timeout=timeout, capture_output=True, text=True,
    )
    if result.returncode:
        detail = result.stderr.strip() or f"Branch {branch} not found"
        raise RuntimeError(detail)
    sha, name = result.stdout.split()
    if name != ref:
        raise ValueError("Unexpected remote ref")
    return sha


def test_git_source(config, timeout):
    # Use the same TLS, proxy configuration and git executable as a Docker update.
    try:
        return True, remote_revision(config["url"], config["branch"], timeout)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        return False, str(exc)


class CheckoutUpdates:
    def __init__(self, root, branch, no_update, restart):
        self.root = root
        self.branch = branch
        self.no_update = no_update
        self.restart = restart
        self.lock = asyncio.Lock()
        self.running = self.git("rev-parse", "HEAD") if (root / ".git").exists() else None

    def git(self, *args, timeout=120):
        return subprocess.run(
            ["git", *args], cwd=self.root, text=True, stdout=subprocess.PIPE,
            env=dict(os.environ, GIT_TERMINAL_PROMPT="0"), check=True, timeout=timeout,
        ).stdout.strip()

    def version(self):
        report = dict(local=self.running, remote=None, update_available=False,
                      method="docker-git", branch=self.branch)
        if self.no_update(self.root):
            return dict(report, remote=self.running, skipped=True, reason="no_update")
        try:
            sha = remote_revision("origin", self.branch, 15, cwd=self.root)
            return dict(report, remote=sha, update_available=self.running != sha)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            return dict(report, error=f"Cannot read origin/{self.branch}")

    def install(self):
        if self.no_update(self.root):
            return {"status": "skipped", "reason": "no_update"}
        if self.git("symbolic-ref", "--short", "HEAD") != self.branch:
            raise RuntimeError(f"Checkout is not on the configured Docker branch {self.branch}")
        ref = "refs/heads/" + self.branch
        self.git("fetch", "--no-tags", "origin", ref)
        target = self.git("rev-parse", "FETCH_HEAD")
        self.git("cat-file", "-e", target + ":main.service.py")
        if self.git("rev-parse", "HEAD") != target:
            try:
                self.git("merge-base", "--is-ancestor", "HEAD", target)
                self.git("merge", "--ff-only", "--no-overwrite-ignore", target)
            except subprocess.CalledProcessError as exc:
                raise RuntimeError("Cannot fast-forward the checkout. Check local commits and file conflicts.") from exc
        if self.git("rev-parse", "HEAD") != target:
            raise RuntimeError("Installed revision differs from the fetched revision")
        if self.running == target:
            return {"status": "unchanged", "current": target}
        self.restart()
        return {"status": "updated", "current": target}

    def bind(self, runtime):
        # Keep the upstream authenticated trigger stream and provider broadcasts.
        async def check():
            report = await asyncio.to_thread(self.version)
            runtime.publish_version_update(report)
            return report

        async def update_stream():
            if self.lock.locked():
                raise RuntimeError("A backend update is already in progress")
            async with self.lock:
                if not self.no_update(self.root):
                    stopped = await runtime.stop_all_tasks()
                    if any(item.get("status") == "stopping" for item in stopped["results"]):
                        raise RuntimeError("A running task has not stopped yet")
                yield {"type": "progress", "stage": "update_start"}
                result = await asyncio.to_thread(self.install)
                yield {"type": "result", "result": result}

        async def update():
            async for event in update_stream():
                if event["type"] == "result":
                    return event["result"]

        runtime.check_for_update = check
        runtime.update_to_latest_stream = update_stream
        runtime.update_to_latest = update


def run_service(root: Path, no_update):
    sys.path.insert(0, str(root))
    from service import app, context
    from service.update import checks

    # Keep the mounted service's provider list, HTTP probes and streaming protocol.
    checks._git_wrapper_get_latest_sha = test_git_source

    updates = CheckoutUpdates(root, os.getenv("BRANCH", "master"), no_update,
                              lambda: os.kill(os.getppid(), signal.SIGUSR1))
    updates.bind(context.runtime)

    @app.middleware("http")
    async def running_revision(request, call_next):
        response = await call_next(request)
        if request.url.path == "/health" and updates.running:
            response.headers["X-BAAS-Revision"] = updates.running
        return response

    script = root / "main.service.py"
    sys.argv = [str(script), "--host", "127.0.0.1", "--port", "8190"]
    runpy.run_path(str(script), run_name="__main__")
