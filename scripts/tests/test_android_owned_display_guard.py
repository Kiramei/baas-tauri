"""Execute the Android primary-display guard patch without Android/device access."""

import ast
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, call, patch


REPO_ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_PATH = (REPO_ROOT / "src-tauri/gen/android/app/src/main/python"
                  / "android_backend/bootstrap.py")

# Minimal upstream behavior, including nested activation and unconditional force restore.
GUARD_SOURCE = '''\
class _AndroidDisplayResizeGuard:
    def __init__(self):
        self._lock = threading.Lock()
        self._active_count = 0
        self._restore_command = "wm size reset"

    @staticmethod
    def _target_size():
        return os.getenv("BAAS_ANDROID_WM_SIZE", "").strip() or None

    def activate(self, logger=None) -> None:
        if not _is_android_runtime():
            return
        target_size = self._target_size()
        if target_size is None:
            return
        with self._lock:
            self._active_count += 1
            if self._active_count != 1:
                return
        self._shell("wm size")
        self._shell(f"wm size {target_size}")

    def release(self, logger=None) -> None:
        if not _is_android_runtime():
            return
        with self._lock:
            if self._active_count <= 0:
                return
            self._active_count -= 1
            if self._active_count != 0:
                return
        self._shell("wm size reset")

    def force_restore(self, logger=None) -> None:
        if not _is_android_runtime():
            return
        with self._lock:
            self._active_count = 0
        self._shell(self._restore_command)
'''


def load_bootstrap():
    spec = importlib.util.spec_from_file_location("android_display_guard_bootstrap", BOOTSTRAP_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AndroidOwnedDisplayGuardTest(unittest.TestCase):
    def setUp(self):
        self.bootstrap = load_bootstrap()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "service/runtime.py"
        self.runtime.parent.mkdir()

    def install(self, source=GUARD_SOURCE):
        self.runtime.write_text(source, encoding="utf-8")
        self.bootstrap._patch_android_owned_display_resize_guard(self.root)
        patched = self.runtime.read_text(encoding="utf-8")
        namespace = {
            "os": os, "threading": threading, "_is_android_runtime": lambda: True,
            "Optional": __import__("typing").Optional, "Any": __import__("typing").Any,
        }
        exec(compile(patched, str(self.runtime), "exec"), namespace)
        guard = namespace["_AndroidDisplayResizeGuard"]()
        guard._shell = Mock(return_value="Physical size: 1080x2400")
        return guard, patched

    def assert_native_never_calls_shell(self, source=GUARD_SOURCE):
        guard, _ = self.install(source)
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "1",
                                     "BAAS_ANDROID_WM_SIZE": "1280x720"}):
            guard.activate(Mock())
            guard.activate()
            guard.release(Mock())
            guard.force_restore(Mock())
            # Also protect stale legacy bookkeeping and a stop without any active run.
            guard._active_count = 2
            guard.release()
            guard.force_restore()
            guard._active_count = 0
            guard.force_restore()
        guard._shell.assert_not_called()

    def assert_legacy_keeps_wm_behavior(self, source=GUARD_SOURCE):
        guard, _ = self.install(source)
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "0",
                                     "BAAS_ANDROID_WM_SIZE": "1280x720"}):
            guard.activate()
            guard.activate()
            guard.release()
            self.assertEqual(guard._shell.call_args_list,
                             [call("wm size"), call("wm size 1280x720")])
            guard.release()
            guard.force_restore()
        self.assertEqual(guard._shell.call_args_list,
                         [call("wm size"), call("wm size 1280x720"),
                          call("wm size reset"), call("wm size reset")])
        self.assertEqual(guard._active_count, 0)

    def test_native_activate_release_and_force_restore_never_touch_primary_display(self):
        self.assert_native_never_calls_shell()

    def test_legacy_nested_resize_and_restore_behavior_is_unchanged(self):
        self.assert_legacy_keeps_wm_behavior()

    def test_unset_native_flag_keeps_legacy_unconditional_force_restore(self):
        guard, _ = self.install()
        with patch.dict(os.environ, {}, clear=True):
            guard.force_restore()
        guard._shell.assert_called_once_with("wm size reset")

    def test_patch_is_idempotent_and_does_not_rewrite_other_classes(self):
        unrelated = "\nclass Other:\n    def force_restore(self, logger=None):\n        return 'other'\n"
        _, first = self.install(GUARD_SOURCE + unrelated)
        self.bootstrap._patch_android_owned_display_resize_guard(self.root)
        self.assertEqual(first, self.runtime.read_text(encoding="utf-8"))
        self.assertEqual(first.count("BAAS_ANDROID_OWNED_DISPLAY_"), 3)
        self.assertTrue(first.endswith(unrelated))

    def test_multiline_signature_and_docstring_remain_valid(self):
        source = GUARD_SOURCE.replace(
            "    def force_restore(self, logger=None) -> None:\n",
            '    def force_restore(\n        self, logger=None\n    ) -> None:\n'
            '        """Restore the old primary size in legacy mode."""\n',
        )
        guard, _ = self.install(source)
        self.assertEqual(guard.force_restore.__doc__, "Restore the old primary size in legacy mode.")
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "1"}):
            guard.force_restore()
        guard._shell.assert_not_called()

    def test_unknown_guard_shape_fails_closed_without_a_partial_patch(self):
        source = GUARD_SOURCE.replace("def release(", "def renamed_release(")
        self.runtime.write_text(source, encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "Cannot protect Android primary display"):
            self.bootstrap._patch_android_owned_display_resize_guard(self.root)
        self.assertEqual(self.runtime.read_text(encoding="utf-8"), source)

    def test_missing_runtime_or_absent_legacy_guard_needs_no_patch(self):
        self.bootstrap._patch_android_owned_display_resize_guard(self.root)
        source = "class Other:\n    pass\n"
        self.runtime.write_text(source, encoding="utf-8")
        self.bootstrap._patch_android_owned_display_resize_guard(self.root)
        self.assertEqual(self.runtime.read_text(encoding="utf-8"), source)

    def test_current_backend_guard_executes_with_native_and_legacy_modes(self):
        # Optional integration check against an adjacent development checkout; never touch it.
        upstream = REPO_ROOT.parent / "baas-dev/service/runtime.py"
        if not upstream.is_file():
            self.skipTest("adjacent backend checkout is unavailable")
        text = upstream.read_text(encoding="utf-8")
        guard_node = next(node for node in ast.parse(text).body
                          if isinstance(node, ast.ClassDef)
                          and node.name == "_AndroidDisplayResizeGuard")
        source = ast.get_source_segment(text, guard_node) + "\n"
        self.assert_native_never_calls_shell(source)
        self.assert_legacy_keeps_wm_behavior(source)

    def test_support_installation_invokes_owned_display_protection(self):
        calls = []
        names = [name for name in self.bootstrap.__dict__
                 if name.startswith("_patch_") or name.startswith("_write_")
                 or name in ("_apply_bundled_android_overlay", "_reuse_android_ocr_prebuild",
                             "_remove_android_legacy_device_dependencies")]
        with patch.object(self.bootstrap, "_android_support_fingerprint", return_value={}):
            originals = {name: self.bootstrap.__dict__[name] for name in names}
            try:
                for name in names:
                    self.bootstrap.__dict__[name] = lambda root, *args, _name=name: calls.append(_name)
                self.bootstrap._ensure_android_support_files(self.root)
            finally:
                self.bootstrap.__dict__.update(originals)
        self.assertIn("_patch_android_owned_display_resize_guard", calls)


if __name__ == "__main__":
    unittest.main()
