import asyncio
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock
from scripts.tests.test_android_resource_readiness import load_profiles, load_readiness


def resolve_server(server):
    return {"官服": "CN", "B服": "CN", "日服": "JP", "国际服": "Global"}.get(server)


def write_profile(root, config_id, server):
    directory = root / "config" / config_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "config.json").write_text(json.dumps({"server": server, "name": "Synthetic fixture"}, ensure_ascii=False))
    (directory / "event.json").write_text('{"fixture":true}')


class AndroidProfileResourcesTest(unittest.TestCase):
    def setUp(self):
        self.profiles = load_profiles()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checked = []

        def check(config_id):
            self.checked.append(config_id)
            if not (self.root / "config" / config_id / "config.json").is_file():
                write_profile(self.root, config_id, "官服")
        self.initializer = types.SimpleNamespace(check_config=Mock(side_effect=check))

    def test_unknown_server_profile_cannot_abort_shared_startup_or_rewrite_its_data(self):
        write_profile(self.root, "invalid", "JP")
        write_profile(self.root, "valid", "B服")
        write_profile(self.root, "default_config", "官服")
        before = {path.name: path.read_bytes() for path in (self.root / "config/invalid").iterdir()}
        errors = {}
        self.profiles.prepare_profiles(self.root, self.initializer, resolve_server, errors)
        self.assertEqual(set(self.checked), {"valid", "default_config"})
        self.assertIn("unsupported server", errors["invalid"])
        self.assertEqual(before, {path.name: path.read_bytes() for path in (self.root / "config/invalid").iterdir()})

    def test_malformed_profile_json_is_isolated_without_being_replaced(self):
        write_profile(self.root, "invalid", "官服")
        config = self.root / "config/invalid/config.json"
        config.write_text("{invalid JSON")
        errors = {}
        self.profiles.prepare_profiles(self.root, self.initializer, resolve_server, errors)
        self.assertIn("invalid", errors)
        self.assertEqual(config.read_text(), "{invalid JSON")
        self.assertEqual(self.checked, ["default_config"])

    def test_bad_reserved_template_is_explicit_global_failure(self):
        write_profile(self.root, "default_config", "JP")
        with self.assertRaisesRegex(RuntimeError, "default profile template"):
            self.profiles.prepare_profiles(self.root, self.initializer, resolve_server, {})
        self.assertEqual(self.checked, [])
        self.assertEqual(json.loads((self.root / "config/default_config/config.json").read_text())["server"], "JP")

    def test_incomplete_reserved_template_is_not_silently_recreated(self):
        (self.root / "config/default_config").mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, "template is incomplete"):
            self.profiles.prepare_profiles(self.root, self.initializer, resolve_server, {})
        self.assertEqual(self.checked, [])

    def runtime(self):
        class Runtime:
            def __init__(runtime):
                runtime._project_root = self.root
                runtime._sessions = {}

            def _ensure_config(runtime):
                raise AssertionError("The legacy all-or-nothing initializer must be replaced")

            def _get_or_create_session(runtime, config_id):
                runtime._sessions.setdefault(config_id, object())
                return runtime._sessions[config_id]
        self.profiles.install_profile_isolation(Runtime, lambda _: self.initializer, resolve_server)
        return Runtime()

    def test_only_invalid_session_fails_and_repair_can_retry_without_a_restart(self):
        write_profile(self.root, "invalid", "JP")
        write_profile(self.root, "valid", "官服")
        runtime = self.runtime()
        runtime._ensure_config()
        runtime._get_or_create_session("valid")
        with self.assertRaisesRegex(RuntimeError, "unsupported server"):
            runtime._get_or_create_session("invalid")
        self.assertNotIn("invalid", runtime._sessions)
        write_profile(self.root, "invalid", "日服")
        self.assertIsNotNone(runtime._get_or_create_session("invalid"))
        self.assertNotIn("invalid", runtime._android_profile_errors)
        self.assertIn("invalid", self.checked)

    def test_cached_session_is_revalidated_after_profile_edit(self):
        write_profile(self.root, "valid", "官服")
        runtime = self.runtime()
        session = runtime._get_or_create_session("valid")
        write_profile(self.root, "valid", "unknown")
        with self.assertRaisesRegex(RuntimeError, "unsupported server"):
            runtime._get_or_create_session("valid")
        write_profile(self.root, "valid", "官服")
        self.assertIs(runtime._get_or_create_session("valid"), session)

    def test_valid_session_does_not_repeat_initializer_and_reset_user_switches(self):
        write_profile(self.root, "valid", "官服")
        runtime = self.runtime()
        runtime._ensure_config()
        checked = list(self.checked)
        switch = self.root / "config/valid/switch.json"
        switch.write_text('{"userChoice":false}')
        runtime._get_or_create_session("valid")
        self.assertEqual(self.checked, checked)
        self.assertEqual(switch.read_text(), '{"userChoice":false}')

    def test_invalid_profile_does_not_prevent_actual_shared_ocr_initializer(self):
        write_profile(self.root, "invalid", "JP")
        runtime = self.runtime()
        main = types.SimpleNamespace(ocr_needed=["en-us", "zh-cn"], ocr=types.SimpleNamespace(client=object(), test_models=Mock()), init_ocr=Mock(return_value=True), init_static_config=Mock(return_value=True))
        runtime._main = main
        runtime.is_all_data_initialized = False

        def initialize(instance):
            instance._ensure_config()
            instance._main.init_ocr()
            instance._main.init_static_config()
            instance.is_all_data_initialized = True
        type(runtime).init_all_data = initialize
        load_readiness().install_runtime_readiness(type(runtime), Mock(), validate_resources=Mock(), validate_ocr_assets=Mock())
        runtime.init_all_data()
        self.assertTrue(runtime._android_resources_ready)
        main.ocr.test_models.assert_called_once()
        self.assertIn("invalid", runtime._android_profile_errors)

    def test_async_cached_session_paths_validate_server_before_starting_or_returning_it(self):
        write_profile(self.root, "valid", "官服")
        calls = []
        async def cached(runtime, config_id, *args, **kwargs):
            calls.append(config_id)
            return runtime._sessions[config_id]
        class Runtime:
            def _get_or_create_session(self, config_id):
                return self._sessions[config_id]
            get_session = cached
            start_scheduler = cached
            solve_task = cached
        self.profiles.install_profile_isolation(Runtime, lambda _: self.initializer, resolve_server)
        runtime = Runtime()
        runtime._project_root = self.root
        runtime._sessions = {"valid": object()}
        for name in ("get_session", "start_scheduler", "solve_task"):
            self.assertIs(asyncio.run(getattr(runtime, name)("valid")), runtime._sessions["valid"])
        write_profile(self.root, "valid", "JP")
        for name in ("get_session", "start_scheduler", "solve_task"):
            with self.assertRaisesRegex(RuntimeError, "unsupported server"):
                asyncio.run(getattr(runtime, name)("valid"))
        self.assertEqual(calls, ["valid"] * 3)


if __name__ == "__main__":
    unittest.main()
