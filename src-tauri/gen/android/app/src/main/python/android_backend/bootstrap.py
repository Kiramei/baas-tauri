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
ANDROID_OVERLAY_FILES = (
    "service/android_debug.py",
    "service/android_local_device.py",
    "service/android_modes.py",
    "service/api/http.py",
    "service/injection.py",
)
SERVICE_TRANSPORT_OVERLAY_FILES = (
    "service/app.py",
    "service/channels/__init__.py",
    "service/channels/provider.py",
    "service/channels/remote.py",
    "service/channels/sync.py",
    "service/channels/trigger.py",
    "service/conf/manager.py",
    "service/transport/__init__.py",
    "service/transport/base.py",
    "service/transport/framing.py",
    "service/transport/pipe_endpoint.py",
    "service/transport/pipe_server.py",
    "service/transport/websocket_endpoint.py",
    "service/update/setup_schema.py",
)
_SERVER = None
_HOT_RESTART_DONE = False
_SERVER_LOCK = threading.RLock()
_ATX_START_LOCK = threading.RLock()
_ATX_START_THREAD = None
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
        _activate_bundled_service_transport(root)
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
    os.environ["BAAS_PIPE_NAME"] = str(Path(files_dir) / "baas-service.sock")
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
        if _bundled_backend_changed(root):
            if _backend_is_git_managed(root):
                status["installing"] = False
                status["installMessage"] = "Using git-managed backend; APK bundle will not replace repository metadata."
                _write_status(root, status)
                _ensure_android_support_files(root)
                _start_local_atx_agent_async_if_enabled(root)
                return False
            tmp_root = root / ".baas-next"
            shutil.rmtree(tmp_root, ignore_errors=True)
            status["installing"] = True
            status["installMessage"] = "Updating BAAS backend from bundled APK archive."
            _write_status(root, status)
            remote_sha = _install_bundled_backend_archive(tmp_root)
            _ensure_android_support_files(tmp_root)
            _replace_backend_files(root, tmp_root)
            _start_local_atx_agent_async_if_enabled(root)
            if remote_sha:
                _write_installed_backend_sha(root / "setup.toml", remote_sha, _setup_channel(root))
            status["installing"] = False
            return True
        _ensure_android_support_files(root)
        _start_local_atx_agent_async_if_enabled(root)
        return False

    tmp_root = root / ".baas-next"
    shutil.rmtree(tmp_root, ignore_errors=True)
    status["installing"] = True
    status["installMessage"] = "Downloading BAAS backend repository."
    _write_status(root, status)
    channel = _setup_channel(root)
    remote_sha = _install_bundled_backend_archive(tmp_root)
    if remote_sha is None:
        remote_sha = _download_backend_archive(tmp_root, channel)
    _ensure_android_support_files(tmp_root)
    _replace_backend_files(root, tmp_root)
    _start_local_atx_agent_async_if_enabled(root)
    if remote_sha:
        _write_installed_backend_sha(root / "setup.toml", remote_sha, channel)
    status["installing"] = False
    return True


# Returns the bundled backend zip path if the APK contains one.
def _bundled_backend_archive():
    return Path(__file__).with_name("baas_backend_bundle.zip")


# Installs the backend archive bundled into the APK, returning its source sha if available.
def _install_bundled_backend_archive(target_root):
    archive_path = _bundled_backend_archive()
    if not archive_path.exists():
        return None
    target_root.parent.mkdir(parents=True, exist_ok=True)
    if target_root.exists():
        shutil.rmtree(target_root, ignore_errors=True)
    target_root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(target_root)
    source_path = target_root / "android-backend-source.json"
    if not source_path.exists():
        return ""
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    return payload.get("sha", "")


# Returns whether the backend bundled in the APK differs from the installed runtime copy.
def _bundled_backend_changed(root):
    archive_path = _bundled_backend_archive()
    if not archive_path.exists():
        return False
    bundled_payload = _read_bundled_backend_source_payload(archive_path)
    if not bundled_payload:
        return False
    installed_path = root / "android-backend-source.json"
    if not installed_path.exists():
        return True
    try:
        installed_payload = json.loads(installed_path.read_text(encoding="utf-8"))
    except Exception:
        return True
    return installed_payload != bundled_payload


# Reads the source metadata stored in the bundled backend zip.
def _read_bundled_backend_source_payload(archive_path):
    try:
        with zipfile.ZipFile(archive_path) as archive:
            with archive.open("android-backend-source.json") as source_file:
                return json.loads(source_file.read().decode("utf-8"))
    except Exception:
        return None


def _backend_is_git_managed(root):
    git_path = root / ".git"
    return git_path.exists()


# Handles the replace backend files workflow.
def _replace_backend_files(root, tmp_root):
    preserved_names = {".app_storage.json", ".baas-updater", ".git", "config", "files", "setup.toml"}
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
    _apply_bundled_android_overlay(root)
    _patch_scrcpy_virtual_display(root)
    _patch_android_scrcpy_mediacodec(root)
    _patch_android_scrcpy_config_manager(root)
    _patch_android_scrcpy_service_injection(root)
    _patch_android_virtual_display_loading_detection(root)
    _write_android_runtime_injection(root)
    _write_android_direct_adb_server(root)
    _write_android_media_codec_decoder(root)
    _write_watchfiles_stub(root)
    _write_pygit2_stub(root)
    _write_uiautomator2_stub(root)
    _write_cv2_stub(root)
    _write_psutil_stub(root)
    _write_desktop_only_stub(root, "pyautogui")
    _write_desktop_only_stub(root, "mss")


# Applies Android-specific backend files from the APK bundle over a git-updated
# runtime tree. Git updates may replace these files with desktop/uiautomator
# implementations, but embedded Android control needs Android-specific runtime
# patches. Virtual-display mode uses scrcpy; the accessibility bridge is only
# the fallback for non-virtual-display Android-local mode.
def _apply_bundled_android_overlay(root):
    archive_path = _bundled_backend_archive()
    if not archive_path.exists():
        return
    try:
        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            for relative_name in ANDROID_OVERLAY_FILES:
                if relative_name not in names:
                    continue
                target = root / relative_name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(relative_name) as source:
                    target.write_bytes(source.read())
                if target.suffix == ".py":
                    pycache = target.parent / "__pycache__"
                    if pycache.exists():
                        for cached in pycache.glob(f"{target.stem}.*.pyc"):
                            cached.unlink(missing_ok=True)
    except Exception as exc:
        print(f"Android backend overlay failed: {exc}", flush=True)


# Loads the client-matched service transport without modifying the user's backend tree.
def _activate_bundled_service_transport(root):
    archive_path = _bundled_backend_archive()
    files_dir = os.environ.get("BAAS_ANDROID_INTERNAL_FILES_DIR", "").strip()
    if not files_dir:
        return
    overlay_root = Path(files_dir) / "backend-service-overlay"
    try:
        if archive_path.exists():
            shutil.rmtree(overlay_root, ignore_errors=True)
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())
                for relative_name in SERVICE_TRANSPORT_OVERLAY_FILES:
                    if relative_name not in names:
                        raise RuntimeError(f"Bundled backend is missing {relative_name}")
                    target = overlay_root / relative_name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(relative_name) as source:
                        target.write_bytes(source.read())
        else:
            missing = [
                relative_name
                for relative_name in SERVICE_TRANSPORT_OVERLAY_FILES
                if not (overlay_root / relative_name).exists()
            ]
            if missing:
                raise RuntimeError(
                    f"Bundled backend archive is unavailable and overlay is incomplete: {missing[0]}"
                )

        for package_path in ("service", "service/conf", "service/update"):
            overlay_package = overlay_root / package_path
            external_package = root / package_path
            external_init = external_package / "__init__.py"
            (overlay_package / "__init__.py").write_text(
                f"__path__ = [{str(overlay_package)!r}, {str(external_package)!r}]\n"
                f"_external_init = {str(external_init)!r}\n"
                "with open(_external_init, 'rb') as _source:\n"
                "    exec(compile(_source.read(), _external_init, 'exec'), globals(), globals())\n",
                encoding="utf-8",
            )
        os.environ["BAAS_SERVICE_OVERLAY_ROOT"] = str(overlay_root)
    except Exception as exc:
        print(f"Android service transport overlay failed: {exc}", flush=True)


def _patch_scrcpy_virtual_display(root):
    core_path = root / "core" / "device" / "scrcpy" / "core.py"
    if not core_path.exists():
        _patch_android_scrcpy_runtime_selection(root)
        return
    _ensure_python_import(core_path, "os")
    try:
        text = core_path.read_text(encoding="utf-8")
    except Exception:
        text = ""
    marker = "BAAS_ANDROID_SCRCPY_DISPLAY_ID_PATCH"
    if marker not in text:
        needle = '            "clipboard_autosync=false",\n        ]'
        replacement = (
            '            "clipboard_autosync=false",\n'
            '        ]\n'
            f"        # {marker}\n"
            "        display_id = os.getenv('BAAS_SCRCPY_DISPLAY_ID', '').strip()\n"
            "        if not display_id:\n"
            "            display_id_file = os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip()\n"
            "            if not display_id_file:\n"
            "                display_id_file = os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt')\n"
            "            try:\n"
            "                with open(display_id_file, 'r', encoding='utf-8') as handle:\n"
            "                    display_id = handle.read().strip()\n"
            "            except OSError:\n"
            "                display_id = ''\n"
            "        if display_id:\n"
            "            commands.append(f'display_id={display_id}')"
        )
        if needle in text:
            try:
                core_path.write_text(text.replace(needle, replacement), encoding="utf-8")
            except Exception:
                pass
    _patch_android_scrcpy_runtime_selection(root)


def _patch_android_scrcpy_mediacodec(root):
    core_path = root / "core" / "device" / "scrcpy" / "core.py"
    if not core_path.exists():
        return
    try:
        text = core_path.read_text(encoding="utf-8")
    except Exception:
        return
    marker = "BAAS_ANDROID_SCRCPY_MEDIACODEC_PATCH_V1"
    if marker in text:
        return
    needle = (
        "        from av.codec import CodecContext\n"
        "        from av.error import InvalidDataError\n"
    )
    replacement = (
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "            from android_media_codec_decoder import AndroidH264Decoder\n"
        "            decoder = AndroidH264Decoder(self.resolution[0], self.resolution[1], self.flip)\n"
        "            try:\n"
        "                while self.alive:\n"
        "                    try:\n"
        "                        raw_h264 = self.__video_socket.recv(0x10000)\n"
        "                        if raw_h264 == b'':\n"
        "                            raise ConnectionError('Video stream is disconnected')\n"
        "                        frame = decoder.decode(raw_h264)\n"
        "                        if frame is not None:\n"
        "                            self.last_frame = frame\n"
        "                            self.resolution = (frame.shape[1], frame.shape[0])\n"
        "                            self.last_frame_time = time.time()\n"
        "                    except BlockingIOError:\n"
        "                        time.sleep(0.01)\n"
        "                    except (ConnectionError, OSError) as e:\n"
        "                        if self.alive:\n"
        "                            self.__send_to_listeners(EVENT_DISCONNECT)\n"
        "                            self.stop()\n"
        "                            raise e\n"
        "            finally:\n"
        "                decoder.close()\n"
        "            return\n\n"
        "        from av.codec import CodecContext\n"
        "        from av.error import InvalidDataError\n"
    )
    if needle not in text:
        return
    try:
        core_path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")
    except Exception:
        return


def _patch_android_scrcpy_runtime_selection(root):
    marker = "BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V4"

    connection_path = root / "core" / "device" / "connection.py"
    _ensure_python_import(connection_path, "os")
    _replace_once(
        connection_path,
        marker,
        "        self.adbIP = self.config.adbIP\n"
        "        self.adbPort = self.config.adbPort\n",
        "        self.adbIP = self.config.adbIP\n"
        "        self.adbPort = self.config.adbPort\n"
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "            self.adbIP = '127.0.0.1'\n"
        "            self.adbPort = '5555'\n"
        "            try:\n"
        "                import android_direct_adb_server\n"
        "                direct_adb_port = android_direct_adb_server.start('127.0.0.1:5555')\n"
        "                os.environ['ANDROID_ADB_SERVER_HOST'] = '127.0.0.1'\n"
        "                os.environ['ANDROID_ADB_SERVER_PORT'] = str(direct_adb_port)\n"
        "                try:\n"
        "                    adb._BaseClient__host = '127.0.0.1'\n"
        "                    adb._BaseClient__port = int(direct_adb_port)\n"
        "                except Exception:\n"
        "                    pass\n"
        "                self.logger.info(f'Android direct ADB server : 127.0.0.1:{direct_adb_port}')\n"
        "            except Exception as exc:\n"
        "                self.logger.warning('Android direct ADB server failed: ' + str(exc))\n",
    )
    _replace_old_scrcpy_runtime_block(connection_path, marker)

    screenshot_path = root / "core" / "device" / "Screenshot.py"
    _replace_once(
        screenshot_path,
        marker,
        "import sys\n",
        "import sys\nimport os\n",
    )
    _replace_once(
        screenshot_path,
        marker,
        "        self.method = self.config.screenshot_method\n"
        "        self.logger.info(\"Screenshot method : \" + self.method)\n",
        "        self.method = self.config.screenshot_method\n"
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "            self.method = 'adb'\n"
        "        self.logger.info(\"Screenshot method : \" + self.method)\n",
    )
    _replace_text_fragments(
        screenshot_path,
        [
            ("            self.method = 'android_local'\n", "            self.method = 'adb'\n"),
            ('            self.method = "android_local"\n', '            self.method = "adb"\n'),
            ("            self.method = 'scrcpy'\n", "            self.method = 'adb'\n"),
            ('            self.method = "scrcpy"\n', '            self.method = "adb"\n'),
        ],
    )
    _replace_old_scrcpy_runtime_block(screenshot_path, marker)

    control_path = root / "core" / "device" / "Control.py"
    _replace_once(
        control_path,
        marker,
        "import sys\n",
        "import sys\nimport os\n",
    )
    _replace_once(
        control_path,
        marker,
        "        self.method = self.config.control_method\n"
        "        self.logger.info(\"Control method : \" + self.method)\n",
        "        self.method = self.config.control_method\n"
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "            self.method = 'adb'\n"
        "        self.logger.info(\"Control method : \" + self.method)\n",
    )
    _replace_text_fragments(
        control_path,
        [
            ("            self.method = 'android_local'\n", "            self.method = 'adb'\n"),
            ('            self.method = "android_local"\n', '            self.method = "adb"\n'),
            ("            self.method = 'scrcpy'\n", "            self.method = 'adb'\n"),
            ('            self.method = "scrcpy"\n', '            self.method = "adb"\n'),
        ],
    )
    _replace_old_scrcpy_runtime_block(control_path, marker)
    _patch_android_virtual_display_adb_io(root)


def _patch_android_scrcpy_config_manager(root):
    marker = "BAAS_ANDROID_SCRCPY_CONFIG_MANAGER_PATCH_V1"
    manager_path = root / "service" / "conf" / "manager.py"
    _ensure_python_import(manager_path, "os")
    old = (
        "        normalized[\"control_method\"] = ANDROID_LOCAL_METHOD\n"
        "        normalized[\"screenshot_method\"] = ANDROID_LOCAL_METHOD\n"
        "        return normalized\n"
    )
    new = (
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "            normalized['adbIP'] = '127.0.0.1'\n"
        "            normalized['adbPort'] = '5555'\n"
        "            normalized['control_method'] = 'adb'\n"
        "            normalized['screenshot_method'] = 'adb'\n"
        "            return normalized\n"
        "        normalized[\"control_method\"] = ANDROID_LOCAL_METHOD\n"
        "        normalized[\"screenshot_method\"] = ANDROID_LOCAL_METHOD\n"
        "        return normalized\n"
    )
    _replace_once(manager_path, marker, old, new)
    _replace_text_fragments(
        manager_path,
        [
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
                "            normalized['adbIP'] = '127.0.0.1'\n"
                "            normalized['adbPort'] = '5555'\n"
                "            normalized['control_method'] = ANDROID_LOCAL_METHOD\n"
                "            normalized['screenshot_method'] = ANDROID_LOCAL_METHOD\n"
                "            return normalized\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
                "            normalized['adbIP'] = '127.0.0.1'\n"
                "            normalized['adbPort'] = '5555'\n"
                "            normalized['control_method'] = 'adb'\n"
                "            normalized['screenshot_method'] = 'adb'\n"
                "            return normalized\n",
            ),
            (
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
                "            normalized['adbIP'] = '127.0.0.1'\n"
                "            normalized['adbPort'] = '5555'\n"
                "            normalized['control_method'] = 'scrcpy'\n"
                "            normalized['screenshot_method'] = 'scrcpy'\n"
                "            return normalized\n",
                "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
                "            normalized['adbIP'] = '127.0.0.1'\n"
                "            normalized['adbPort'] = '5555'\n"
                "            normalized['control_method'] = 'adb'\n"
                "            normalized['screenshot_method'] = 'adb'\n"
                "            return normalized\n",
            ),
        ],
    )


def _patch_android_virtual_display_adb_io(root):
    marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_ADB_IO_PATCH_V1"

    screenshot_path = root / "core" / "device" / "screenshot" / "adb.py"
    _ensure_python_import(screenshot_path, "os")
    _replace_once(
        screenshot_path,
        marker,
        "        data = self.adb.shell(['screencap', '-p'], stream=False, encoding=None)\n",
        f"        # {marker}\n"
        "        display_id = _baas_android_virtual_display_id()\n"
        "        command = ['screencap', '-d', display_id, '-p'] if display_id else ['screencap', '-p']\n"
        "        data = self.adb.shell(command, stream=False, encoding=None)\n",
    )
    _append_once(
        screenshot_path,
        marker + "_HELPER",
        f"""

# {marker}_HELPER
def _baas_android_virtual_display_id():
    candidates = [
        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),
        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),
        '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',
    ]
    for path in candidates:
        if not path:
            continue
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    return ''
""",
    )

    control_path = root / "core" / "device" / "control" / "adb.py"
    _ensure_python_import(control_path, "os")
    _replace_once(
        control_path,
        marker,
        "        self.adb = adb.device(self.serial)\n",
        f"        self.adb = adb.device(self.serial)\n"
        f"        # {marker}\n"
        "        self.display_id = _baas_android_virtual_display_id()\n",
    )
    _replace_text_fragments(
        control_path,
        [
            (
                "        self.adb.shell(f'input tap {x} {y}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'tap {x} {y}'))\n",
            ),
            (
                "        self.adb.shell(f'input swipe {x1} {y1} {x2} {y2} {duration}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'swipe {x1} {y1} {x2} {y2} {duration}'))\n",
            ),
            (
                "        self.adb.shell(f'input swipe {x} {y} {x} {y} {duration}')\n",
                "        self.adb.shell(_baas_android_input_command(self.display_id, f'swipe {x} {y} {x} {y} {duration}'))\n",
            ),
        ],
    )
    _append_once(
        control_path,
        marker + "_HELPER",
        f"""

# {marker}_HELPER
def _baas_android_virtual_display_id():
    candidates = [
        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),
        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),
        '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',
    ]
    for path in candidates:
        if not path:
            continue
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                value = handle.read().strip()
            if value:
                return value
        except OSError:
            pass
    return ''


def _baas_android_input_command(display_id, operation):
    return f'input -d {{display_id}} {{operation}}' if display_id else f'input {{operation}}'
""",
    )


def _patch_android_scrcpy_service_injection(root):
    marker = "BAAS_ANDROID_SCRCPY_SERVICE_INJECTION_PATCH_V1"
    to_main_page_marker = "BAAS_ANDROID_SCRCPY_TO_MAIN_PAGE_PATCH_V1"
    news_modal_marker = "BAAS_ANDROID_NEWS_MODAL_CLOSE_PATCH_V1"
    main_page_match_marker = "BAAS_ANDROID_MAIN_PAGE_MATCH_PATCH_V2"
    path = root / "service" / "injection.py"
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    uses_crlf = "\r\n" in text
    text = text.replace("\r\n", "\n")
    next_text = text
    import_header = next_text.split("\n\n_APPLIED", 1)[0]
    if not any(line.strip() == "import time" for line in import_header.splitlines()):
        next_text = next_text.replace("import sys\n", "import sys\nimport time\n", 1)
    if marker not in next_text:
        helper_needle = (
            "def _env_enabled(name: str) -> bool:\n"
            "    return os.getenv(name, \"\").strip().lower() in {\"1\", \"true\", \"yes\", \"on\"}\n"
        )
        helper_replacement = (
            helper_needle +
            "\n"
            f"# {marker}\n"
            "def _scrcpy_virtual_display_enabled() -> bool:\n"
            "    display_id_candidates = [\n"
            "        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
            "        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
            f"        '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
            "    ]\n"
            "    return any(candidate and os.path.exists(candidate) for candidate in display_id_candidates)\n"
        )
        if helper_needle not in next_text:
            return
        next_text = next_text.replace(helper_needle, helper_replacement, 1)
        replacements = [
            (
                "        def connection_init(self, Baas_instance, skip_package_detection=False):\n"
                "            if _env_enabled(\"BAAS_ANDROID\"):\n",
                "        def connection_init(self, Baas_instance, skip_package_detection=False):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and not _scrcpy_virtual_display_enabled():\n",
            ),
            (
                "        def get_current_package(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\"):\n",
                "        def get_current_package(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and not _scrcpy_virtual_display_enabled():\n",
            ),
            (
                "        def init_control_instance(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and self.Baas_instance.is_android_device:\n",
                "        def init_control_instance(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and self.Baas_instance.is_android_device and not _scrcpy_virtual_display_enabled():\n",
            ),
            (
                "        def init_screenshot_instance(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and self.Baas_instance.is_android_device:\n",
                "        def init_screenshot_instance(self):\n"
                "            if _env_enabled(\"BAAS_ANDROID\") and self.Baas_instance.is_android_device and not _scrcpy_virtual_display_enabled():\n",
            ),
        ]
        for needle, replacement in replacements:
            next_text = next_text.replace(needle, replacement, 1)
    if to_main_page_marker not in next_text:
        needle = (
            "        self.logger.info(\"Android embedded mode foregrounds game before task navigation.\")\n"
            "        start_android_activity(self.package_name, self.activity_name, self.logger)\n"
            "        time.sleep(6)\n"
            "        self.logger.info(\"Android embedded mode delegates to standard main-page detector.\")\n"
            "        return original_to_main_page(self, skip_first_screenshot)\n"
        )
        replacement = (
            f"        # {to_main_page_marker}\n"
            "        if _scrcpy_virtual_display_enabled():\n"
            "            self.logger.info(\"Android virtual display active; keep game on virtual display before main-page detector.\")\n"
            "            return original_to_main_page(self, skip_first_screenshot)\n"
            "        self.logger.info(\"Android embedded mode foregrounds game before task navigation.\")\n"
            "        start_android_activity(self.package_name, self.activity_name, self.logger)\n"
            "        time.sleep(6)\n"
            "        self.logger.info(\"Android embedded mode delegates to standard main-page detector.\")\n"
            "        return original_to_main_page(self, skip_first_screenshot)\n"
        )
        if needle in next_text:
            next_text = next_text.replace(needle, replacement, 1)
    if news_modal_marker not in next_text:
        next_text = next_text.replace(
            "    original_match_rgb_feature = color.match_rgb_feature\n",
            "    original_match_rgb_feature = color.match_rgb_feature\n"
            "    original_deal_with_pop_ups = picture.deal_with_pop_ups\n",
            1,
        )
        helper_needle = (
            "    @wraps(original_match_rgb_feature)\n"
            "    def match_rgb_feature(baas, feature_name):\n"
        )
        helper_replacement = (
            f"    # {news_modal_marker}\n"
            "    def _android_match_news_close_button(baas):\n"
            "        img = getattr(baas, \"latest_img_array\", None)\n"
            "        if img is None or getattr(img, \"ndim\", 0) < 3:\n"
            "            return False\n"
            "        height, width = img.shape[:2]\n"
            "        if width != 1280 or height != 720:\n"
            "            return False\n"
            "        white = (230, 255, 230, 255, 230, 255)\n"
            "        blue = (20, 90, 120, 190, 220, 255)\n"
            "        modal_gray = (80, 140, 95, 145, 110, 165)\n"
            "        close_white_points = ((1132, 94), (1142, 104), (1152, 114))\n"
            "        close_blue_points = ((1100, 100), (1120, 104), (1160, 104), (1140, 80), (1140, 130))\n"
            "        header_points = ((130, 170), (450, 170), (900, 170))\n"
            "        white_hits = sum(1 for x, y in close_white_points if _android_pixel_in_range(baas, x, y, white))\n"
            "        blue_hits = sum(1 for x, y in close_blue_points if _android_pixel_in_range(baas, x, y, blue))\n"
            "        header_hits = sum(1 for x, y in header_points if _android_pixel_in_range(baas, x, y, modal_gray))\n"
            "        return white_hits >= 2 and blue_hits >= 4 and header_hits >= 2\n"
            "\n"
            + helper_needle
        )
        next_text = next_text.replace(helper_needle, helper_replacement, 1)
        wrapper_needle = "    picture.co_detect = co_detect\n"
        wrapper_replacement = (
            "    @wraps(original_deal_with_pop_ups)\n"
            "    def deal_with_pop_ups(baas, pop_ups_rgb_reactions=None, pop_ups_img_reactions=None):\n"
            "        if _env_enabled(\"BAAS_ANDROID\") and _android_match_news_close_button(baas):\n"
            "            baas.logger.info(\"Found Android main page news modal close button\")\n"
            "            baas.click(1142, 104)\n"
            "            baas.last_click_time = time.time()\n"
            "            baas.last_click_position = (1142, 104)\n"
            "            baas.last_click_name = \"android_main_page_news\"\n"
            "            return True, \"android_main_page_news\"\n"
            "        return original_deal_with_pop_ups(baas, pop_ups_rgb_reactions, pop_ups_img_reactions)\n"
            "\n"
            "    picture.co_detect = co_detect\n"
            "    picture.deal_with_pop_ups = deal_with_pop_ups\n"
        )
        next_text = next_text.replace(wrapper_needle, wrapper_replacement, 1)
    if main_page_match_marker not in next_text:
        replacements = [
            (
                "        left_profile = (0, 45, 35, 85, 65, 115)\n"
                "        left_profile_points = (\n"
                "            (60, 45),\n"
                "            (120, 45),\n"
                "            (60, 60),\n"
                "            (120, 60),\n"
                "        )\n",
                "        left_profile = (0, 45, 45, 105, 95, 170)\n"
                "        left_profile_points = (\n"
                "            (40, 45),\n"
                "            (60, 45),\n"
                "            (120, 45),\n"
                "            (60, 60),\n"
                "            (40, 80),\n"
                "        )\n",
            ),
            (
                "        bottom_light = (220, 255, 220, 255, 220, 255)\n",
                "        bottom_light = (200, 255, 200, 255, 200, 255)\n",
            ),
            (
                "        return left_profile_hits >= 3 and top_hits >= 5 and bottom_hits >= 6\n",
                f"        # {main_page_match_marker}\n"
                "        return left_profile_hits >= 3 and bottom_hits >= 6\n",
            ),
        ]
        for needle, replacement in replacements:
            next_text = next_text.replace(needle, replacement, 1)
    if uses_crlf:
        next_text = next_text.replace("\n", "\r\n")
    try:
        if next_text != text:
            path.write_text(next_text, encoding="utf-8")
    except Exception:
        return


def _patch_android_virtual_display_loading_detection(root):
    marker = "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1"
    path = root / "core" / "color.py"
    _ensure_python_import(path, "os")
    _replace_once(
        path,
        marker,
        "    while (self.flag_run and\n"
        "           match_rgb_feature(self, \"loadingNotWhite\") and match_rgb_feature(self, \"loadingWhite\")):\n",
        "    # BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PATCH_V1\n"
        "    while (self.flag_run and\n"
        "           ((match_rgb_feature(self, \"loadingNotWhite\") and match_rgb_feature(self, \"loadingWhite\"))\n"
        "            or _baas_android_virtual_display_loading(self))):\n",
    )
    _append_once(
        path,
        marker + "_HELPER",
        f"\n# {marker}_HELPER\n"
        "def _baas_android_virtual_display_loading(self):\n"
        "    if os.getenv('BAAS_ANDROID', '').strip().lower() not in {'1', 'true', 'yes', 'on'}:\n"
        "        return False\n"
        "    display_id_candidates = [\n"
        "        os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "        os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"        '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "    ]\n"
        "    if not any(path and os.path.exists(path) for path in display_id_candidates):\n"
        "        return False\n"
        "    return match_rgb_feature(self, 'loadingNotWhite')\n",
    )
    _replace_text_fragments(
        path,
        [
            (
                "    return match_rgb_feature(self, 'loadingNotWhite')\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self))\n",
            ),
            (
                "    return match_rgb_feature(self, 'loadingNotWhite') and not _baas_android_virtual_display_news_modal(self)\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self))\n",
            ),
            (
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self))\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self)\n"
                "            and not _baas_android_virtual_display_result_modal(self))\n",
            ),
            (
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self)\n"
                "            and not _baas_android_virtual_display_result_modal(self))\n",
                "    return (match_rgb_feature(self, 'loadingNotWhite')\n"
                "            and not _baas_android_virtual_display_news_modal(self)\n"
                "            and not _baas_android_virtual_display_normal_ui(self)\n"
                "            and not _baas_android_virtual_display_result_modal(self)\n"
                "            and not _baas_android_virtual_display_purchase_modal(self))\n",
            ),
        ],
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NEWS_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NEWS_GUARD_V1\n"
        "def _baas_android_virtual_display_news_modal(self):\n"
        "    img = getattr(self, 'latest_img_array', None)\n"
        "    if img is None or getattr(img, 'ndim', 0) < 3:\n"
        "        return False\n"
        "    height, width = img.shape[:2]\n"
        "    if width != 1280 or height != 720:\n"
        "        return False\n"
        "    white = (230, 255, 230, 255, 230, 255)\n"
        "    blue = (20, 90, 120, 190, 220, 255)\n"
        "    modal_gray = (80, 140, 95, 145, 110, 165)\n"
        "    close_white_points = ((1132, 94), (1142, 104), (1152, 114))\n"
        "    close_blue_points = ((1100, 100), (1120, 104), (1160, 104), (1140, 80), (1140, 130))\n"
        "    header_points = ((130, 170), (450, 170), (900, 170))\n"
        "    white_hits = sum(1 for x, y in close_white_points if _pixel_in_range_xy(self, x, y, white))\n"
        "    blue_hits = sum(1 for x, y in close_blue_points if _pixel_in_range_xy(self, x, y, blue))\n"
        "    header_hits = sum(1 for x, y in header_points if _pixel_in_range_xy(self, x, y, modal_gray))\n"
        "    return white_hits >= 2 and blue_hits >= 4 and header_hits >= 2\n"
        "\n"
        "\n"
        "def _pixel_in_range_xy(self, x, y, rgb_range):\n"
        "    pixel = _get_rgb_at_index(self, int(y), int(x))\n"
        "    if pixel is None:\n"
        "        return False\n"
        "    return _pixel_in_rgb_range(pixel, *rgb_range)\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V1\n"
        "def _baas_android_virtual_display_normal_ui(self):\n"
        "    white = (220, 255, 220, 255, 220, 255)\n"
        "    yellow = (180, 255, 150, 235, 0, 90)\n"
        "    dark = (0, 95, 0, 95, 0, 120)\n"
        "    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n"
        "    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n"
        "            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2))\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_RESULT_MODAL_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_RESULT_MODAL_GUARD_V1\n"
        "def _baas_android_virtual_display_result_modal(self):\n"
        "    try:\n"
        "        if match_rgb_feature(self, 'reward_acquired'):\n"
        "            return True\n"
        "    except Exception:\n"
        "        pass\n"
        "    yellow = (220, 255, 180, 255, 40, 130)\n"
        "    dark = (0, 95, 0, 95, 0, 120)\n"
        "    title_hits = sum(1 for x, y in ((535, 150), (640, 150), (745, 150), (590, 185), (690, 185)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    continue_hits = sum(1 for x, y in ((585, 635), (640, 635), (695, 635)) if _pixel_in_range_xy(self, x, y, (230, 255, 230, 255, 230, 255)))\n"
        "    edge_hits = sum(1 for x, y in ((95, 90), (1185, 90), (95, 680), (1185, 680)) if _pixel_in_range_xy(self, x, y, dark))\n"
        "    return title_hits >= 3 and (continue_hits >= 2 or edge_hits >= 2)\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V2",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V2\n"
        "def _baas_android_virtual_display_normal_ui(self):\n"
        "    white = (220, 255, 220, 255, 220, 255)\n"
        "    yellow = (180, 255, 150, 235, 0, 90)\n"
        "    dark = (0, 95, 0, 95, 0, 120)\n"
        "    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n"
        "    report_panel = (190, 255, 220, 255, 230, 255)\n"
        "    report_button = (80, 155, 190, 245, 230, 255)\n"
        "    report_frame = (25, 75, 55, 105, 85, 140)\n"
        "    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n"
        "    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n"
        "    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n"
        "    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n"
        "            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n"
        "            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2))\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V3",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V3\n"
        "def _baas_android_virtual_display_normal_ui(self):\n"
        "    white = (220, 255, 220, 255, 220, 255)\n"
        "    yellow = (180, 255, 150, 235, 0, 90)\n"
        "    dark = (0, 95, 0, 95, 0, 120)\n"
        "    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n"
        "    report_panel = (190, 255, 220, 255, 230, 255)\n"
        "    report_button = (80, 155, 190, 245, 230, 255)\n"
        "    report_frame = (25, 75, 55, 105, 85, 140)\n"
        "    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n"
        "    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n"
        "    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n"
        "    social_card_hits = sum(1 for x, y in ((300, 330), (640, 330), (970, 330), (300, 375), (640, 375), (970, 375)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    social_blue = (0, 95, 80, 180, 135, 255)\n"
        "    social_blue_hits = sum(1 for x, y in ((580, 205), (640, 205), (500, 300), (840, 300)) if _pixel_in_range_xy(self, x, y, social_blue))\n"
        "    social_title_hits = sum(1 for x, y in ((670, 205), (700, 205), (730, 205)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n"
        "            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n"
        "            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2)\n"
        "            or (social_card_hits >= 4 and social_blue_hits >= 2 and (social_title_hits >= 1 or overlay_hits >= 2)))\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V4",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_NORMAL_UI_GUARD_V4\n"
        "def _baas_android_virtual_display_normal_ui(self):\n"
        "    white = (220, 255, 220, 255, 220, 255)\n"
        "    yellow = (180, 255, 150, 235, 0, 90)\n"
        "    dark = (0, 95, 0, 95, 0, 120)\n"
        "    top_hits = sum(1 for x, y in ((520, 40), (640, 40), (760, 40), (1030, 40)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    modal_hits = sum(1 for x, y in ((520, 90), (640, 90), (760, 90), (1000, 90)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    result_hits = sum(1 for x, y in ((520, 190), (640, 190), (760, 190), (900, 190)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    large_modal_hits = sum(1 for x, y in ((80, 90), (640, 90), (1200, 90), (80, 610), (640, 610), (1200, 610)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    yellow_action_hits = sum(1 for x, y in ((940, 590), (1060, 590), (1190, 590)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    overlay_hits = sum(1 for x, y in ((15, 55), (1265, 55), (15, 690), (1265, 690)) if _pixel_in_range_xy(self, x, y, dark))\n"
        "    report_panel = (190, 255, 220, 255, 230, 255)\n"
        "    report_button = (80, 155, 190, 245, 230, 255)\n"
        "    report_frame = (25, 75, 55, 105, 85, 140)\n"
        "    report_panel_hits = sum(1 for x, y in ((420, 115), (640, 115), (860, 115), (420, 625), (640, 625), (860, 625)) if _pixel_in_range_xy(self, x, y, report_panel))\n"
        "    report_button_hits = sum(1 for x, y in ((560, 555), (640, 555), (720, 555), (640, 525), (640, 590)) if _pixel_in_range_xy(self, x, y, report_button))\n"
        "    report_frame_hits = sum(1 for x, y in ((400, 100), (888, 640), (400, 640), (888, 100), (640, 400)) if _pixel_in_range_xy(self, x, y, report_frame))\n"
        "    social_card_hits = sum(1 for x, y in ((300, 330), (640, 330), (970, 330), (300, 375), (640, 375), (970, 375)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    social_blue = (0, 95, 80, 180, 135, 255)\n"
        "    social_blue_hits = sum(1 for x, y in ((580, 205), (640, 205), (500, 300), (840, 300)) if _pixel_in_range_xy(self, x, y, social_blue))\n"
        "    social_title_hits = sum(1 for x, y in ((670, 205), (700, 205), (730, 205)) if _pixel_in_range_xy(self, x, y, white))\n"
        "    help_panel = (190, 255, 215, 255, 225, 255)\n"
        "    help_close = (0, 75, 20, 100, 45, 125)\n"
        "    help_panel_hits = sum(1 for x, y in ((260, 130), (640, 130), (1010, 130), (260, 600), (640, 600), (1010, 600)) if _pixel_in_range_xy(self, x, y, help_panel))\n"
        "    help_close_hits = sum(1 for x, y in ((1008, 122), (1018, 132), (1028, 142)) if _pixel_in_range_xy(self, x, y, help_close))\n"
        "    return (top_hits >= 2 or modal_hits >= 3 or result_hits >= 3\n"
        "            or (large_modal_hits >= 4 and yellow_action_hits >= 2 and overlay_hits >= 2)\n"
        "            or (report_panel_hits >= 4 and report_button_hits >= 3 and report_frame_hits >= 2)\n"
        "            or (social_card_hits >= 4 and social_blue_hits >= 2 and (social_title_hits >= 1 or overlay_hits >= 2))\n"
        "            or (help_panel_hits >= 5 and help_close_hits >= 2))\n",
    )
    _append_once(
        path,
        "BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PURCHASE_MODAL_GUARD_V1",
        "\n# BAAS_ANDROID_VIRTUAL_DISPLAY_LOADING_PURCHASE_MODAL_GUARD_V1\n"
        "def _baas_android_virtual_display_purchase_modal(self):\n"
        "    panel = (180, 255, 190, 255, 200, 255)\n"
        "    yellow = (220, 255, 200, 245, 40, 130)\n"
        "    close_dark = (20, 90, 40, 110, 60, 140)\n"
        "    overlay_dark = (0, 80, 0, 90, 0, 110)\n"
        "    panel_hits = sum(1 for x, y in ((350, 150), (640, 150), (930, 150), (350, 550), (640, 550), (950, 550)) if _pixel_in_range_xy(self, x, y, panel))\n"
        "    confirm_hits = sum(1 for x, y in ((700, 505), (760, 505), (820, 505), (740, 480), (780, 530)) if _pixel_in_range_xy(self, x, y, yellow))\n"
        "    close_hits = sum(1 for x, y in ((910, 155), (920, 165), (930, 175)) if _pixel_in_range_xy(self, x, y, close_dark))\n"
        "    overlay_hits = sum(1 for x, y in ((60, 60), (1220, 60), (60, 660), (1220, 660)) if _pixel_in_range_xy(self, x, y, overlay_dark))\n"
        "    return panel_hits >= 4 and confirm_hits >= 3 and close_hits >= 2 and overlay_hits >= 2\n",
    )


def _replace_once(path, marker, needle, replacement):
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    uses_crlf = "\r\n" in text
    text = text.replace("\r\n", "\n")
    if marker in text or needle not in text:
        return
    try:
        next_text = text.replace(needle, replacement, 1)
        if uses_crlf:
            next_text = next_text.replace("\n", "\r\n")
        path.write_text(next_text, encoding="utf-8")
    except Exception:
        return


def _replace_text_fragments(path, replacements):
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    next_text = text
    for needle, replacement in replacements:
        next_text = next_text.replace(needle, replacement)
    if next_text == text:
        return
    try:
        path.write_text(next_text, encoding="utf-8")
    except Exception:
        return


def _append_once(path, marker, addition):
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    if marker in text:
        return
    try:
        path.write_text(text.rstrip() + "\n" + addition.lstrip("\n"), encoding="utf-8")
    except Exception:
        return


def _replace_old_scrcpy_runtime_block(path, marker):
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    uses_crlf = "\r\n" in text
    text = text.replace("\r\n", "\n")
    if marker in text:
        return
    old_v2 = (
        "        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH_V2\n"
        "        if os.getenv('BAAS_ANDROID', '').lower() in {'1', 'true', 'yes', 'on'}:\n"
        "            display_id_candidates = [\n"
        "                os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "                os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"                '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "            ]\n"
        "            if any(path and os.path.exists(path) for path in display_id_candidates):\n"
    )
    new = (
        f"        # {marker}\n"
        "        display_id_candidates = [\n"
        "            os.getenv('BAAS_SCRCPY_DISPLAY_ID_FILE', '').strip(),\n"
        "            os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt'),\n"
        f"            '/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt',\n"
        "        ]\n"
        "        if any(path and os.path.exists(path) for path in display_id_candidates):\n"
    )
    if old_v2 in text:
        try:
            next_text = text.replace(old_v2, new, 1)
            if uses_crlf:
                next_text = next_text.replace("\n", "\r\n")
            path.write_text(next_text, encoding="utf-8")
        except Exception:
            pass
        return
    old = (
        "        # BAAS_ANDROID_SCRCPY_RUNTIME_SELECTION_PATCH\n"
        "        if os.getenv('BAAS_ANDROID', '').lower() in {'1', 'true', 'yes', 'on'}:\n"
        "            display_id_file = os.path.join(os.getcwd(), 'config', 'scrcpy_display_id.txt')\n"
        "            if os.path.exists(display_id_file):\n"
    )
    if old not in text:
        return
    try:
        next_text = text.replace(old, new, 1)
        if uses_crlf:
            next_text = next_text.replace("\n", "\r\n")
        path.write_text(next_text, encoding="utf-8")
    except Exception:
        return


def _ensure_python_import(path, module_name):
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    uses_crlf = "\r\n" in text
    text = text.replace("\r\n", "\n")
    import_line = f"import {module_name}"
    if any(line.strip() == import_line for line in text.splitlines()):
        return
    needle = "import sys\n"
    if needle in text:
        next_text = text.replace(needle, f"{needle}{import_line}\n", 1)
    else:
        insert_at = None
        cursor = 0
        for line in text.splitlines(keepends=True):
            stripped = line.strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                insert_at = cursor + len(line)
            cursor += len(line)
        if insert_at is None:
            insert_at = 0
        next_text = text[:insert_at] + f"{import_line}\n" + text[insert_at:]
    try:
        if uses_crlf:
            next_text = next_text.replace("\n", "\r\n")
        path.write_text(next_text, encoding="utf-8")
    except Exception:
        return


# Starts atx-agent outside the backend HTTP startup critical path when explicitly enabled.
def _start_local_atx_agent_async_if_enabled(root):
    if os.getenv("BAAS_ANDROID_ENABLE_UIAUTOMATOR_FALLBACK", "").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return
    _start_local_atx_agent_async(root)


# Starts atx-agent outside the backend HTTP startup critical path.
def _start_local_atx_agent_async(root):
    global _ATX_START_THREAD

    with _ATX_START_LOCK:
        if _ATX_START_THREAD is not None and _ATX_START_THREAD.is_alive():
            return
        _ATX_START_THREAD = threading.Thread(
            target=_ensure_local_atx_agent,
            args=(root,),
            name="baas-android-atx-agent",
            daemon=True,
        )
        _ATX_START_THREAD.start()


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


# Handles the write Android direct ADB server shim workflow.
def _write_android_direct_adb_server(root):
    (root / "android_direct_adb_server.py").write_text(
        r'''import base64
import os
from pathlib import Path
import re
import select
import socket
import socketserver
import struct
import threading

from java import jarray, jbyte, jclass


_SERVER = None
_THREAD = None
_SERIAL = "127.0.0.1:5555"


def start(serial="127.0.0.1:5555", port=0):
    global _SERVER, _THREAD, _SERIAL
    _SERIAL = (serial or "127.0.0.1:5555").strip()
    if _SERVER is not None:
        return _SERVER.server_address[1]
    server = _SmartAdbServer(("127.0.0.1", int(port or 0)), _SmartAdbHandler)
    _SERVER = server
    _THREAD = threading.Thread(target=server.serve_forever, name="baas-android-direct-adb", daemon=True)
    _THREAD.start()
    return server.server_address[1]


class _SmartAdbServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _SmartAdbHandler(socketserver.BaseRequestHandler):
    def handle(self):
        transport = False
        while True:
            command = _read_smart_command(self.request)
            if command is None:
                return
            if transport:
                self._handle_transport_command(command)
                return
            action, payload = self._handle_host_command(command)
            if action == "transport":
                transport = True
            elif action == "delegate":
                _send_okay(self.request)
                _bridge_service(payload, self.request)
                return
            elif action == "close":
                return

    def _handle_host_command(self, command):
        serial = _SERIAL
        if command == "host:version":
            _send_okay(self.request)
            _send_string(self.request, "0028")
            return "done", None
        if command in {"host:devices", "host:devices-l"}:
            _send_okay(self.request)
            _send_string(self.request, f"{serial}\tdevice\n")
            return "done", None
        if command == "host:list-forward" or command.endswith(":list-forward"):
            _send_okay(self.request)
            _send_string(self.request, "")
            return "done", None
        if command.startswith("host:connect:"):
            _send_okay(self.request)
            _send_string(self.request, f"already connected to {command[len('host:connect:'):]}")
            return "done", None
        if command.startswith("host:disconnect:"):
            _send_okay(self.request)
            _send_string(self.request, f"disconnected {command[len('host:disconnect:'):]}")
            return "done", None
        if command == "host:kill":
            _send_okay(self.request)
            return "close", None
        if command.startswith("host:transport:") or command.startswith("host:transport-id:"):
            _send_okay(self.request)
            return "transport", None
        if command.startswith("host-serial:"):
            prefix = f"host-serial:{serial}:"
            if command.startswith(prefix):
                subcommand = command[len(prefix):]
            else:
                parts = command.split(":", 2)
                subcommand = parts[2] if len(parts) >= 3 else ""
            return self._handle_serial_command(subcommand)
        if command.startswith("host:wait-for-"):
            _send_okay(self.request)
            _send_okay(self.request)
            return "done", None
        _send_fail(self.request, f"unsupported direct-adb host command: {command}")
        return "close", None

    def _handle_serial_command(self, command):
        if command == "get-state":
            _send_okay(self.request)
            _send_string(self.request, "device")
            return "done", None
        if command == "get-serialno":
            _send_okay(self.request)
            _send_string(self.request, _SERIAL)
            return "done", None
        if command == "features":
            _send_okay(self.request)
            _send_string(self.request, "shell_v2,cmd,stat_v2")
            return "done", None
        if command == "list-forward":
            _send_okay(self.request)
            _send_string(self.request, "")
            return "done", None
        if command.startswith("forward:"):
            _send_okay(self.request)
            return "done", None
        if command.startswith("wait-for-"):
            _send_okay(self.request)
            _send_okay(self.request)
            return "done", None
        return "delegate", command

    def _handle_transport_command(self, command):
        action, payload = self._handle_serial_command(command)
        if action == "delegate":
            _send_okay(self.request)
            _bridge_service(payload, self.request)


def _read_smart_command(sock):
    header = _read_exact(sock, 4)
    if not header:
        return None
    try:
        length = int(header.decode("ascii"), 16)
    except ValueError:
        return None
    data = _read_exact(sock, length)
    if data is None:
        return None
    return data.decode("utf-8", errors="replace")


def _send_okay(sock):
    sock.sendall(b"OKAY")


def _send_fail(sock, message):
    payload = str(message).encode("utf-8", errors="replace")
    sock.sendall(b"FAIL" + f"{len(payload):04x}".encode("ascii") + payload)


def _send_string(sock, text):
    payload = str(text).encode("utf-8", errors="replace")
    sock.sendall(f"{len(payload):04x}".encode("ascii") + payload)


def _read_exact(sock, size):
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def _bridge_service(service, client_sock):
    adbd = _AdbdStream(_SERIAL)
    try:
        adbd.open(service)
    except Exception as exc:
        _send_fail(client_sock, str(exc))
        return
    stop = threading.Event()

    def adbd_to_client():
        try:
            while not stop.is_set():
                packet = adbd.read_packet()
                if packet is None:
                    break
                command, arg0, _arg1, payload = packet
                if command == b"WRTE":
                    adbd.write_packet(b"OKAY", adbd.local_id, arg0, b"")
                    if payload:
                        client_sock.sendall(payload)
                elif command == b"OKAY":
                    continue
                elif command == b"CLSE":
                    break
                elif command == b"FAIL":
                    if payload:
                        client_sock.sendall(payload)
                    break
        except Exception:
            pass
        finally:
            stop.set()
            try:
                client_sock.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    reader = threading.Thread(target=adbd_to_client, daemon=True)
    reader.start()
    try:
        while not stop.is_set():
            readable, _, _ = select.select([client_sock], [], [], 0.2)
            if not readable:
                continue
            data = client_sock.recv(65536)
            if not data:
                break
            adbd.write_packet(b"WRTE", adbd.local_id, adbd.remote_id, data)
    except Exception:
        pass
    finally:
        stop.set()
        try:
            adbd.write_packet(b"CLSE", adbd.local_id, adbd.remote_id, b"")
        except Exception:
            pass
        adbd.close()
        try:
            client_sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            client_sock.close()
        except Exception:
            pass
        reader.join(timeout=1)


class _AdbdStream:
    def __init__(self, serial):
        host, port = _parse_serial(serial)
        self.sock = socket.create_connection((host, port), timeout=3)
        self.sock.settimeout(90)
        self.local_id = 1
        self.remote_id = 0
        self._lock = threading.Lock()
        self.write_packet(b"CNXN", 0x01000000, 256 * 1024, b"host::\0")
        auth_attempted = False
        while True:
            packet = self.read_packet()
            if packet is None:
                raise RuntimeError("adbd closed during CNXN")
            command, arg0, _arg1, payload = packet
            if command == b"CNXN":
                self.sock.settimeout(15)
                return
            if command == b"AUTH":
                if arg0 == 1 and not auth_attempted:
                    self.write_packet(b"AUTH", 2, 0, _sign_adb_auth_token(payload))
                    auth_attempted = True
                    continue
                if arg0 == 1:
                    self.write_packet(b"AUTH", 3, 0, _adb_public_key_payload())
                    continue
                raise RuntimeError(f"unsupported adbd AUTH type: {arg0}")
            raise RuntimeError(f"unexpected adbd packet during CNXN: {command!r} {payload!r}")

    def open(self, service):
        payload = service.encode("utf-8") + b"\0"
        self.write_packet(b"OPEN", self.local_id, 0, payload)
        while True:
            packet = self.read_packet()
            if packet is None:
                raise RuntimeError(f"adbd closed while opening {service}")
            command, arg0, _arg1, payload = packet
            if command == b"OKAY":
                self.remote_id = arg0
                return
            if command == b"FAIL":
                raise RuntimeError(payload.decode("utf-8", errors="replace"))
            if command == b"CLSE":
                raise RuntimeError(f"adbd closed service {service}")

    def read_packet(self):
        header = _read_exact(self.sock, 24)
        if not header:
            return None
        command_u32, arg0, arg1, payload_len, checksum, magic = struct.unpack("<6I", header)
        if magic != (command_u32 ^ 0xFFFFFFFF):
            raise RuntimeError("invalid adbd packet magic")
        payload = _read_exact(self.sock, payload_len) if payload_len else b""
        if payload is None:
            raise RuntimeError("adbd closed during packet payload")
        if (sum(payload) & 0xFFFFFFFF) != checksum:
            raise RuntimeError("invalid adbd packet checksum")
        return struct.pack("<I", command_u32), arg0, arg1, payload

    def write_packet(self, command, arg0, arg1, payload):
        payload = payload or b""
        command_u32 = struct.unpack("<I", command)[0]
        header = struct.pack(
            "<6I",
            command_u32,
            int(arg0),
            int(arg1),
            len(payload),
            sum(payload) & 0xFFFFFFFF,
            command_u32 ^ 0xFFFFFFFF,
        )
        with self._lock:
            self.sock.sendall(header)
            if payload:
                self.sock.sendall(payload)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def _parse_serial(serial):
    host, sep, port = (serial or "127.0.0.1:5555").rpartition(":")
    if not sep:
        return serial, 5555
    return host or "127.0.0.1", int(port)


_ADB_PRIVATE_KEY = None
_ADB_PRIVATE_KEY_PATH = None
_ADB_RSA_BITS = 2048
_ADB_RSA_BYTES = _ADB_RSA_BITS // 8
_ADB_RSA_WORDS = _ADB_RSA_BYTES // 4
_SHA1_DIGEST_INFO_PREFIX = bytes.fromhex("3021300906052b0e03021a05000414")


def _sign_adb_auth_token(token):
    key = _load_or_create_adb_private_key()
    signature = jclass("java.security.Signature").getInstance("NONEwithRSA")
    signature.initSign(key)
    signature.update(_java_bytes(_SHA1_DIGEST_INFO_PREFIX + bytes(token)))
    return bytes((int(value) & 0xFF) for value in signature.sign())


def _adb_public_key_payload():
    key = _load_or_create_adb_private_key()
    modulus = _java_big_integer_to_int(key.getModulus())
    exponent = _java_big_integer_to_int(key.getPublicExponent())
    modulus_le = modulus.to_bytes(_ADB_RSA_BYTES, "little")
    n0 = int.from_bytes(modulus_le[:4], "little")
    n0inv = (-pow(n0, -1, 1 << 32)) & 0xFFFFFFFF
    r = 1 << _ADB_RSA_BITS
    rr = ((r * r) % modulus).to_bytes(_ADB_RSA_BYTES, "little")
    blob = (
        _ADB_RSA_WORDS.to_bytes(4, "little")
        + n0inv.to_bytes(4, "little")
        + modulus_le
        + rr
        + int(exponent).to_bytes(4, "little")
    )
    return base64.b64encode(blob) + b" baas-tauri@android\0"


def _load_or_create_adb_private_key():
    global _ADB_PRIVATE_KEY, _ADB_PRIVATE_KEY_PATH
    if _ADB_PRIVATE_KEY is not None:
        return _ADB_PRIVATE_KEY
    key_path = _adb_private_key_path()
    if key_path.exists():
        _ADB_PRIVATE_KEY = _load_adb_private_key(key_path)
        _ADB_PRIVATE_KEY_PATH = key_path
        return _ADB_PRIVATE_KEY
    key_path.parent.mkdir(parents=True, exist_ok=True)
    generator = jclass("java.security.KeyPairGenerator").getInstance("RSA")
    generator.initialize(_ADB_RSA_BITS)
    pair = generator.generateKeyPair()
    private_key = pair.getPrivate()
    encoded = bytes((int(value) & 0xFF) for value in private_key.getEncoded())
    body = base64.encodebytes(encoded).decode("ascii").replace("\n", "")
    lines = [body[index:index + 64] for index in range(0, len(body), 64)]
    key_path.write_text(
        "-----BEGIN PRIVATE KEY-----\n"
        + "\n".join(lines)
        + "\n-----END PRIVATE KEY-----\n",
        encoding="ascii",
    )
    _ADB_PRIVATE_KEY = private_key
    _ADB_PRIVATE_KEY_PATH = key_path
    return private_key


def _load_adb_private_key(path):
    pem = path.read_text(encoding="ascii", errors="ignore")
    body = re.sub(r"-----BEGIN [^-]+-----|-----END [^-]+-----|\s+", "", pem)
    der = base64.b64decode(body)
    spec = jclass("java.security.spec.PKCS8EncodedKeySpec")(_java_bytes(der))
    return jclass("java.security.KeyFactory").getInstance("RSA").generatePrivate(spec)


def _adb_private_key_path():
    candidates = [
        os.environ.get("BAAS_ANDROID_ADB_KEY", "").strip(),
        os.path.join(os.getcwd(), "config", "adbkey"),
        "/storage/emulated/0/Android/data/io.github.kiramei.baas_tauri/config/adbkey",
    ]
    for candidate in candidates:
        if candidate:
            return Path(candidate)
    return Path("config") / "adbkey"


def _java_bytes(data):
    return jarray(jbyte)([(byte if byte < 128 else byte - 256) for byte in bytes(data)])


def _java_big_integer_to_int(value):
    return int(str(value))
''',
        encoding="utf-8",
    )


# Handles the write Android MediaCodec H.264 decoder workflow.
def _write_android_media_codec_decoder(root):
    (root / "android_media_codec_decoder.py").write_text(
        r'''import time

import numpy as np
from java import jarray, jbyte, jclass


ByteBuffer = jclass("java.nio.ByteBuffer")
ImageFormat = jclass("android.graphics.ImageFormat")
ImageReader = jclass("android.media.ImageReader")
MediaCodec = jclass("android.media.MediaCodec")
MediaFormat = jclass("android.media.MediaFormat")
BufferInfo = jclass("android.media.MediaCodec$BufferInfo")

_DECODER_NAMES = (
    "OMX.google.h264.decoder",
    "c2.android.avc.decoder",
    "c2.google.avc.decoder",
    "c2.goldfish.h264.decoder",
)


class AndroidH264Decoder:
    def __init__(self, width, height, flip=False):
        self.width = int(width or 1280)
        self.height = int(height or 720)
        self.flip = bool(flip)
        self.codec = None
        self.reader = None
        self.info = BufferInfo()
        self.pending = bytearray()
        self.pts_us = 0
        self.output_format = None
        self.sps = None
        self.pps = None

    def _start(self):
        fmt = MediaFormat.createVideoFormat("video/avc", self.width, self.height)
        if self.sps:
            fmt.setByteBuffer("csd-0", ByteBuffer.wrap(jarray(jbyte)(self.sps)))
        if self.pps:
            fmt.setByteBuffer("csd-1", ByteBuffer.wrap(jarray(jbyte)(self.pps)))
        errors = []
        for name in _DECODER_NAMES:
            try:
                self._release_reader()
                self.reader = ImageReader.newInstance(self.width, self.height, ImageFormat.YUV_420_888, 3)
                self.codec = MediaCodec.createByCodecName(name)
                self.codec.configure(fmt, self.reader.getSurface(), None, 0)
                self.codec.start()
                print(f"Android H264 decoder selected: {name}", flush=True)
                break
            except Exception as exc:
                errors.append(f"{name}: {exc}")
                self._release_codec()
                self._release_reader()
        if self.codec is None:
            try:
                self._release_reader()
                self.reader = ImageReader.newInstance(self.width, self.height, ImageFormat.YUV_420_888, 3)
                self.codec = MediaCodec.createDecoderByType("video/avc")
                self.codec.configure(fmt, self.reader.getSurface(), None, 0)
                self.codec.start()
                print("Android H264 decoder selected by type: video/avc", flush=True)
            except Exception as exc:
                self._release_codec()
                self._release_reader()
                errors.append(f"video/avc: {exc}")
                raise RuntimeError("Unable to start Android H264 decoder: " + " | ".join(errors))

    def close(self):
        self._release_codec()
        self._release_reader()

    def _release_codec(self):
        codec = self.codec
        self.codec = None
        if codec is None:
            return
        try:
            codec.stop()
        except Exception:
            pass
        try:
            codec.release()
        except Exception:
            pass

    def _release_reader(self):
        reader = self.reader
        self.reader = None
        if reader is None:
            return
        try:
            reader.close()
        except Exception:
            pass

    def decode(self, data):
        latest = None
        for unit in self._annexb_units(data):
            self._remember_codec_config(unit)
            if self.codec is None:
                if not (self.sps and self.pps):
                    continue
                self._start()
            self._queue_input(unit)
            frame = self._drain_output()
            if frame is not None:
                latest = frame
        if self.codec is not None:
            frame = self._drain_output()
            if frame is not None:
                latest = frame
        return latest

    def _remember_codec_config(self, unit):
        nal_type = _nal_type(unit)
        if nal_type == 7:
            self.sps = unit
        elif nal_type == 8:
            self.pps = unit

    def _annexb_units(self, data):
        if data:
            self.pending.extend(data)
        starts = _find_start_codes(self.pending)
        if len(starts) < 2:
            return []
        units = []
        for index in range(len(starts) - 1):
            start = starts[index]
            end = starts[index + 1]
            if end > start:
                units.append(bytes(self.pending[start:end]))
        del self.pending[:starts[-1]]
        return units

    def _queue_input(self, unit):
        if not unit:
            return
        index = self.codec.dequeueInputBuffer(10000)
        if index < 0:
            return
        buffer = self.codec.getInputBuffer(index)
        buffer.clear()
        payload = jarray(jbyte)(unit)
        buffer.put(payload)
        self.pts_us += 16666
        self.codec.queueInputBuffer(index, 0, len(unit), self.pts_us, 0)

    def _drain_output(self):
        latest = None
        while True:
            index = self.codec.dequeueOutputBuffer(self.info, 0)
            if index == MediaCodec.INFO_TRY_AGAIN_LATER:
                break
            if index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED:
                self.output_format = self.codec.getOutputFormat()
                continue
            if index < 0:
                break
            image = None
            try:
                self.codec.releaseOutputBuffer(index, True)
                image = self.reader.acquireLatestImage() if self.reader is not None else None
                if image is not None:
                    latest = _image_to_bgr(image, self.flip)
            finally:
                try:
                    if image is not None:
                        image.close()
                except Exception:
                    pass
        return latest


def _find_start_codes(data):
    starts = []
    index = 0
    size = len(data)
    while index + 3 <= size:
        if data[index:index + 3] == b"\x00\x00\x01":
            starts.append(index)
            index += 3
            continue
        if index + 4 <= size and data[index:index + 4] == b"\x00\x00\x00\x01":
            starts.append(index)
            index += 4
            continue
        index += 1
    return starts


def _nal_type(unit):
    offset = 0
    if unit.startswith(b"\x00\x00\x00\x01"):
        offset = 4
    elif unit.startswith(b"\x00\x00\x01"):
        offset = 3
    if offset >= len(unit):
        return -1
    return unit[offset] & 0x1F


def _image_to_bgr(image, flip):
    width = int(image.getWidth())
    height = int(image.getHeight())
    planes = image.getPlanes()
    y = _plane_to_array(planes[0], width, height)
    u = _plane_to_array(planes[1], (width + 1) // 2, (height + 1) // 2)
    v = _plane_to_array(planes[2], (width + 1) // 2, (height + 1) // 2)

    u_full = u.repeat(2, axis=0).repeat(2, axis=1)[:height, :width].astype(np.int16) - 128
    v_full = v.repeat(2, axis=0).repeat(2, axis=1)[:height, :width].astype(np.int16) - 128
    y_full = y.astype(np.int16)

    b = y_full + ((454 * u_full) >> 8)
    g = y_full - ((88 * u_full + 183 * v_full) >> 8)
    r = y_full + ((359 * v_full) >> 8)
    frame = np.dstack((b, g, r)).clip(0, 255).astype(np.uint8)
    if flip:
        frame = frame[:, ::-1, :].copy()
    return frame


def _plane_to_array(plane, width, height):
    buffer = plane.getBuffer()
    size = int(buffer.remaining())
    raw_java = jarray(jbyte)(size)
    buffer.get(raw_java)
    raw = np.frombuffer(bytes(raw_java), dtype=np.uint8)
    row_stride = int(plane.getRowStride())
    pixel_stride = int(plane.getPixelStride())
    out = np.empty((height, width), dtype=np.uint8)
    for row in range(height):
        start = row * row_stride
        stop = start + width * pixel_stride
        out[row, :] = raw[start:stop:pixel_stride][:width]
    return out
''',
        encoding="utf-8",
    )


# Returns whether Android virtual-display scrcpy mode is active.
def _android_scrcpy_virtual_display_enabled(root):
    candidates = [
        os.environ.get("BAAS_SCRCPY_DISPLAY_ID_FILE", "").strip(),
        str(root / "config" / "scrcpy_display_id.txt"),
        f"/storage/emulated/0/Android/data/{PACKAGE_NAME}/config/scrcpy_display_id.txt",
    ]
    return any(path and Path(path).exists() for path in candidates)


# Starts the Android direct ADB smart-socket shim for virtual-display scrcpy mode.
def _start_android_direct_adb_server_if_needed(root):
    if not _android_scrcpy_virtual_display_enabled(root):
        return
    try:
        import android_direct_adb_server

        serial = os.environ.get("BAAS_ANDROID_ADB_SERIAL", "").strip() or "127.0.0.1:5555"
        port = android_direct_adb_server.start(serial)
        os.environ["ANDROID_ADB_SERVER_HOST"] = "127.0.0.1"
        os.environ["ANDROID_ADB_SERVER_PORT"] = str(port)
        os.environ["BAAS_ANDROID_DIRECT_ADB_SERVER_PORT"] = str(port)
        print(f"Android direct ADB server started on 127.0.0.1:{port} for {serial}", flush=True)
    except Exception as exc:
        print(f"Android direct ADB server failed to start: {exc}", flush=True)


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
        "import os\n"
        "import re\n"
        "import socket\n"
        "import time\n"
        "from urllib import parse, request\n\n"
        "from PIL import Image\n\n"
        "from .version import __apk_version__, __atx_agent_version__, __version__\n\n"
        "class UiAutomationNotConnectedError(RuntimeError):\n"
        "    pass\n\n"
        "def _adb_direct_server():\n"
        "    port = (os.getenv('BAAS_ANDROID_DIRECT_ADB_SERVER_PORT') or os.getenv('ANDROID_ADB_SERVER_PORT') or '').strip()\n"
        "    if not port:\n"
        "        return None\n"
        "    host = (os.getenv('ANDROID_ADB_SERVER_HOST') or '127.0.0.1').strip() or '127.0.0.1'\n"
        "    try:\n"
        "        return host, int(port)\n"
        "    except ValueError:\n"
        "        return None\n\n"
        "def _adb_read_exact(sock, size):\n"
        "    data = bytearray()\n"
        "    while len(data) < size:\n"
        "        chunk = sock.recv(size - len(data))\n"
        "        if not chunk:\n"
        "            return None\n"
        "        data.extend(chunk)\n"
        "    return bytes(data)\n\n"
        "def _adb_send_smart(sock, command):\n"
        "    payload = str(command).encode('utf-8')\n"
        "    sock.sendall(f'{len(payload):04x}'.encode('ascii') + payload)\n\n"
        "def _adb_expect_okay(sock):\n"
        "    status = _adb_read_exact(sock, 4)\n"
        "    if status == b'OKAY':\n"
        "        return\n"
        "    if status == b'FAIL':\n"
        "        length = _adb_read_exact(sock, 4)\n"
        "        size = int(length.decode('ascii'), 16) if length else 0\n"
        "        message = _adb_read_exact(sock, size) if size else b''\n"
        "        raise RuntimeError((message or b'ADB FAIL').decode('utf-8', errors='replace'))\n"
        "    raise RuntimeError(f'Unexpected ADB status: {status!r}')\n\n"
        "def _adb_direct_shell(command, timeout=60):\n"
        "    server = _adb_direct_server()\n"
        "    if not server:\n"
        "        return None\n"
        "    serial = (os.getenv('BAAS_ANDROID_ADB_SERIAL') or '127.0.0.1:5555').strip() or '127.0.0.1:5555'\n"
        "    with socket.create_connection(server, timeout=3) as sock:\n"
        "        sock.settimeout(timeout + 5)\n"
        "        _adb_send_smart(sock, f'host:transport:{serial}')\n"
        "        _adb_expect_okay(sock)\n"
        "        _adb_send_smart(sock, 'shell:' + command)\n"
        "        _adb_expect_okay(sock)\n"
        "        chunks = []\n"
        "        while True:\n"
        "            try:\n"
        "                chunk = sock.recv(65536)\n"
        "            except socket.timeout:\n"
        "                break\n"
        "            if not chunk:\n"
        "                break\n"
        "            chunks.append(chunk)\n"
        "        return b''.join(chunks).decode('utf-8', errors='replace'), 0\n\n"
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
        "        try:\n"
        "            direct_result = _adb_direct_shell(command, timeout=timeout)\n"
        "            if direct_result is not None:\n"
        "                return direct_result\n"
        "        except Exception:\n"
        "            pass\n"
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
    root_path = str(root)
    had_root_path = root_path in sys.path
    if not had_root_path:
        sys.path.insert(0, root_path)
    elif sys.path[0] != root_path:
        sys.path.remove(root_path)
        sys.path.insert(0, root_path)
    overlay_path = os.environ.get("BAAS_SERVICE_OVERLAY_ROOT", "").strip()
    had_overlay_path = overlay_path in sys.path
    if overlay_path:
        if had_overlay_path:
            sys.path.remove(overlay_path)
        sys.path.insert(0, overlay_path)
    _clear_backend_modules()
    try:
        _start_android_direct_adb_server_if_needed(root)
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
        if not had_root_path:
            try:
                sys.path.remove(root_path)
            except ValueError:
                pass
        if overlay_path and not had_overlay_path:
            try:
                sys.path.remove(overlay_path)
            except ValueError:
                pass
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


def _scope_header(scope, name):
    target = name.lower().encode("ascii")
    for key, value in scope.get("headers") or []:
        if key.lower() == target:
            return value
    return None


def _android_cors_headers(scope):
    origin = _scope_header(scope, "origin") or b"http://tauri.localhost"
    return [
        (b"access-control-allow-origin", origin),
        (b"access-control-allow-credentials", b"true"),
        (b"access-control-allow-methods", b"POST, OPTIONS"),
        (b"access-control-allow-headers", b"content-type"),
    ]


async def _send_json_response(send, payload, status=200, extra_headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = [
        (b"content-type", b"application/json; charset=utf-8"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    if extra_headers:
        headers.extend(extra_headers)
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


async def _read_asgi_json_body(receive):
    body = bytearray()
    while True:
        message = await receive()
        if message.get("type") == "http.disconnect":
            break
        if message.get("type") != "http.request":
            continue
        body.extend(message.get("body") or b"")
        if not message.get("more_body", False):
            break
    if not body:
        return {}
    return json.loads(bytes(body).decode("utf-8"))


async def _handle_android_reset_auth(scope, receive, send):
    cors_headers = _android_cors_headers(scope)
    method = scope.get("method", "GET").upper()
    if method == "OPTIONS":
        await _send_json_response(send, {"ok": True}, extra_headers=cors_headers)
        return
    if method != "POST":
        await _send_json_response(
            send,
            {"ok": False, "error": "method not allowed"},
            status=405,
            extra_headers=cors_headers,
        )
        return
    try:
        payload = await _read_asgi_json_body(receive)
        password = str(payload.get("password") or "").strip()
        if not password:
            await _send_json_response(
                send,
                {"ok": False, "error": "password is required"},
                status=400,
                extra_headers=cors_headers,
            )
            return
        from service.api.state import context

        state = await context.auth_manager.force_reset_password(
            password,
            reason="android_auto_password_reset",
        )
        await _send_json_response(
            send,
            {"ok": True, "pwd_epoch": state.pwd_epoch},
            extra_headers=cors_headers,
        )
    except Exception as exc:
        await _send_json_response(
            send,
            {"ok": False, "type": exc.__class__.__name__, "error": str(exc)},
            status=500,
            extra_headers=cors_headers,
        )


# Builds the ASGI app and reserves a bootstrap-owned restart endpoint.
def _build_baas_asgi_app(root, port):
    from service.app import app as service_app

    async def app(scope, receive, send):
        if scope.get("type") == "http" and scope.get("path") == "/android/reset-auth":
            await _handle_android_reset_auth(scope, receive, send)
            return
        if scope.get("type") == "http" and scope.get("path") == "/android/bootstrap-restart":
            await _send_json_response(send, {"ok": True, "restartScheduled": True})
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
