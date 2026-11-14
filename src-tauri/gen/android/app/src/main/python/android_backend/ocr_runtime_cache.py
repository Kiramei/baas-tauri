"""Repair only owned Android OCR payloads, retaining configuration and logs."""

import functools
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path


_MARKER = ".baas-ocr-prebuild-sha"
_LIBCXX = "libc++_baasxx.so"
_BRANCHES = {"android-arm64-v8a": ("arm64-v8a", 183), "android-x86_64": ("x86_64", 62)}
_LOCK = threading.RLock()
_LANGUAGES = ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr")


def _regular(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise RuntimeError("Missing or unsafe OCR payload: " + path.name)
    for parent in path.parents:
        if parent.is_symlink():
            raise RuntimeError("OCR payload directories must not be symbolic links")
    return path


def _elf(path, machine):
    with _regular(path).open("rb") as handle:
        header = handle.read(20)
    if (len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2
            or header[5] not in (1, 2)
            or int.from_bytes(header[18:20], "little" if header[5] == 1 else "big") != machine):
        raise RuntimeError("Invalid Android OCR library architecture: " + Path(path).name)


def cache_errors(directory, abi, machine, native_libcxx=None, require_marker=True):
    """Validate dependencies and referenced resources before trusting an install marker.

    Model inference remains the readiness gate's responsibility. This preflight
    makes missing/truncated files repairable instead of repeatedly reusing them.
    """
    root = Path(directory)
    try:
        if root.is_symlink():
            raise RuntimeError("OCR cache must not be a symbolic link")
        if require_marker:
            _regular(root / _MARKER)
        library = root / "lib" / abi
        for name in ("libBAAS_ocr_server.so", "libonnxruntime.so", "libopencv_java4.so"):
            _elf(library / name, machine)
        candidates = [library / _LIBCXX, library / "libc++_shared.so"]
        if native_libcxx is not None:
            candidates.append(Path(native_libcxx))
        libcxx = next((path for path in candidates if path.is_file()), None)
        if libcxx is None:
            raise RuntimeError("OCR C++ runtime is missing")
        _elf(libcxx, machine)
        catalog = {}
        for name in ("global_setting.json", "static.json"):
            value = json.loads(_regular(root / "resource" / name).read_text(encoding="utf-8"))
            if not isinstance(value, dict) or not value:
                raise RuntimeError("Invalid OCR resource catalog: " + name)
            if name == "static.json":
                catalog = value
        models = root / "resource" / "ocr_models"
        manifest = _regular(models / "configs.txt").read_text(encoding="utf-8")
        files = [line.strip() for line in manifest.splitlines() if line.strip().endswith((".onnx", ".txt"))]
        if not any(name.endswith(".onnx") for name in files) or not any(name.endswith(".txt") for name in files):
            raise RuntimeError("OCR model manifest is empty")
        for name in files:
            if Path(name).name != name or any(char in name for char in ("/", "\\", ":")):
                raise RuntimeError("OCR model manifest contains an unsafe filename")
            _regular(models / name)
        definitions = catalog.get("ocr_model_name", {})
        if not isinstance(definitions, dict):
            raise RuntimeError("Invalid OCR model definitions")
        for language in _LANGUAGES:
            definition = definitions.get(language)
            if not isinstance(definition, dict):
                raise RuntimeError("Missing OCR model definition: " + language)
            for component in ("det", "cls", "rec", "dict"):
                name = definition.get(component)
                if not isinstance(name, str) or Path(name).name != name or any(char in name for char in ("/", "\\", ":")):
                    raise RuntimeError("Invalid OCR model asset: " + language + "/" + component)
                _regular(models / name)
            _regular(models / "test_images" / (language + ".png"))
        return []
    except (OSError, ValueError, RuntimeError) as error:
        return [str(error)]


def _directory(path):
    path = Path(path)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError("Refusing an OCR cache symlink destination")
    path.mkdir(parents=True, exist_ok=True)


def _atomic_bytes(path, content, mode=0o600):
    path = Path(path)
    _directory(path.parent)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError("Refusing an OCR cache symlink destination")
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_payload(source, destination, hardlink=False):
    """Merge managed lib/resource files; config/output directories are never visited."""
    source, destination = Path(source), Path(destination)
    for folder in ("lib", "resource"):
        origin = source / folder
        if origin.is_symlink():
            raise RuntimeError("OCR cache payload must not contain symbolic links")
        if not origin.exists():
            continue
        count = 0
        for current, directories, files in os.walk(origin, followlinks=False):
            if any((Path(current) / name).is_symlink() for name in directories):
                raise RuntimeError("OCR cache payload must not contain symbolic links")
            for name in files:
                count += 1
                if count > 10_000:
                    raise RuntimeError("OCR cache has too many files")
                path = _regular(Path(current) / name)
                target = destination / path.relative_to(source)
                _directory(target.parent)
                if target.is_symlink() or any(parent.is_symlink() for parent in target.parents):
                    raise RuntimeError("Refusing an OCR cache symlink destination")
                if target.exists() and os.path.samefile(path, target):
                    continue
                if hardlink:
                    try:
                        os.link(path, target)
                        continue
                    except OSError:
                        pass
                if target.is_file() and path.stat().st_size == target.stat().st_size and path.read_bytes() == target.read_bytes():
                    continue
                _atomic_bytes(target, path.read_bytes(), path.stat().st_mode & 0o777)


def _invalidate(directory):
    marker = Path(directory) / _MARKER
    if marker.is_symlink() or any(parent.is_symlink() for parent in marker.parents):
        raise RuntimeError("Refusing an OCR cache marker outside owned storage")
    marker.unlink(missing_ok=True)


def _sync_libcxx(directory, abi, machine, native_libcxx):
    library = Path(directory) / "lib" / abi
    source = Path(native_libcxx) if native_libcxx and Path(native_libcxx).is_file() else library / "libc++_shared.so"
    if not source.is_file():
        source = library / _LIBCXX
    _elf(source, machine)
    old, new = b"libc++_shared.so", _LIBCXX.encode()
    content = source.read_bytes().replace(old, new)
    target = library / _LIBCXX
    if not target.is_file() or _regular(target).read_bytes() != content:
        _atomic_bytes(target, content, 0o755)
    server = _regular(library / "libBAAS_ocr_server.so")
    original = server.read_bytes()
    patched = original.replace(old, new)
    if patched != original:
        _atomic_bytes(server, patched, server.stat().st_mode & 0o777)
    server.chmod(0o755)


def install_ocr_cache_guards(client, installer):
    """Install once after OCR aliases exist, before check_git or client construction."""
    branch = getattr(installer, "TARGET_BRANCH", None)
    if branch not in _BRANCHES or os.getenv("BAAS_ANDROID", "").lower() not in {"1", "true", "yes", "on"}:
        return False
    if getattr(client.BaasOcrClient, "_android_cache_guard_installed", False):
        return True
    abi, machine = _BRANCHES[branch]
    backend = Path(client.__file__).resolve().parent.parent
    source = Path(installer.SERVER_BIN_DIR).resolve()
    allowed = (backend / "core/ocr/baas_ocr_client/bin-android" / branch,
               backend / "service/bin-android" / branch)
    if not source.is_absolute() or source not in allowed:
        raise RuntimeError("OCR installer cache is outside the active backend")
    internal_files = Path(os.environ.get("BAAS_ANDROID_INTERNAL_FILES_DIR", ""))
    if not internal_files.is_absolute():
        raise RuntimeError("Android OCR private runtime storage is unavailable")
    internal = internal_files.resolve() / "ocr-runtime" / branch
    native_dir = os.getenv("BAAS_ANDROID_NATIVE_LIBRARY_DIR", "").strip()
    native_libcxx = Path(native_dir) / "libc++_shared.so" if native_dir else None
    original_install = installer._install_android_prebuild
    selection = {"prefer_internal": False}

    @functools.wraps(original_install)
    def install(logger):
        with _LOCK:
            source_errors = cache_errors(source, abi, machine, native_libcxx)
            internal_errors = cache_errors(internal, abi, machine, native_libcxx)
            if source_errors:
                _invalidate(source)
            if internal_errors:
                _invalidate(internal)
            _directory(source.parent)
            # The upstream installer deletes its destination when downloading.
            # Give it an owned staging payload so user config/output stay intact.
            with tempfile.TemporaryDirectory(prefix=".ocr-repair-", dir=source.parent) as temporary:
                staged = Path(temporary) / "payload"
                staged.mkdir()
                if not source_errors:
                    _copy_payload(source, staged, hardlink=True)
                    _atomic_bytes(staged / _MARKER, _regular(source / _MARKER).read_bytes())
                old_directory, old_marker = installer.SERVER_BIN_DIR, installer.ANDROID_VERSION_FILE
                original_probe = getattr(installer, "_get_android_remote_sha", None)
                remote = {"called": False, "sha": None}
                def probe(*args, **kwargs):
                    value = original_probe(*args, **kwargs)
                    remote.update(called=True, sha=value)
                    return value
                try:
                    if callable(original_probe):
                        installer._get_android_remote_sha = probe
                    installer.SERVER_BIN_DIR = str(staged)
                    installer.ANDROID_VERSION_FILE = str(staged / _MARKER)
                    original_install(logger)
                finally:
                    installer.SERVER_BIN_DIR, installer.ANDROID_VERSION_FILE = old_directory, old_marker
                    if callable(original_probe):
                        installer._get_android_remote_sha = original_probe
                selection["prefer_internal"] = bool(
                    remote["called"] and not cache_errors(internal, abi, machine, native_libcxx)
                    and (not remote["sha"] or (internal / _MARKER).read_text(encoding="utf-8").strip() == remote["sha"])
                )
                if not cache_errors(staged, abi, machine, native_libcxx):
                    _invalidate(source)
                    _copy_payload(staged, source)
                    _atomic_bytes(source / _MARKER, _regular(staged / _MARKER).read_bytes())
                elif cache_errors(internal, abi, machine, native_libcxx):
                    raise RuntimeError("Android OCR prebuild is incomplete; retry setup with a working download source")

    original_prepare = client.BaasOcrClient._prepare_android_runtime_folder

    @functools.wraps(original_prepare)
    def prepare(instance):
        with _LOCK:
            source_errors = cache_errors(source, abi, machine, native_libcxx)
            internal_errors = cache_errors(internal, abi, machine, native_libcxx)
            source_sha = (source / _MARKER).read_bytes() if not source_errors else b""
            internal_sha = (internal / _MARKER).read_bytes() if not internal_errors else b""
            if source_errors and internal_errors:
                _invalidate(source)
                _invalidate(internal)
                raise RuntimeError("Android OCR cache is incomplete; retry setup to repair its dependencies and models")
            if not source_errors and (internal_errors or (source_sha != internal_sha and not selection["prefer_internal"])):
                _invalidate(internal)
                _copy_payload(source, internal)
                _sync_libcxx(internal, abi, machine, native_libcxx)
                errors = cache_errors(internal, abi, machine, native_libcxx, require_marker=False)
                if errors:
                    raise RuntimeError(errors[0])
                _atomic_bytes(internal / _MARKER, source_sha)
            else:
                # APK C++ dependencies can change while the OCR prebuild SHA stays the same.
                _sync_libcxx(internal, abi, machine, native_libcxx)
            return str(internal)

    installer._install_android_prebuild = install
    client.BaasOcrClient._prepare_android_runtime_folder = prepare
    client.BaasOcrClient._android_cache_guard_installed = True
    return True
