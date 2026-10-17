import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


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

    def test_virtual_display_watchdog_finds_game_root_task(self):
        bootstrap = load_bootstrap()
        stack_dump = (
            "RootTask id=55 bounds=[0,0][720,1280] displayId=0 userId=0\n"
            "  taskId=55: io.github.kiramei.baas_tauri.dev/.MainActivity\n\n"
            "RootTask id=56 bounds=[0,0][1280,720] displayId=0 userId=0\n"
            "  taskId=56: com.RoamingStar.BlueArchive.bilibili/.MainActivity\n"
        )

        self.assertEqual(bootstrap._android_game_root_tasks(stack_dump), [(56, 0)])

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
