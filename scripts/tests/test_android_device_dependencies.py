import ast
import importlib.util
import os
import re
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
MODULES = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"


def load(name):
    spec = importlib.util.spec_from_file_location(name, MODULES / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AndroidDeviceDependenciesTest(unittest.TestCase):
    def generated_app_current(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            load("bootstrap")._write_uiautomator2_stub(root)
            tree = ast.parse((root / "uiautomator2/__init__.py").read_text(encoding="utf-8"))
        method = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "app_current")
        namespace = {"os": os, "re": re}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "generated-app-current", "exec"), namespace)
        return namespace["app_current"]

    def test_native_current_package_does_not_fall_back_to_the_physical_display(self):
        app_current = self.generated_app_current()
        device = types.SimpleNamespace(_jsonrpc=Mock(), shell=Mock())
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "1"}):
            for package in ("", "example.game"):
                device._jsonrpc.return_value = {"currentPackageName": package}
                self.assertEqual(app_current(device), {"package": package, "activity": ""})
            device._jsonrpc.side_effect = RuntimeError("bridge unavailable")
            with self.assertRaisesRegex(RuntimeError, "bridge unavailable"):
                app_current(device)
            device.shell.assert_not_called()

    def test_legacy_current_package_fallback_remains_available_outside_native_capture(self):
        app_current = self.generated_app_current()
        device = types.SimpleNamespace(_jsonrpc=Mock(return_value={"currentPackageName": ""}),
                                       shell=Mock(return_value=("mCurrentFocus=Window{123 u0 example.physical/.Main}", 0)))
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "0"}):
            self.assertEqual(app_current(device), {"package": "example.physical", "activity": ".Main"})
            device.shell.assert_called_once()

    def test_third_party_device_packages_are_not_bundled(self):
        gradle = (ROOT / "src-tauri/gen/android/app/build.gradle.kts").read_text()
        self.assertNotIn('install("adbutils', gradle)
        self.assertNotIn('install("uiautomator2', gradle)

    def test_android_import_rewrites_are_idempotent(self):
        bootstrap = load("bootstrap")
        legacy = load("legacy_device_imports")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            device = root / "core/device"
            device.mkdir(parents=True)
            connection = device / "connection.py"
            connection.write_text("from adbutils import adb, AdbDevice\nfrom adbutils.errors import AdbError, AdbTimeout\nclass Connection: pass\n")
            client = device / "uiautomator2_client.py"
            client.write_text("import adbutils\nfrom retry import retry\n")
            bootstrap._remove_android_legacy_device_dependencies(root)
            first = connection.read_text(), client.read_text()
            bootstrap._remove_android_legacy_device_dependencies(root)
            self.assertEqual(first, (connection.read_text(), client.read_text()))
            self.assertNotIn("adbutils", first[0])
            self.assertNotIn("retry", first[1])
            with patch.dict("sys.modules", {"android_backend": types.ModuleType("android_backend"),
                                            "android_backend.legacy_device_imports": legacy}):
                namespace = {}
                exec(first[0], namespace)
                self.assertIn("Connection", namespace)

    def test_accidental_adb_selection_fails_instead_of_falling_back(self):
        legacy = load("legacy_device_imports")
        with self.assertRaisesRegex(RuntimeError, "android_local"):
            legacy.adb.device()
        with self.assertRaisesRegex(RuntimeError, "android_local"):
            legacy.AdbDevice()

    def test_compatibility_client_uses_local_bridge_without_adb(self):
        calls = []
        connection = types.SimpleNamespace(click=lambda x, y: calls.append((x, y)))
        bridge = types.ModuleType("uiautomator2")
        bridge.connect = lambda serial: connection
        version = types.ModuleType("uiautomator2.version")
        version.__apk_version__ = version.__atx_agent_version__ = version.__version__ = "android-local"
        with patch.dict("sys.modules", {"uiautomator2": bridge, "uiautomator2.version": version}):
            client = load("local_device_client")
            instance = client.U2Client.get_instance("127.0.0.1:7912")
            instance.click(10, 20)
            self.assertEqual(calls, [(10, 20)])
            self.assertIs(instance, client.U2Client.get_instance("127.0.0.1:7912"))
            client.U2Client.release_instance("127.0.0.1:7912")
            self.assertNotIn("127.0.0.1:7912", client.U2Client.connections)
            with self.assertRaisesRegex(RuntimeError, "Shizuku"):
                client.BAAS_U2_Initer()


if __name__ == "__main__":
    unittest.main()
