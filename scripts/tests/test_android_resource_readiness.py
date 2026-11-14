import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
from scripts.tests.test_android_bootstrap_preserve import load_bootstrap


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend/resource_readiness.py"


def load_readiness():
    spec = importlib.util.spec_from_file_location("android_resource_readiness_test", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_profiles():
    spec = importlib.util.spec_from_file_location("android_profile_resources_test", SOURCE.with_name("profile_resources.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_runtime(main):
    class Runtime:
        def __init__(self):
            self._main = main
            self._project_root = Path("/synthetic-backend")
            self._sessions = {}
            self.is_all_data_initialized = False

        def _get_or_create_session(self, config_id):
            return config_id

        def init_all_data(self, need_ocr_update_check=True):
            if not self._main.init_ocr(need_ocr_update_check=need_ocr_update_check):
                return
            # The real service ignores a False static initializer result.
            self._main.init_static_config()
            self.is_all_data_initialized = True

    return Runtime


class AndroidResourceReadinessTest(unittest.TestCase):
    def setUp(self):
        self.readiness = load_readiness()
        self.events = []
        self.main = types.SimpleNamespace(
            ocr=types.SimpleNamespace(client=object(), test_models=Mock()),
            ocr_needed=["en-us", "zh-cn"],
            init_ocr=Mock(return_value=True),
            init_static_config=Mock(return_value=True),
        )
        self.runtime_class = fake_runtime(self.main)
        self.validate = Mock()
        self.validate_ocr = Mock()

    def install(self):
        self.readiness.install_runtime_readiness(
            self.runtime_class,
            lambda *event: self.events.append(event),
            validate_resources=self.validate,
            validate_ocr_assets=self.validate_ocr,
        )
        return self.runtime_class()

    def test_ready_requires_real_model_probe_and_static_validation(self):
        runtime = self.install()
        runtime.init_all_data(need_ocr_update_check=False)
        self.main.init_ocr.assert_called_once_with(need_ocr_update_check=False)
        self.main.ocr.test_models.assert_called_once_with(["en-us", "zh-cn"])
        self.validate_ocr.assert_called_once_with(self.main.ocr.client)
        self.validate.assert_called_once_with(runtime._project_root)
        self.assertTrue(runtime.is_all_data_initialized)
        self.assertTrue(runtime._android_resources_ready)
        self.assertEqual(self.events[-1][:2], ("resources", "done"))
        self.assertEqual([item[:2] for item in self.events], [
            ("resources", "running"), ("ocr", "running"),
            ("ocr", "done"), ("resources", "running"), ("resources", "done"),
        ])

    def test_missing_ocr_is_failure_even_when_client_object_was_left_behind(self):
        self.main.init_ocr.return_value = False
        runtime = self.install()
        with self.assertRaisesRegex(RuntimeError, "OCR initialization failed"):
            runtime.init_all_data()
        self.assertFalse(runtime.is_all_data_initialized)
        self.assertFalse(runtime._android_resources_ready)
        self.assertEqual(self.events[-1][:2], ("resources", "failed"))
        self.assertIn("Traceback", self.events[-1][3])
        self.validate.assert_not_called()

    def test_ocr_object_without_live_client_is_not_ready(self):
        self.main.ocr.client = None
        runtime = self.install()
        with self.assertRaisesRegex(RuntimeError, "model verification"):
            runtime.init_all_data()
        self.assertFalse(runtime._android_resources_ready)

    def test_model_recognition_failure_does_not_publish_readiness(self):
        self.main.ocr.test_models.side_effect = RuntimeError("missing zh-cn model")
        runtime = self.install()
        with self.assertRaisesRegex(RuntimeError, "missing zh-cn model"):
            runtime.init_all_data()
        self.assertFalse(runtime.is_all_data_initialized)
        self.main.init_static_config.assert_not_called()

    def test_static_failure_cannot_be_ignored_by_backend(self):
        self.main.init_static_config.return_value = False
        runtime = self.install()
        with self.assertRaisesRegex(RuntimeError, "static configuration"):
            runtime.init_all_data()
        self.assertFalse(runtime.is_all_data_initialized)
        self.assertFalse(runtime._android_resources_ready)

    def test_missing_script_assets_keep_startup_failed(self):
        self.validate.side_effect = FileNotFoundError("CN.json")
        runtime = self.install()
        with self.assertRaises(FileNotFoundError):
            runtime.init_all_data()
        self.assertIn("CN.json", runtime._android_resource_error)
        self.assertFalse(runtime.is_all_data_initialized)

    def test_timeout_cannot_be_overwritten_by_late_model_completion(self):
        timer = Mock()
        with patch.object(self.readiness.threading, "Timer", return_value=timer) as create_timer:
            runtime = self.install()
            self.main.ocr.test_models.side_effect = lambda _: create_timer.call_args.args[1]()
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                runtime.init_all_data()
        self.assertFalse(runtime.is_all_data_initialized)
        self.assertFalse(runtime._android_resources_ready)
        self.assertFalse(any(item[:2] == ("resources", "done") for item in self.events))
        timer.cancel.assert_called_once()

    def test_original_methods_restored_after_success_or_failure(self):
        original_ocr, original_static = self.main.init_ocr, self.main.init_static_config
        runtime = self.install()
        self.main.ocr.test_models.side_effect = ValueError("probe failed")
        with self.assertRaises(ValueError):
            runtime.init_all_data()
        self.assertIs(self.main.init_ocr, original_ocr)
        self.assertIs(self.main.init_static_config, original_static)

    def test_duplicate_install_does_not_double_wrap_models(self):
        runtime = self.install()
        self.readiness.install_runtime_readiness(self.runtime_class, Mock())
        runtime.init_all_data()
        self.main.ocr.test_models.assert_called_once()

    def test_task_gate_reports_original_global_failure_instead_of_calling_it_ocr(self):
        self.runtime_class._ensure_android_ocr_ready = AsyncMock(side_effect=RuntimeError("OCR initialization failed"))
        original_gate = self.runtime_class._ensure_android_ocr_ready
        runtime = self.install()
        runtime._android_resource_error = "KeyError: unsupported profile server"
        with self.assertRaisesRegex(RuntimeError, "KeyError: unsupported profile server"):
            asyncio.run(runtime._ensure_android_ocr_ready())
        original_gate.assert_not_awaited()

    def test_task_gate_keeps_failure_discovered_while_waiting_for_resources(self):
        async def legacy_gate(runtime):
            runtime._android_resource_error = "FileNotFoundError: script catalog"
            raise RuntimeError("OCR initialization failed")
        self.runtime_class._ensure_android_ocr_ready = legacy_gate
        runtime = self.install()
        with self.assertRaisesRegex(RuntimeError, "FileNotFoundError: script catalog"):
            asyncio.run(runtime._ensure_android_ocr_ready())

    def test_resource_catalogs_are_read_and_missing_region_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config").mkdir()
            (root / "config/static.json").write_text('{"fixture": true}')
            (root / "src/rgb_feature").mkdir(parents=True)
            for identifier in ("CN", "JP", "Global_en-us", "Global_zh-tw", "Global_ko-kr"):
                (root / "src/rgb_feature" / (identifier + ".json")).write_text(json.dumps({"rgb_feature": {}}))
                images = root / "src/images" / identifier
                (images / "x_y_range").mkdir(parents=True)
                (images / "x_y_range/catalog.py").write_text("x_y_range = {}")
                (images / "fixture.png").write_bytes(b"synthetic fixture")
            self.readiness.validate_script_resources(root)
            (root / "src/images/JP/fixture.png").unlink()
            with self.assertRaisesRegex(RuntimeError, "Missing image resources: JP"):
                self.readiness.validate_script_resources(root)

    def test_all_region_ocr_assets_are_checked_without_loading_extra_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            models = root / "resource/ocr_models"
            (models / "test_images").mkdir(parents=True)
            catalog = {}
            for language in ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr"):
                definition = {key: language + "-" + key for key in ("det", "cls", "rec", "dict")}
                catalog[language] = definition
                for name in definition.values():
                    (models / name).write_bytes(b"synthetic fixture")
                (models / "test_images" / (language + ".png")).write_bytes(b"synthetic fixture")
            (root / "resource/static.json").write_text(json.dumps({"ocr_model_name": catalog}))
            client = types.SimpleNamespace(server_folder_path=str(root))
            self.readiness.validate_ocr_model_assets(client)
            (models / "ja-jp-rec").unlink()
            with self.assertRaisesRegex(RuntimeError, "Missing OCR model asset: ja-jp"):
                self.readiness.validate_ocr_model_assets(client)

    def test_bootstrap_persists_each_real_phase_and_cannot_call_a_socket_script_ready(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = {"stage": "service", "resourcesReady": False, "steps": bootstrap._initial_steps()}
            bootstrap._BOOTSTRAP_STATUS = status
            bootstrap._report_resource_readiness(root, "ocr", "running", "loading models")
            bootstrap._set_step(root, status, "service", "done", "listening", make_current=False)
            persisted = bootstrap._read_status(root, {})
            self.assertFalse(persisted["resourcesReady"])
            self.assertEqual(persisted["currentStep"], "ocr")
            bootstrap._report_resource_readiness(root, "ocr", "done", "models verified")
            bootstrap._report_resource_readiness(root, "resources", "running", "checking catalogs")
            self.assertFalse(bootstrap._read_status(root, {})["resourcesReady"])
            bootstrap._report_resource_readiness(root, "resources", "done", "resources verified")
            self.assertTrue(bootstrap._read_status(root, {})["resourcesReady"])

    def test_failed_resource_log_remains_visible_when_transport_later_binds(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = {"steps": bootstrap._initial_steps()}
            bootstrap._BOOTSTRAP_STATUS = status
            bootstrap._report_resource_readiness(root, "ocr", "running", "loading models")
            bootstrap._report_resource_readiness(root, "resources", "failed", "model missing", "original trace")
            bootstrap._set_step(root, status, "service", "done", "listening", make_current=False)
            persisted = bootstrap._read_status(root, {})
            self.assertEqual(persisted["stage"], "failed")
            self.assertFalse(persisted["resourcesReady"])
            self.assertEqual(persisted["error"], "model missing")
            self.assertEqual(persisted["traceback"], "original trace")
            self.assertEqual(next(item for item in persisted["steps"] if item["id"] == "ocr")["state"], "failed")

    def test_android_disallows_missing_ocr_even_if_inherited_environment_allowed_it(self):
        bootstrap = load_bootstrap()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(bootstrap.os.environ, {"BAAS_ALLOW_MISSING_OCR": "1"}):
            bootstrap._configure_environment(temporary, 8190)
            self.assertEqual(bootstrap.os.environ["BAAS_ALLOW_MISSING_OCR"], "0")

    def test_asgi_installs_resource_gate_before_forwarding_service_lifespan(self):
        bootstrap = load_bootstrap()
        service_app = AsyncMock()
        service_app.router = types.SimpleNamespace(routes=[
            types.SimpleNamespace(path="/health"), types.SimpleNamespace(path="/android/wiki/page"),
        ])
        modules = {
            "android_backend": types.ModuleType("android_backend"),
            "android_backend.resource_readiness": self.readiness,
            "android_backend.profile_resources": load_profiles(),
            "service": types.ModuleType("service"),
            "service.runtime": types.SimpleNamespace(ServiceRuntime=self.runtime_class),
            "service.app": types.SimpleNamespace(app=service_app),
        }
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, modules):
            app = bootstrap._build_baas_asgi_app(Path(temporary), 8190)
            self.assertTrue(self.runtime_class._android_resource_readiness_installed)
            scope, receive, send = {"type": "lifespan"}, AsyncMock(), AsyncMock()
            asyncio.run(app(scope, receive, send))
        service_app.assert_awaited_once_with(scope, receive, send)
        self.assertEqual([route.path for route in service_app.router.routes], ["/health"])


if __name__ == "__main__":
    unittest.main()
