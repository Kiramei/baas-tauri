import json
import os
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATUS_FILE = "android-bootstrap-status.json"
PACKAGE_NAME = "io.github.kiramei.baas_tauri"
DEFAULT_CHANNEL = "dev"
REPOSITORIES = {
    "dev": {
        "owner": "Kiramei",
        "repo": "baas-dev",
        "branch": "master",
    },
    "stable": {
        "owner": "pur1fying",
        "repo": "blue_archive_auto_script",
        "branch": "master",
    },
}


def start(files_dir, storage_root_or_port, port=None, native_library_dir=None):
    if port is None:
        port = storage_root_or_port
        storage_root = Path(files_dir) / PACKAGE_NAME
    else:
        storage_root = Path(storage_root_or_port)
    root = storage_root
    root.mkdir(parents=True, exist_ok=True)
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    os.environ.setdefault("BAAS_SERVICE_HOST", "127.0.0.1")
    os.environ.setdefault("BAAS_SERVICE_PORT", str(port))
    os.environ.setdefault("BAAS_SERVICE_OCR_UPDATE_CHECK", "1")
    os.environ.setdefault("BAAS_UPDATE_CHECK_INTERVAL_SECONDS", "86400")
    os.environ.setdefault("BAAS_ANDROID", "1")
    os.environ.setdefault("BAAS_ALLOW_MISSING_OCR", "1")
    os.environ.setdefault("BAAS_ANDROID_INTERNAL_FILES_DIR", str(files_dir))
    if native_library_dir:
        os.environ.setdefault("BAAS_ANDROID_NATIVE_LIBRARY_DIR", str(native_library_dir))

    status = {
        "ok": False,
        "mode": "android-bootstrap",
        "root": str(root),
        "storageRoot": str(storage_root),
        "source": "runtime-repository",
        "startedAt": time.time(),
    }

    try:
        installed = _ensure_backend_files(root, status)
        status["backendInstalled"] = True
        status["installedThisRun"] = installed
        status["ok"] = True
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
                    "backend source is installed at runtime under Android/data. "
                    "The first missing Android-compatible dependency is reported here."
                ),
            }
        )
        _write_status(root, status)
        _run_bootstrap_server(port, root, status)


def _ensure_backend_files(root, status):
    if _service_path(root).exists():
        _ensure_android_support_files(root)
        return False

    tmp_root = root / ".baas-next"
    shutil.rmtree(tmp_root, ignore_errors=True)
    status["installing"] = True
    status["installMessage"] = "Downloading BAAS backend repository."
    _write_status(root, status)
    channel = _setup_channel(root)
    remote_sha = _download_backend_archive(tmp_root, channel)
    _ensure_android_support_files(tmp_root)
    _replace_backend_files(root, tmp_root)
    if remote_sha:
        _write_installed_backend_sha(root / "setup.toml", remote_sha, channel)
    status["installing"] = False
    return True


def _replace_backend_files(root, tmp_root):
    preserved_names = {".app_storage.json", "files", "setup.toml"}
    for path in root.iterdir():
        if path.name in preserved_names or path == tmp_root:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)

    for path in tmp_root.iterdir():
        target = root / path.name
        if path.name in preserved_names and target.exists():
            continue
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            else:
                target.unlink()
        shutil.move(str(path), str(target))
    shutil.rmtree(tmp_root, ignore_errors=True)


def _setup_channel(root):
    setup = root / "setup.toml"
    if not setup.exists():
        _write_default_setup(root, DEFAULT_CHANNEL)
        return DEFAULT_CHANNEL
    for line in setup.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line.startswith("channel"):
            value = line.split("=", 1)[1].strip().strip('"').strip("'").lower()
            return value if value in REPOSITORIES else DEFAULT_CHANNEL
    return DEFAULT_CHANNEL


def _write_default_setup(root, channel):
    (root / "setup.toml").write_text(
        'schema_version = 1\n\n'
        '[general]\n'
        f'channel = "{channel}"\n'
        'mirrorc_cdk = ""\n'
        'no_update = false\n'
        'launch = true\n'
        'git_backend = "auto"\n'
        'current_baas_sha = ""\n'
        'current_baas_cpp_sha = ""\n'
        'get_remote_sha_method = "github"\n'
        'source_list = []\n\n'
        '[paths]\n'
        'baas_root_path = "."\n'
        'tmp_path = "tmp"\n'
        'toolkit_path = "toolkit"\n\n'
        '[python]\n'
        'runtime_path = "embedded-python-3.9"\n'
        'python_version = "3.9.0"\n\n'
        '[repositories]\n'
        'main_sources = []\n'
        'cpp_sources = []\n',
        encoding="utf-8",
    )


def _download_backend_archive(target_root, channel):
    repo = REPOSITORIES.get(channel, REPOSITORIES[DEFAULT_CHANNEL])
    owner = repo["owner"]
    name = repo["repo"]
    branch = repo["branch"]
    remote_sha = _get_github_branch_sha(owner, name, branch)
    archive_url = f"https://codeload.github.com/{owner}/{name}/zip/refs/heads/{branch}"
    target_root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(target_root.parent)) as tmp_dir:
        archive_path = Path(tmp_dir) / "repo.zip"
        with urllib.request.urlopen(archive_url, timeout=90) as response, archive_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(tmp_dir)
        candidates = [path for path in Path(tmp_dir).iterdir() if path.is_dir()]
        source_root = next((path for path in candidates if (path / "main.service.py").exists()), None)
        if source_root is None:
            raise RuntimeError("Downloaded BAAS backend archive does not contain main.service.py")
        shutil.copytree(source_root, target_root)
    if remote_sha:
        _write_installed_backend_sha(target_root / "setup.toml", remote_sha, channel)
    (target_root / "android-backend-source.json").write_text(
        json.dumps(
            {
                "source": archive_url,
                "channel": channel,
                "sha": remote_sha,
                "installedAt": time.time(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return remote_sha


def _get_github_branch_sha(owner, name, branch):
    api_url = f"https://api.github.com/repos/{owner}/{name}/branches/{branch}"
    try:
        request = urllib.request.Request(
            api_url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "BAAS-Tauri-Android",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
        sha = payload.get("commit", {}).get("sha")
        if sha:
            return str(sha)
    except Exception:
        pass
    return _get_git_smart_http_branch_sha(owner, name, branch)


def _get_git_smart_http_branch_sha(owner, name, branch):
    refs_url = f"https://github.com/{owner}/{name}.git/info/refs?service=git-upload-pack"
    try:
        request = urllib.request.Request(refs_url, headers={"User-Agent": "git/2.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", errors="replace")
        ref_name = f"refs/heads/{branch}"
        for line in text.splitlines():
            if ref_name in line:
                start = 4 if len(line) > 44 else 0
                sha = line[start:start + 40]
                if len(sha) == 40 and all(ch in "0123456789abcdef" for ch in sha.lower()):
                    return sha
    except Exception:
        return ""
    return ""


def _write_installed_backend_sha(setup_path, sha, channel):
    if not setup_path.exists():
        return
    lines = setup_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    wrote_sha = False
    wrote_channel = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("current_baas_sha"):
            lines[index] = f'current_baas_sha = "{sha}"'
            wrote_sha = True
        elif stripped.startswith("channel"):
            lines[index] = f'channel = "{channel}"'
            wrote_channel = True
    if not wrote_sha:
        lines.append(f'current_baas_sha = "{sha}"')
    if not wrote_channel:
        lines.append(f'channel = "{channel}"')
    setup_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
    (root / "cv2.py").write_text("from android_backend.cv2_compat import *\n", encoding="utf-8")


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
