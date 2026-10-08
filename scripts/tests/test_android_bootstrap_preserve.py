import importlib.util
import json
import asyncio
import tempfile
import sys
import types
import unittest
from unittest.mock import patch, AsyncMock, Mock
from pathlib import Path


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
