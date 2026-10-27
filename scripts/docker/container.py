"""Install the persistent service and supervise the two container processes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Optional
from urllib.request import ProxyHandler, build_opener

try:
    import tomllib
except ModuleNotFoundError:  # The image deliberately supports Python 3.9.
    import tomli as tomllib

OCR_REPOSITORY = "https://github.com/pur1fying/BAAS_Cpp_prebuild.git"
OCR_DIRECTORY = Path("core/ocr/baas_ocr_client/bin")


def no_update_enabled(app_dir: Path) -> bool:
    path = app_dir / "setup.toml"
    if not path.exists():
        return False
    try:
        with path.open("rb") as config_file:
            config = tomllib.load(config_file)
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Cannot read {path}; refusing repository changes: {error}") from error
    # Service startup can append the legacy table to a modern checkout. Match
    # its precedence rather than rejecting that valid, generated TOML layout.
    for name in ("general", "General"):
        if name not in config:
            continue
        general = config[name]
        if not isinstance(general, dict):
            raise RuntimeError(f"setup.toml {name} must be a table; refusing repository changes")
        if "no_update" not in general:
            continue
        value = general["no_update"]
        if not isinstance(value, bool):
            raise RuntimeError(f"setup.toml {name}.no_update must be a boolean; refusing repository changes")
        return value
    return False


def copy_missing(source: Path, destination: Path) -> None:
    """Merge a first checkout into a volume without overwriting seeded data."""
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = destination / child.name
        if target.exists() or target.is_symlink():
            if child.is_dir() and not child.is_symlink() and target.is_dir() and not target.is_symlink():
                copy_missing(child, target)
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.copytree(child, target, symlinks=True)
        elif child.is_symlink():
            target.symlink_to(os.readlink(child))
        else:
            shutil.copy2(child, target)


def require_service(app_dir: Path) -> None:
    if not (app_dir / "main.service.py").is_file():
        raise RuntimeError(
            f"No main.service.py in {app_dir}; select a service-enabled repository/branch. "
            "no_update requires an already installed service."
        )


def prepare_service(app_dir: Path, repo_url: Optional[str], branch: str) -> None:
    app_dir.mkdir(parents=True, exist_ok=True)
    if no_update_enabled(app_dir):
        require_service(app_dir)
        print("[INFO] no_update is enabled; keeping the installed repository.", flush=True)
        return
    if not branch or branch.startswith("-"):
        raise RuntimeError("BRANCH must be a Git branch name")
    subprocess.run(["git", "check-ref-format", "--branch", branch], check=True, capture_output=True)
    if not (app_dir / ".git").exists():
        if not repo_url:
            raise RuntimeError("A repository URL is required for the first installation")
        print(f"[INFO] Cloning service branch {branch}; preserving existing volume files.", flush=True)
        with tempfile.TemporaryDirectory(prefix="baas-service-") as temporary:
            checkout = Path(temporary) / "checkout"
            subprocess.run(
                ["git", "clone", "--branch", branch, "--depth", "1", "--", repo_url, str(checkout)],
                check=True,
            )
            require_service(checkout)
            copy_missing(checkout, app_dir)
    else:
        print(f"[INFO] Updating installed service branch {branch} (fast-forward only).", flush=True)
        subprocess.run(["git", "fetch", "origin", branch], cwd=app_dir, check=True)
        existing = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=app_dir
        )
        checkout_args = ["git", "checkout", branch] if existing.returncode == 0 else [
            "git", "checkout", "-b", branch, "FETCH_HEAD"
        ]
        subprocess.run(checkout_args, cwd=app_dir, check=True)
        subprocess.run(["git", "merge", "--ff-only", "FETCH_HEAD"], cwd=app_dir, check=True)
    require_service(app_dir)


def missing_ocr_files(directory: Path):
    required = [
        "BAAS_ocr_server", "libBAAS_ipc.so", "libonnxruntime.so.1", "libopencv_world.so.409",
        "resource/global_setting.json", "resource/static.json", "resource/ocr_models/configs.txt",
    ]
    try:
        catalog = json.loads((directory / "resource/static.json").read_text())["ocr_model_name"]
        if not isinstance(catalog, dict) or not catalog:
            raise ValueError("missing OCR model catalog")
        for language, model in catalog.items():
            for kind in ("det", "cls", "rec", "dict"):
                filename = model[kind]
                if not isinstance(filename, str) or Path(filename).is_absolute() or ".." in Path(filename).parts:
                    raise ValueError("invalid OCR model filename")
                required.append(f"resource/ocr_models/{filename}")
            required.append(f"resource/ocr_models/test_images/{language}.png")
    except (OSError, ValueError, KeyError, TypeError):
        return ["resource/static.json (valid OCR model catalog required)"]
    missing = sorted({name for name in required if not (directory / name).is_file() or (directory / name).stat().st_size == 0})
    if not missing and not os.access(directory / "BAAS_ocr_server", os.X_OK):
        missing.append("BAAS_ocr_server (executable permission required)")
    return missing


def prepare_ocr(app_dir: Path, repo_url: Optional[str] = None, branch: Optional[str] = None) -> None:
    directory = app_dir / OCR_DIRECTORY
    missing = missing_ocr_files(directory)
    if not missing:
        print("[INFO] Keeping the installed OCR binary, libraries, models and configuration.", flush=True)
        return
    if no_update_enabled(app_dir):
        raise RuntimeError(
            "OCR is missing or incomplete while no_update is enabled: " + ", ".join(missing[:5]) +
            ". Preinstall the complete OCR package or temporarily disable no_update."
        )
    if not branch:
        if platform.machine().lower() not in {"x86_64", "amd64"}:
            raise RuntimeError("No default OCR prebuild for this architecture; set BAAS_OCR_REPO_URL and BAAS_OCR_BRANCH")
        branch = "linux-x64"
    if branch.startswith("-"):
        raise RuntimeError("BAAS_OCR_BRANCH must be a Git branch name")
    repo_url = repo_url or OCR_REPOSITORY
    subprocess.run(["git", "check-ref-format", "--branch", branch], check=True, capture_output=True)
    print(f"[INFO] Installing complete OCR prebuild {branch} from {repo_url} with Git CLI.", flush=True)
    with tempfile.TemporaryDirectory(prefix="baas-ocr-") as temporary:
        checkout = Path(temporary) / "checkout"
        subprocess.run(
            ["git", "clone", "--branch", branch, "--depth", "1", "--", repo_url, str(checkout)],
            check=True,
        )
        binary = checkout / "BAAS_ocr_server"
        if binary.is_file():
            binary.chmod(binary.stat().st_mode | 0o111)
        missing = missing_ocr_files(checkout)
        if missing:
            raise RuntimeError("OCR prebuild is incomplete: " + ", ".join(missing[:5]))
        directory.mkdir(parents=True, exist_ok=True)
        # Runtime files come from one validated checkout. Keep writable user
        # configuration and OCR output; do not import another Git repository.
        for source in checkout.iterdir():
            if source.name in {".git", "config", "output"}:
                continue
            target = directory / source.name
            if target.is_symlink():
                target.unlink()
            if source.is_dir():
                shutil.copytree(source, target, dirs_exist_ok=True, symlinks=True)
            else:
                shutil.copy2(source, target, follow_symlinks=False)
        missing = missing_ocr_files(directory)
        if missing:
            raise RuntimeError("Installed OCR prebuild is incomplete: " + ", ".join(missing[:5]))
        config_directory = directory / "config"
        config_directory.mkdir(exist_ok=True)
        settings = config_directory / "global_setting.json"
        if not settings.exists():
            shutil.copy2(directory / "resource/global_setting.json", settings)
    print("[INFO] OCR binary, libraries and model resources are installed; backend will run its OCR self-tests.", flush=True)


def stop_processes(processes, timeout: float = 10.0) -> None:
    # Separate process groups also stop backend workers and nginx children.
    for name, process in processes:
        try:
            os.killpg(process.pid, signal.SIGQUIT if name == "nginx" else signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + timeout
    for _, process in processes:
        try:
            process.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def serve(app_dir: Path) -> int:
    stopping = False
    processes = []

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    previous_handlers = {number: signal.signal(number, request_stop) for number in (signal.SIGTERM, signal.SIGINT)}
    try:
        subprocess.run(["nginx", "-t"], check=True)
        print("[INFO] Starting nginx and the loopback-only Python service.", flush=True)
        processes.append(("nginx", subprocess.Popen(["nginx", "-g", "daemon off;"], start_new_session=True)))
        if not stopping:
            # Docker installs missing OCR explicitly; keep backend initialization
            # and real model self-tests, without its separate Gitee update path.
            backend_environment = dict(os.environ, BAAS_SERVICE_OCR_UPDATE_CHECK="0")
            processes.append(("backend", subprocess.Popen(
                [sys.executable, "main.service.py", "--host", "127.0.0.1", "--port", "8190"],
                cwd=app_dir,
                start_new_session=True,
                env=backend_environment,
            )))
        while not stopping:
            for name, process in processes:
                status = process.poll()
                if status is not None:
                    print(f"[ERROR] {name} exited with status {status}; stopping the container.", file=sys.stderr)
                    return status if status > 0 else 1
            time.sleep(0.2)
        return 0
    finally:
        stop_processes(processes)
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def healthcheck() -> int:
    try:
        # Ignore HTTP_PROXY: this probe must never leave the container.
        with build_opener(ProxyHandler({})).open("http://127.0.0.1:8191/health", timeout=3) as response:
            payload = json.loads(response.read(1_048_576))
            return 0 if response.status == 200 and payload.get("ok") is True else 1
    except (OSError, ValueError, AttributeError):
        return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo_url", nargs="?", help="Service repository URL (required for first install)")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args(argv)
    if args.healthcheck:
        return healthcheck()
    try:
        prepare_service(Path("/app"), args.repo_url, os.getenv("BRANCH", "master"))
        prepare_ocr(Path("/app"), os.getenv("BAAS_OCR_REPO_URL"), os.getenv("BAAS_OCR_BRANCH"))
        return serve(Path("/app"))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"[ERROR] {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
