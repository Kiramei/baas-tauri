import asyncio
import importlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_PATH = (
    REPO_ROOT
    / "src-tauri"
    / "gen"
    / "android"
    / "app"
    / "src"
    / "main"
    / "python"
    / "android_backend"
    / "bootstrap.py"
)


def load_bootstrap():
    spec = importlib.util.spec_from_file_location("android_bootstrap_test", BOOTSTRAP_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class AndroidBootstrapPreserveTest(unittest.TestCase):
    def test_lightweight_apk_uses_downloaded_service_without_overlay_error(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "baas"
            (root / "service").mkdir(parents=True)
            (root / "service/app.py").write_text("# downloaded service\n", encoding="utf-8")
            with patch.object(bootstrap, "_bundled_backend_archive", return_value=root / "absent.zip"), \
                 patch.dict(bootstrap.os.environ, {"BAAS_ANDROID_INTERNAL_FILES_DIR": tmp}), \
                 patch("builtins.print") as output:
                bootstrap._activate_bundled_service_transport(root)
                output.assert_not_called()

    def test_support_cache_reuses_files_and_invalidates_on_edits_or_deletion(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "main.service.py"
            source.write_text("original\n", encoding="utf-8")
            with patch.object(bootstrap, "_bundled_backend_archive", return_value=root / "absent.zip"):
                fingerprint = bootstrap._android_support_fingerprint(root)
                (root / ".android-support-cache.json").write_text(json.dumps(fingerprint), encoding="utf-8")
                with patch.object(bootstrap, "_apply_bundled_android_overlay") as apply:
                    bootstrap._ensure_android_support_files(root)
                    apply.assert_not_called()
                source.write_text("changed content\n", encoding="utf-8")
                self.assertNotEqual(fingerprint, bootstrap._android_support_fingerprint(root))
                source.unlink()
                self.assertNotEqual(fingerprint, bootstrap._android_support_fingerprint(root))

    def test_cafe_swipe_lasts_longer_than_configured_capture_delay(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            injection = root / "service/injection.py"
            injection.parent.mkdir()
            injection.write_text(
                "def swipe(self, shot_delay):\n"
                "        self.u2_swipe(131, 660, 1280, 660, duration=0.3)\n",
                encoding="utf-8",
            )
            bootstrap._patch_android_cafe_swipe_timing(root)
            namespace = {}
            exec(injection.read_text(encoding="utf-8"), namespace)
            for delay in (0, 0.3, 1.0):
                baas = types.SimpleNamespace(u2_swipe=Mock())
                namespace["swipe"](baas, delay)
                duration = baas.u2_swipe.call_args.kwargs["duration"]
                self.assertGreaterEqual(duration, delay + 0.4)
                self.assertGreaterEqual(duration, 0.5)

    def test_ocr_readiness_waits_and_rebinds_sessions_created_early(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "service/runtime.py"
            runtime.parent.mkdir()
            runtime.write_text(
                "class Runtime:\n"
                "    def _ensure_config(self) -> None:\n        pass\n"
                "    async def start_scheduler(self, config_id):\n"
                "        async with self._async_lock():\n"
                "            session = self._get_or_create_session(config_id)\n"
                "    async def solve_task(self, task_name):\n"
                "        if task_name in _TASK_ALIAS:\n            pass\n",
                encoding="utf-8",
            )
            bootstrap._patch_android_ocr_session_readiness(root)
            first = runtime.read_text(encoding="utf-8")
            bootstrap._patch_android_ocr_session_readiness(root)
            self.assertEqual(first, runtime.read_text(encoding="utf-8"))
            namespace = {"asyncio": asyncio, "_is_android_runtime": lambda: True}
            exec(first, namespace)
            instance = namespace["Runtime"]()
            instance.is_all_data_initialized = False
            instance._main = types.SimpleNamespace(ocr=None)
            baas = types.SimpleNamespace(set_ocr=Mock())
            instance._sessions = {"early": types.SimpleNamespace(baas=baas)}
            ocr = object()

            async def complete_loading(_delay):
                instance._main.ocr = ocr
                instance.is_all_data_initialized = True

            with patch.object(asyncio, "sleep", AsyncMock(side_effect=complete_loading)) as sleep:
                asyncio.run(instance._ensure_android_ocr_ready())
                sleep.assert_awaited_once()
            baas.set_ocr.assert_called_once_with(ocr)
            instance._main.ocr = None
            with self.assertRaisesRegex(RuntimeError, "OCR initialization failed"):
                asyncio.run(instance._ensure_android_ocr_ready())

    def test_ocr_reuses_legacy_download_without_overwriting_current_library(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = root / "core/ocr/baas_ocr_client/bin-android/android-arm64-v8a"
            binary = Path("lib/arm64-v8a/libBAAS_ocr_server.so")
            (legacy / binary).parent.mkdir(parents=True)
            (legacy / binary).write_bytes(b"legacy-library")
            target = root / "service/bin-android/android-arm64-v8a"
            bootstrap._reuse_android_ocr_prebuild(root)
            self.assertFalse(target.exists())
            (legacy / ".baas-ocr-prebuild-sha").write_text("installed-sha")
            bootstrap._reuse_android_ocr_prebuild(root)
            self.assertEqual((target / binary).read_bytes(), b"legacy-library")
            self.assertTrue((legacy / binary).exists())
            (target / binary).write_bytes(b"updated-library")
            bootstrap._reuse_android_ocr_prebuild(root)
            self.assertEqual((target / binary).read_bytes(), b"updated-library")

    def test_android_ocr_client_and_installer_are_injected_together(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            injection = root / "service" / "injection.py"
            injection.parent.mkdir(parents=True)
            injection.write_text(
                "def _install_android_ocr_modules():\n"
                "    from service import android_ocr_client\n\n"
                '    sys.modules["core.ocr.baas_ocr_client.Client"] = android_ocr_client\n',
                encoding="utf-8",
            )

            bootstrap._patch_android_ocr_module_injection(root)
            patched = injection.read_text(encoding="utf-8")

            service = types.ModuleType("service")
            service.android_ocr_client = types.ModuleType("service.android_ocr_client")
            service.android_ocr_installer = types.ModuleType("service.android_ocr_installer")
            with patch.dict(sys.modules, {"service": service}):
                namespace = {"sys": sys}
                exec(compile(patched, str(injection), "exec"), namespace)
                namespace["_install_android_ocr_modules"]()
                self.assertIs(
                    sys.modules["core.ocr.baas_ocr_client.Client"],
                    service.android_ocr_client,
                )
                self.assertIs(
                    sys.modules["core.ocr.baas_ocr_client.server_installer"],
                    service.android_ocr_installer,
                )

            bootstrap._patch_android_ocr_module_injection(root)
            self.assertEqual(injection.read_text(encoding="utf-8"), patched)

    def test_ocr_first_download_uses_the_active_installer_folder_with_legacy_and_alias_modules(self):
        bootstrap = load_bootstrap()
        for alias in (False, True):
            with self.subTest(alias=alias), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                service_dir = root / "service"
                service_dir.mkdir()
                client = service_dir / "android_ocr_client.py"
                client.write_text(
                    "def _server_folder_path():\n"
                    "    base = os.path.dirname(__file__)\n"
                    "    android_branch = _android_ocr_branch()\n"
                    "    if android_branch:\n"
                    '        return os.path.join(base, "bin-android", android_branch)\n'
                    '    return os.path.join(base, "bin")\n'
                    "class Client:\n"
                    "    server_folder_path = _server_folder_path()\n"
                    "    def read_library(self):\n"
                    "        return (Path(_server_folder_path()) / 'lib/arm64-v8a/libBAAS_ocr_server.so').read_bytes()\n",
                    encoding="utf-8",
                )
                installer_file = service_dir / "android_ocr_installer.py"
                expected = root / ("core/ocr/baas_ocr_client" if alias else "service") / "bin-android/android-arm64-v8a"
                if alias:
                    installer_file.write_text(
                        "import sys\n"
                        "from core.ocr.baas_ocr_client import server_installer\n"
                        "sys.modules[__name__] = server_installer\n",
                        encoding="utf-8",
                    )
                else:
                    installer_file.write_text(f"SERVER_BIN_DIR = {str(expected)!r}\n", encoding="utf-8")

                service = types.ModuleType("service")
                service.__path__ = [str(service_dir)]
                core_client = types.ModuleType("core.ocr.baas_ocr_client")
                core_installer = types.ModuleType("core.ocr.baas_ocr_client.server_installer")
                core_installer.SERVER_BIN_DIR = str(expected)
                core_client.server_installer = core_installer
                modules = {
                    "service": service,
                    "core.ocr.baas_ocr_client": core_client,
                    "core.ocr.baas_ocr_client.server_installer": core_installer,
                }
                bootstrap._patch_android_ocr_module_injection(root)
                first = client.read_text(encoding="utf-8")
                bootstrap._patch_android_ocr_module_injection(root)
                self.assertEqual(first, client.read_text(encoding="utf-8"))
                with patch.dict(sys.modules, modules):
                    sys.modules.pop("service.android_ocr_installer", None)
                    namespace = {
                        "__file__": str(client), "os": bootstrap.os, "Path": Path,
                        "_android_ocr_branch": lambda: "android-arm64-v8a",
                    }
                    exec(compile(first, str(client), "exec"), namespace)
                    installer = importlib.import_module("service.android_ocr_installer")
                    self.assertEqual(namespace["Client"].server_folder_path, installer.SERVER_BIN_DIR)
                    self.assertFalse(expected.exists(), "no previous download or restart copy is required")
                    binary = Path(installer.SERVER_BIN_DIR) / "lib/arm64-v8a/libBAAS_ocr_server.so"
                    binary.parent.mkdir(parents=True)
                    binary.write_bytes(b"downloaded-in-this-process")
                    self.assertEqual(namespace["Client"]().read_library(), b"downloaded-in-this-process")
                    namespace["_android_ocr_branch"] = lambda: None
                    self.assertEqual(namespace["_server_folder_path"](), str(service_dir / "bin"))

    def test_pygit2_stub_supports_installer_callback_import(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules):
            root = Path(tmp)
            bootstrap._write_pygit2_stub(root)
            for name in list(sys.modules):
                if name == "pygit2" or name.startswith("pygit2."):
                    del sys.modules[name]
            spec = importlib.util.spec_from_file_location(
                "pygit2", root / "pygit2" / "__init__.py"
            )
            stub = importlib.util.module_from_spec(spec)
            sys.modules["pygit2"] = stub
            assert spec.loader is not None
            spec.loader.exec_module(stub)

            self.assertIs(stub.RemoteCallbacks, stub.callbacks.RemoteCallbacks)
            # Importing an installer helper must be safe even though Android's
            # stub deliberately refuses repository/network operations.
            class NonInteractiveCallbacks(stub.RemoteCallbacks):
                pass

            self.assertIsInstance(NonInteractiveCallbacks(), stub.callbacks.RemoteCallbacks)
            backend_helper = (
                REPO_ROOT.parent / "baas-dev" / "deploy" / "installer" / "git_backend.py"
            )
            if backend_helper.is_file():
                spec = importlib.util.spec_from_file_location(
                    "android_git_backend_test", backend_helper
                )
                helper = importlib.util.module_from_spec(spec)
                assert spec.loader is not None
                spec.loader.exec_module(helper)
                callbacks = helper.NonInteractiveCallbacks()
                self.assertIsInstance(callbacks, stub.RemoteCallbacks)
                with self.assertRaises(stub.GitError):
                    callbacks.credentials("https://example.invalid/repo.git", None, 0)

    def test_python_import_relocates_stray_nested_import(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "sample.py"
            target.write_text(
                "import os\n\n\ndef helper():\n    from java import jclass\nimport time\n    return jclass\n",
                encoding="utf-8",
            )

            bootstrap._ensure_python_import(target, "time")

            patched = target.read_text(encoding="utf-8")
            self.assertTrue(patched.startswith("import os\nimport time\n"))
            self.assertEqual(patched.count("import time"), 1)

    def test_git_managed_backend_skips_bundled_replacement(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".git").mkdir()
            (root / ".baas-updater").mkdir()
            (root / "main.service.py").write_text("print('runtime')\n", encoding="utf-8")
            (root / "android-backend-source.json").write_text(
                '{"sha":"installed"}\n', encoding="utf-8"
            )

            bootstrap._bundled_backend_changed = lambda _root: True
            bootstrap._ensure_android_support_files = lambda _root: None
            bootstrap._start_local_atx_agent_async_if_enabled = lambda _root: None

            installed = bootstrap._ensure_backend_files(root, {})

            self.assertFalse(installed)
            self.assertTrue((root / ".git").is_dir())
            self.assertTrue((root / ".baas-updater").is_dir())
            self.assertTrue((root / "main.service.py").exists())

    def test_replace_backend_files_preserves_git_metadata(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            next_root = root / ".baas-next"
            root.mkdir()
            next_root.mkdir()
            (root / ".git").mkdir()
            (root / ".baas-updater").mkdir()
            (root / "setup.toml").write_text("current_baas_sha = \"old\"\n", encoding="utf-8")
            (root / "stale.py").write_text("stale\n", encoding="utf-8")
            (next_root / "main.service.py").write_text("fresh\n", encoding="utf-8")

            bootstrap._replace_backend_files(root, next_root)

            self.assertTrue((root / ".git").is_dir())
            self.assertTrue((root / ".baas-updater").is_dir())
            self.assertTrue((root / "setup.toml").exists())
            self.assertFalse((root / "stale.py").exists())
            self.assertEqual((root / "main.service.py").read_text(encoding="utf-8"), "fresh\n")


if __name__ == "__main__":
    unittest.main()
