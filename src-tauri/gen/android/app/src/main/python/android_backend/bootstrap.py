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
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATUS_FILE = "android-bootstrap-status.json"
PACKAGE_NAME = "io.github.kiramei.baas_tauri"
DEFAULT_CHANNEL = "dev"
_ATX_PROCESSES = []
_BACKEND_MODULE_ROOTS = (
    "android_runtime_injection",
    "core",
    "deploy",
    "module",
    "service",
    "tools",
)
_SERVER = None
_HOT_RESTART_DONE = False
_SERVER_LOCK = threading.RLock()
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


# Requests the embedded backend server to restart in the current app process.
def restart(files_dir=None, storage_root_or_port=None, port=None, native_library_dir=None):
    global _HOT_RESTART_DONE

    if _HOT_RESTART_DONE:
        return True
    _HOT_RESTART_DONE = True
    if files_dir is not None and storage_root_or_port is not None:
        _configure_environment(files_dir, storage_root_or_port, port, native_library_dir)
    threading.Thread(target=_exit_backend_process, name="baas-android-process-restart", daemon=True).start()
    return True


# Performs the start operation.
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

    _configure_environment(files_dir, storage_root, port, native_library_dir)

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


# Performs the configure environment operation.
def _configure_environment(files_dir, storage_root_or_port, port=None, native_library_dir=None):
    if port is None:
        port = storage_root_or_port
    os.environ["BAAS_SERVICE_HOST"] = "127.0.0.1"
    os.environ["BAAS_SERVICE_PORT"] = str(port)
    os.environ.setdefault("BAAS_SERVICE_OCR_UPDATE_CHECK", "1")
    os.environ.setdefault("BAAS_UPDATE_CHECK_INTERVAL_SECONDS", "86400")
    os.environ["BAAS_ANDROID"] = "1"
    os.environ.setdefault("BAAS_ALLOW_MISSING_OCR", "1")
    os.environ["BAAS_ANDROID_INTERNAL_FILES_DIR"] = str(files_dir)
    if native_library_dir:
        os.environ["BAAS_ANDROID_NATIVE_LIBRARY_DIR"] = str(native_library_dir)


# Performs the delayed restart operation.
def _delayed_restart(files_dir, storage_root, port, native_library_dir):
    time.sleep(0.1)
    restart(files_dir, storage_root, port, native_library_dir)


# Exits only the isolated Android backend service process.
def _exit_backend_process():
    time.sleep(0.2)
    os._exit(0)


# Handles the ensure backend files workflow.
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


# Handles the replace backend files workflow.
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


# Handles the setup channel workflow.
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


# Handles the write default setup workflow.
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


# Handles the download backend archive workflow.
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


# Handles the get github branch sha workflow.
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


# Handles the get git smart http branch sha workflow.
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


# Handles the write installed backend sha workflow.
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


# Handles the ensure android support files workflow.
def _ensure_android_support_files(root):
    _ensure_local_atx_agent(root)
    _write_android_runtime_injection(root)
    _write_watchfiles_stub(root)
    _write_pygit2_stub(root)
    _write_uiautomator2_stub(root)
    _write_cv2_stub(root)
    _write_psutil_stub(root)
    _write_desktop_only_stub(root, "pyautogui")
    _write_desktop_only_stub(root, "mss")


# Handles the ensure local atx agent workflow.
def _ensure_local_atx_agent(root):
    try:
        with urllib.request.urlopen("http://127.0.0.1:7912/version", timeout=1) as response:
            if response.read().strip():
                return
    except Exception:
        pass

    candidates = [Path("/data/local/tmp/atx-agent")]
    internal_dir = os.environ.get("BAAS_ANDROID_INTERNAL_FILES_DIR")
    if internal_dir:
        candidates.append(Path(internal_dir) / "atx-agent")

    abi = os.uname().machine if hasattr(os, "uname") else ""
    if abi in {"x86_64", "amd64"}:
        bundled = root / "src" / "atx_app" / "atx-agent_0.10.0_linux_amd64" / "atx-agent"
    elif abi in {"aarch64", "arm64"}:
        bundled = root / "src" / "atx_app" / "atx-agent_0.10.0_linux_arm64" / "atx-agent"
    elif abi.startswith("arm"):
        bundled = root / "src" / "atx_app" / "atx-agent_0.10.0_linux_armv7" / "atx-agent"
    else:
        bundled = root / "src" / "atx_app" / "atx-agent_0.10.0_linux_386" / "atx-agent"

    if internal_dir and bundled.exists() and not candidates[-1].exists():
        shutil.copyfile(bundled, candidates[-1])
        candidates[-1].chmod(0o755)

    for agent in candidates:
        if not agent.exists():
            continue
        try:
            process = subprocess.Popen(
                [str(agent), "server", "--nouia", "-d", "--addr", "127.0.0.1:7912"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            _ATX_PROCESSES.append(process)
            for _ in range(20):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:7912/version", timeout=0.5) as response:
                        if response.read().strip():
                            return
                except Exception:
                    time.sleep(0.1)
        except Exception:
            continue


# Handles the write android runtime injection workflow.
def _write_android_runtime_injection(root):
    (root / "android_runtime_injection.py").write_text(
        "import os\n"
        "from functools import wraps\n\n"
        "def _enabled():\n"
        "    return os.getenv('BAAS_ANDROID', '').lower() in {'1', 'true', 'yes', 'on'}\n\n"
        "def _sync_android_resolution(thread):\n"
        "    if not _enabled():\n"
        "        return\n"
        "    resolution = getattr(thread, 'resolution', None)\n"
        "    ratio = getattr(thread, 'ratio', None)\n"
        "    if resolution and ratio:\n"
        "        return\n"
        "    width = height = None\n"
        "    u2 = getattr(thread, 'u2', None)\n"
        "    if u2 is not None:\n"
        "        try:\n"
        "            info = u2.http.get('/info').json()\n"
        "            width = int(info['display']['width'])\n"
        "            height = int(info['display']['height'])\n"
        "        except Exception as exc:\n"
        "            try:\n"
        "                thread.logger.warning('Android resolution /info probe failed: ' + str(exc))\n"
        "            except Exception:\n"
        "                pass\n"
        "    if not width or not height:\n"
        "        latest = getattr(thread, 'latest_img_array', None)\n"
        "        if latest is not None and getattr(latest, 'ndim', 0) >= 2:\n"
        "            height, width = latest.shape[:2]\n"
        "    if not width or not height:\n"
        "        width, height = 1280, 720\n"
        "    if width < height:\n"
        "        width, height = height, width\n"
        "    thread.resolution = (width, height)\n"
        "    thread.ratio = width / 1280\n"
        "    try:\n"
        "        thread.logger.info('Android Screen Size synced: ' + str(thread.resolution))\n"
        "        thread.logger.info('Android Screen Size Ratio synced: ' + str(thread.ratio))\n"
        "    except Exception:\n"
        "        pass\n\n"
        "def _patch_baas_thread():\n"
        "    from core.Baas_thread import Baas_thread\n"
        "    if getattr(Baas_thread, '_baas_android_runtime_injected', False):\n"
        "        return\n"
        "    original_check_resolution = Baas_thread.check_resolution\n"
        "    original_update_screenshot_array = Baas_thread.update_screenshot_array\n\n"
        "    @wraps(original_check_resolution)\n"
        "    def check_resolution(self):\n"
        "        result = original_check_resolution(self)\n"
        "        _sync_android_resolution(self)\n"
        "        return result\n\n"
        "    @wraps(original_update_screenshot_array)\n"
        "    def update_screenshot_array(self):\n"
        "        result = original_update_screenshot_array(self)\n"
        "        _sync_android_resolution(self)\n"
        "        return result\n\n"
        "    Baas_thread.check_resolution = check_resolution\n"
        "    Baas_thread.update_screenshot_array = update_screenshot_array\n"
        "    Baas_thread._baas_android_runtime_injected = True\n\n"
        "def install():\n"
        "    try:\n"
        "        import service.injection as service_injection\n"
        "    except Exception:\n"
        "        return\n"
        "    if getattr(service_injection, '_baas_android_runtime_wrapped', False):\n"
        "        return\n"
        "    original_apply = service_injection.apply_service_injections\n\n"
        "    @wraps(original_apply)\n"
        "    def apply_service_injections():\n"
        "        result = original_apply()\n"
        "        _patch_baas_thread()\n"
        "        return result\n\n"
        "    service_injection.apply_service_injections = apply_service_injections\n"
        "    service_injection._baas_android_runtime_wrapped = True\n",
        encoding="utf-8",
    )


# Handles the write watchfiles stub workflow.
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


# Handles the write pygit2 stub workflow.
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


# Handles the write uiautomator2 stub workflow.
def _write_uiautomator2_stub(root):
    package = root / "uiautomator2"
    package.mkdir(exist_ok=True)
    (package / "version.py").write_text(
        "__version__ = 'android-local'\n"
        "__apk_version__ = '2.4.0'\n"
        "__atx_agent_version__ = '0.10.0'\n",
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        "import base64\n"
        "import io\n"
        "import json\n"
        "import re\n"
        "import time\n"
        "from urllib import parse, request\n\n"
        "from PIL import Image\n\n"
        "from .version import __apk_version__, __atx_agent_version__, __version__\n\n"
        "class UiAutomationNotConnectedError(RuntimeError):\n"
        "    pass\n\n"
        "class _JsonRpc:\n"
        "    def __init__(self, device):\n"
        "        self._device = device\n\n"
        "    def __getattr__(self, method):\n"
        "        def call(*params, **kwargs):\n"
        "            timeout = kwargs.pop('http_timeout', 60)\n"
        "            if kwargs:\n"
        "                params = params + (kwargs,)\n"
        "            return self._device._jsonrpc(method, list(params), timeout=timeout)\n"
        "        return call\n\n"
        "class _UiAutomator:\n"
        "    def __init__(self, device):\n"
        "        self._device = device\n\n"
        "    def start(self):\n"
        "        return self.running()\n\n"
        "    def running(self):\n"
        "        return self._device._uiautomator_alive()\n\n"
        "class _AdbDevice:\n"
        "    def shell(self, command, timeout=60):\n"
        "        return connect().shell(command, timeout=timeout)[0]\n\n"
        "class _HttpResponse:\n"
        "    def __init__(self, body):\n"
        "        self._body = body\n"
        "        self.text = body.decode('utf-8', errors='replace') if isinstance(body, bytes) else str(body)\n\n"
        "    def json(self):\n"
        "        return json.loads(self.text)\n\n"
        "class _HttpClient:\n"
        "    def __init__(self, device):\n"
        "        self._device = device\n\n"
        "    def get(self, path, timeout=10):\n"
        "        with request.urlopen(self._device._url(path), timeout=timeout) as response:\n"
        "            return _HttpResponse(response.read())\n\n"
        "class Device:\n"
        "    def __init__(self, serial='127.0.0.1:7912'):\n"
        "        serial = str(serial or '127.0.0.1:7912')\n"
        "        serial = serial.removeprefix('http://').removeprefix('https://')\n"
        "        self.serial = serial\n"
        "        self._base = 'http://' + serial.rstrip('/')\n"
        "        self.jsonrpc = _JsonRpc(self)\n"
        "        self.uiautomator = _UiAutomator(self)\n"
        "        self.http = _HttpClient(self)\n"
        "        self._adb_device = _AdbDevice()\n\n"
        "    def _url(self, path):\n"
        "        return self._base + path\n\n"
        "    def __call__(self, *_args, **_kwargs):\n"
        "        return self\n\n"
        "    def _agent_alive(self):\n"
        "        try:\n"
        "            with request.urlopen(self._url('/version'), timeout=1) as response:\n"
        "                return bool(response.read().strip())\n"
        "        except Exception:\n"
        "            return False\n\n"
        "    def _uiautomator_alive(self):\n"
        "        try:\n"
        "            self._jsonrpc('deviceInfo', [], timeout=2)\n"
        "            return True\n"
        "        except Exception:\n"
        "            return False\n\n"
        "    def _jsonrpc(self, method, params=None, timeout=60):\n"
        "        body = json.dumps({\n"
        "            'jsonrpc': '2.0',\n"
        "            'id': f'android-local-{method}',\n"
        "            'method': method,\n"
        "            'params': params or [],\n"
        "        }).encode('utf-8')\n"
        "        req = request.Request(\n"
        "            self._url('/jsonrpc/0'),\n"
        "            data=body,\n"
        "            headers={'Content-Type': 'application/json'},\n"
        "            method='POST',\n"
        "        )\n"
        "        try:\n"
        "            with request.urlopen(req, timeout=timeout) as response:\n"
        "                payload = json.loads(response.read().decode('utf-8'))\n"
        "        except Exception as exc:\n"
        "            raise UiAutomationNotConnectedError(str(exc)) from exc\n"
        "        if payload.get('error'):\n"
        "            raise RuntimeError(payload['error'])\n"
        "        return payload.get('result')\n\n"
        "    def shell(self, cmdargs, stream=False, timeout=60):\n"
        "        if isinstance(cmdargs, (list, tuple)):\n"
        "            command = ' '.join(str(part) for part in cmdargs)\n"
        "        else:\n"
        "            command = str(cmdargs)\n"
        "        if stream:\n"
        "            raise NotImplementedError('android-local shell streaming is not implemented')\n"
        "        data = parse.urlencode({'command': command, 'timeout': str(timeout)}).encode('utf-8')\n"
        "        req = request.Request(self._url('/shell'), data=data, method='POST')\n"
        "        try:\n"
        "            with request.urlopen(req, timeout=timeout + 10) as response:\n"
        "                payload = json.loads(response.read().decode('utf-8'))\n"
        "        except Exception as exc:\n"
        "            raise UiAutomationNotConnectedError(str(exc)) from exc\n"
        "        output = payload.get('output') or payload.get('stdout') or ''\n"
        "        exit_code = payload.get('exitCode')\n"
        "        if exit_code is None:\n"
        "            exit_code = 1 if payload.get('error') else 0\n"
        "        return output, exit_code\n\n"
        "    def app_current(self):\n"
        "        try:\n"
        "            info = self._jsonrpc('deviceInfo', [], timeout=3)\n"
        "            package = (info or {}).get('currentPackageName') or ''\n"
        "            if package:\n"
        "                return {'package': package, 'activity': ''}\n"
        "        except Exception:\n"
        "            pass\n"
        "        output, _ = self.shell(['dumpsys', 'window', 'windows'], timeout=10)\n"
        "        match = re.search(r'mCurrentFocus=Window\\{.*?\\s+([^\\s]+)/([^\\s]+)\\}', output)\n"
        "        if match:\n"
        "            return {'package': match.group(1), 'activity': match.group(2)}\n"
        "        output, _ = self.shell(['dumpsys', 'activity', 'top'], timeout=10)\n"
        "        match = re.search(r'ACTIVITY\\s+([^\\s]+)/([^/\\s]+).*?pid=(\\d+)', output)\n"
        "        if match:\n"
        "            return {'package': match.group(1), 'activity': match.group(2), 'pid': int(match.group(3))}\n"
        "        return {'package': '', 'activity': ''}\n\n"
        "    def screenshot(self, filename=None, format='pillow'):\n"
        "        try:\n"
        "            encoded = self._jsonrpc('takeScreenshot', [1.0, 80], timeout=10)\n"
        "            if not encoded:\n"
        "                raise RuntimeError('takeScreenshot returned empty data')\n"
        "            image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert('RGB')\n"
        "        except Exception as exc:\n"
        "            raise UiAutomationNotConnectedError(str(exc)) from exc\n"
        "        if filename:\n"
        "            image.save(filename)\n"
        "        return image\n\n"
        "    def click(self, x, y):\n"
        "        return self.jsonrpc.click(int(x), int(y))\n\n"
        "    def swipe(self, fx, fy, tx, ty, duration=None, steps=None):\n"
        "        if steps is None:\n"
        "            steps = max(2, int((duration or 0.1) * 200))\n"
        "        return self.jsonrpc.swipe(int(fx), int(fy), int(tx), int(ty), int(steps))\n\n"
        "    def long_click(self, x, y, duration=0.5):\n"
        "        return self.swipe(x, y, x, y, duration=duration)\n\n"
        "    def pinch_in(self, percent=50, steps=30):\n"
        "        return True\n\n"
        "    def pinch_out(self, percent=50, steps=30):\n"
        "        return True\n\n"
        "    def _launcher_component(self, package_name):\n"
        "        output, exit_code = self.shell(['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '-c', 'android.intent.category.LAUNCHER', package_name], timeout=10)\n"
        "        if exit_code != 0:\n"
        "            raise RuntimeError(output)\n"
        "        for line in reversed([part.strip() for part in output.splitlines() if part.strip()]):\n"
        "            if '/' in line and line.startswith(package_name + '/'):\n"
        "                return line\n"
        "        raise RuntimeError(f'Unable to resolve launcher activity for {package_name}: {output}')\n\n"
        "    def app_start(self, package_name, activity=None, wait=False, stop=False):\n"
        "        if stop:\n"
        "            self.app_stop(package_name)\n"
        "        if activity:\n"
        "            component = f'{package_name}/{activity}'\n"
        "        else:\n"
        "            component = self._launcher_component(package_name)\n"
        "        command = ['am', 'start', '--user', '0', '-n', component]\n"
        "        output, exit_code = self.shell(command, timeout=20)\n"
        "        if exit_code != 0:\n"
        "            raise RuntimeError(output)\n"
        "        if wait:\n"
        "            time.sleep(1)\n"
        "        return output\n\n"
        "    def app_stop(self, package_name):\n"
        "        output, exit_code = self.shell(['am', 'force-stop', '--user', '0', package_name], timeout=10)\n"
        "        if exit_code != 0:\n"
        "            raise RuntimeError(output)\n"
        "        return output\n\n"
        "    def press(self, key, meta=None):\n"
        "        if isinstance(key, int):\n"
        "            return self.jsonrpc.pressKeyCode(key, meta) if meta else self.jsonrpc.pressKeyCode(key)\n"
        "        return self.jsonrpc.pressKey(str(key))\n\n"
        "    def dump_hierarchy(self, compressed=False, pretty=False):\n"
        "        return self.jsonrpc.dumpWindowHierarchy(bool(compressed), None)\n\n"
        "    def implicitly_wait(self, seconds=None):\n"
        "        return 0\n\n"
        "def connect(serial='127.0.0.1:7912'):\n"
        "    return Device(serial)\n\n"
        "def connect_usb(serial=None):\n"
        "    return Device(serial or '127.0.0.1:7912')\n",
        encoding="utf-8",
    )


# Handles the write cv2 stub workflow.
def _write_cv2_stub(root):
    (root / "cv2.py").write_text("from android_backend.cv2_compat import *\n", encoding="utf-8")


# Handles the write psutil stub workflow.
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


# Handles the write desktop only stub workflow.
def _write_desktop_only_stub(root, module_name):
    (root / f"{module_name}.py").write_text(
        "def __getattr__(name):\n"
        f"    raise RuntimeError('{module_name} is not available on Android')\n",
        encoding="utf-8",
    )


# Handles the service path workflow.
def _service_path(root):
    return root / "main.service.py"


# Handles the run baas service workflow.
def _run_baas_service(root, port):
    global _SERVER

    import uvicorn

    server = None
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
    _clear_backend_modules()
    try:
        import android_runtime_injection
        from service import set_log_format

        android_runtime_injection.install()
        set_log_format()
        app = _build_baas_asgi_app(root, port)
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=int(port),
            reload=False,
            log_level="info",
            log_config=None,
        )
        server = uvicorn.Server(config)
        with _SERVER_LOCK:
            _SERVER = server
        (root / ".pid").write_text(str(os.getpid()), encoding="utf-8")
        server.run()
    finally:
        with _SERVER_LOCK:
            if server is not None and _SERVER is server:
                _SERVER = None
        (root / ".pid").unlink(missing_ok=True)
        os.chdir(cwd)
        sys.argv = old_argv


# Performs the clear backend modules operation.
def _clear_backend_modules():
    for name in list(sys.modules):
        if name in _BACKEND_MODULE_ROOTS or name.startswith(tuple(f"{root}." for root in _BACKEND_MODULE_ROOTS)):
            sys.modules.pop(name, None)
    try:
        import pydantic.class_validators as class_validators

        class_validators._FUNCS.clear()
    except Exception:
        pass


# Builds the ASGI app and reserves a bootstrap-owned restart endpoint.
def _build_baas_asgi_app(root, port):
    from service.app import app as service_app

    async def app(scope, receive, send):
        if scope.get("type") == "http" and scope.get("path") == "/android/bootstrap-restart":
            body = json.dumps({"ok": True, "restartScheduled": True}, ensure_ascii=False).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json; charset=utf-8"),
                        (b"content-length", str(len(body)).encode("ascii")),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            threading.Thread(
                target=_delayed_restart,
                args=(os.environ.get("BAAS_ANDROID_INTERNAL_FILES_DIR", ""), root, port, None),
                name="baas-android-delayed-restart",
                daemon=True,
            ).start()
            return
        await service_app(scope, receive, send)

    return app


# Handles the write status workflow.
def _write_status(root, status):
    root.mkdir(parents=True, exist_ok=True)
    (root / STATUS_FILE).write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")


# Handles the read status workflow.
def _read_status(root, fallback):
    path = root / STATUS_FILE
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


# Handles the run bootstrap server workflow.
def _run_bootstrap_server(port, root, initial_status):
    class Handler(BaseHTTPRequestHandler):
        # Handles the do get workflow.
        def do_GET(self):
            if self.path.startswith("/health") or self.path.startswith("/auth/remember"):
                self._json(_read_status(root, initial_status))
                return
            self.send_error(404)

        # Handles the json workflow.
        def _json(self, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # Handles the log message workflow.
        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="baas-bootstrap-http", daemon=True).start()
