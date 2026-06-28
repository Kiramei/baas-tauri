import json
import os
import shutil
import sys
import threading
import time
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BUNDLED_BACKEND_DIR = "baas_backend_bundle"
BUNDLED_BACKEND_ZIP = "baas_backend_bundle.zip"
STATUS_FILE = "android-bootstrap-status.json"


def start(files_dir, port):
    root = Path(files_dir) / "baas"
    root.mkdir(parents=True, exist_ok=True)
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    os.environ.setdefault("BAAS_SERVICE_HOST", "127.0.0.1")
    os.environ.setdefault("BAAS_SERVICE_PORT", str(port))
    os.environ.setdefault("BAAS_SERVICE_OCR_UPDATE_CHECK", "0")
    os.environ.setdefault("BAAS_UPDATE_CHECK_INTERVAL_SECONDS", "86400")
    os.environ.setdefault("BAAS_ANDROID", "1")
    os.environ.setdefault("BAAS_ALLOW_MISSING_OCR", "1")

    status = {
        "ok": False,
        "mode": "android-bootstrap",
        "root": str(root),
        "source": "bundled-baas-dev",
        "startedAt": time.time(),
    }

    try:
        installed = _ensure_backend_files(root)
        status["backendInstalled"] = True
        status["installedThisRun"] = installed
        _write_status(root, status)
        _run_baas_service(root, port)
        return
    except Exception as error:
        status.update(
            {
                "backendInstalled": _service_path(root).exists(),
                "error": str(error),
                "traceback": traceback.format_exc(),
                "message": (
                    "Embedded Python 3.9 is running, but the bundled BAAS service "
                    "backend could not be started. Android does not use uv; the "
                    "backend source is copied from the APK into app-private storage. "
                    "The first missing Android-compatible dependency is reported here."
                ),
            }
        )
        _write_status(root, status)
        _run_bootstrap_server(port, root, status)


def _ensure_backend_files(root):
    bundle = _bundled_backend_path()
    bundle_zip = _bundled_backend_zip_path()
    if not bundle.exists() and not bundle_zip.exists():
        raise RuntimeError(f"Bundled backend is missing: {bundle_zip}")

    stamp = root / "android-backend-source.json"
    bundle_stamp = _read_bundle_stamp(bundle, bundle_zip)
    if _service_path(root).exists() and _same_stamp(stamp, bundle_stamp):
        _ensure_android_support_files(root)
        return False

    tmp_root = root.parent / "baas-next"
    shutil.rmtree(tmp_root, ignore_errors=True)
    if bundle_zip.exists():
        with zipfile.ZipFile(bundle_zip) as archive:
            archive.extractall(tmp_root)
    else:
        shutil.copytree(bundle, tmp_root)
    _ensure_android_support_files(tmp_root)
    shutil.rmtree(root, ignore_errors=True)
    tmp_root.replace(root)
    return True


def _bundled_backend_path():
    return Path(__file__).resolve().parent.parent / BUNDLED_BACKEND_DIR


def _bundled_backend_zip_path():
    return Path(__file__).resolve().parent / BUNDLED_BACKEND_ZIP


def _read_bundle_stamp(bundle, bundle_zip):
    if bundle_zip.exists():
        try:
            with zipfile.ZipFile(bundle_zip) as archive:
                return archive.read("android-backend-source.json").decode("utf-8")
        except Exception:
            return ""
    stamp = bundle / "android-backend-source.json"
    if stamp.exists():
        return stamp.read_text(encoding="utf-8")
    return ""


def _same_stamp(current, bundled):
    if not current.exists() or not bundled:
        return False
    try:
        return current.read_text(encoding="utf-8") == bundled
    except Exception:
        return False


def _ensure_android_support_files(root):
    _write_watchfiles_stub(root)
    _write_pygit2_stub(root)
    _write_cv2_stub(root)
    _write_psutil_stub(root)
    _write_desktop_only_stub(root, "pyautogui")
    _write_desktop_only_stub(root, "mss")


def _write_watchfiles_stub(root):
    path = root / "watchfiles.py"
    path.write_text(
        "import asyncio\n"
        "from enum import Enum\n\n"
        "class Change(Enum):\n"
        "    added = 1\n"
        "    modified = 2\n"
        "    deleted = 3\n\n"
        "async def awatch(*_args, **_kwargs):\n"
        "    while True:\n"
        "        await asyncio.sleep(3600)\n"
        "        if False:\n"
        "            yield set()\n",
        encoding="utf-8",
    )


def _write_pygit2_stub(root):
    package = root / "pygit2"
    package.mkdir(exist_ok=True)
    (package / "__init__.py").write_text(
        "class GitError(RuntimeError):\n"
        "    pass\n\n"
        "class Commit:\n"
        "    pass\n\n"
        "class _RemoteCallbacks:\n"
        "    pass\n\n"
        "class callbacks:\n"
        "    RemoteCallbacks = _RemoteCallbacks\n\n"
        "class Repository:\n"
        "    def __init__(self, *_args, **_kwargs):\n"
        "        raise GitError('pygit2 is unavailable on Android; backend updates are disabled')\n\n"
        "def init_repository(*_args, **_kwargs):\n"
        "    raise GitError('pygit2 is unavailable on Android; backend updates are disabled')\n\n"
        "def clone_repository(*_args, **_kwargs):\n"
        "    raise GitError('pygit2 is unavailable on Android; backend updates are disabled')\n\n",
        encoding="utf-8",
    )
    (package / "enums.py").write_text(
        "class ResetMode:\n"
        "    SOFT = 1\n"
        "    MIXED = 2\n"
        "    HARD = 3\n",
        encoding="utf-8",
    )


def _write_cv2_stub(root):
    (root / "cv2.py").write_text(
        "INTER_AREA = 3\n"
        "TM_CCOEFF_NORMED = 5\n"
        "TM_SQDIFF = 0\n"
        "IMREAD_COLOR = 1\n"
        "IMREAD_UNCHANGED = -1\n"
        "COLOR_RGB2BGR = 4\n"
        "COLOR_BGRA2BGR = 1\n"
        "COLOR_BGRA2RGB = 2\n"
        "ROTATE_90_CLOCKWISE = 0\n\n"
        "def __getattr__(name):\n"
        "    raise RuntimeError('OpenCV is not bundled for Android yet; cv2.%s is unavailable' % name)\n",
        encoding="utf-8",
    )


def _write_psutil_stub(root):
    (root / "psutil.py").write_text(
        "class NoSuchProcess(Exception):\n"
        "    pass\n"
        "class AccessDenied(Exception):\n"
        "    pass\n"
        "class TimeoutExpired(Exception):\n"
        "    pass\n"
        "def process_iter(*_args, **_kwargs):\n"
        "    return iter(())\n"
        "class Process:\n"
        "    def __init__(self, *_args, **_kwargs):\n"
        "        raise NoSuchProcess()\n",
        encoding="utf-8",
    )


def _write_desktop_only_stub(root, module_name):
    (root / f"{module_name}.py").write_text(
        "def __getattr__(name):\n"
        f"    raise RuntimeError('{module_name} is not available on Android')\n",
        encoding="utf-8",
    )


def _service_path(root):
    return root / "main.service.py"


def _run_baas_service(root, port):
    import runpy

    old_argv = sys.argv[:]
    sys.argv = [
        str(_service_path(root)),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "info",
        "--no-ocr-update-check",
    ]
    cwd = os.getcwd()
    os.chdir(root)
    try:
        runpy.run_path(sys.argv[0], run_name="__main__")
    finally:
        os.chdir(cwd)
        sys.argv = old_argv


def _write_status(root, status):
    root.mkdir(parents=True, exist_ok=True)
    (root / STATUS_FILE).write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_status(root, fallback):
    path = root / STATUS_FILE
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _run_bootstrap_server(port, root, initial_status):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/health") or self.path.startswith("/auth/remember"):
                self._json(_read_status(root, initial_status))
                return
            self.send_error(404)

        def _json(self, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="baas-bootstrap-http", daemon=True).start()
