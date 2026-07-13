import importlib.util
import tempfile
import unittest
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
