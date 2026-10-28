"""Docker startup regression tests; no containers, nginx or backend processes run."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("baas_container", ROOT / "scripts/docker/container.py")
container = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(container)


class DockerStartupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="baas-docker-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "app"
        self.app.mkdir()

    def setup_config(self, text):
        (self.app / "setup.toml").write_text(text)

    def git(self, path, *args):
        return subprocess.run(
            ["git", "-c", "user.name=Docker Test", "-c", "user.email=docker-test@example.invalid", *args],
            cwd=path, check=True, capture_output=True, text=True,
        ).stdout.strip()

    def make_repository(self, service=True):
        repo = self.root / "source"
        repo.mkdir()
        self.git(repo, "init", "-b", "master")
        (repo / "README").write_text("fixture only")
        if service:
            (repo / "main.service.py").write_text("# Test fixture; never executed.\n")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Initial fixture")
        return repo

    def make_ocr_repository(self):
        repo = self.root / "ocr-source"
        repo.mkdir()
        self.git(repo, "init", "-b", "linux-x64")
        for name in ("BAAS_ocr_server", "libBAAS_ipc.so", "libonnxruntime.so.1", "libopencv_world.so.409"):
            (repo / name).write_text("fixture only; never executed")
        models = repo / "resource/ocr_models"
        models.mkdir(parents=True)
        (models / "configs.txt").write_text("fixture")
        model = {kind: f"{kind}.onnx" for kind in ("det", "cls", "rec")}
        model["dict"] = "dictionary.txt"
        for filename in model.values():
            (models / filename).write_text("fixture")
        (models / "test_images").mkdir()
        (models / "test_images/en-us.png").write_bytes(b"fixture")
        (repo / "resource/static.json").write_text(json.dumps({"ocr_model_name": {"en-us": model}}))
        (repo / "resource/global_setting.json").write_text(json.dumps({"ocr": {"server": {"host": "127.0.0.1", "port": 1145}}}))
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "OCR fixture")
        return repo

    def test_ocr_first_install_includes_libraries_resources_and_executable(self):
        repo = self.make_ocr_repository()
        container.prepare_ocr(self.app, repo.as_uri(), "linux-x64")
        installed = self.app / container.OCR_DIRECTORY
        self.assertEqual(container.missing_ocr_files(installed), [])
        self.assertTrue((installed / "BAAS_ocr_server").stat().st_mode & 0o111)
        self.assertTrue((installed / "config/global_setting.json").is_file())
        self.assertFalse((installed / ".git").exists())

    def test_ocr_install_preserves_configuration_output_and_external_symlink_target(self):
        repo = self.make_ocr_repository()
        installed = self.app / container.OCR_DIRECTORY
        (installed / "config").mkdir(parents=True)
        (installed / "config/global_setting.json").write_text("custom settings")
        (installed / "output").mkdir()
        (installed / "output/session.log").write_text("old OCR output")
        external = self.root / "old-library"
        external.write_text("external library")
        (installed / "libBAAS_ipc.so").symlink_to(external)
        container.prepare_ocr(self.app, repo.as_uri(), "linux-x64")
        self.assertEqual((installed / "config/global_setting.json").read_text(), "custom settings")
        self.assertEqual((installed / "output/session.log").read_text(), "old OCR output")
        self.assertEqual(external.read_text(), "external library")
        self.assertFalse((installed / "libBAAS_ipc.so").is_symlink())

    def test_complete_ocr_is_preserved_without_network_even_when_updates_enabled(self):
        repo = self.make_ocr_repository()
        installed = self.app / container.OCR_DIRECTORY
        shutil.copytree(repo, installed)
        (installed / "BAAS_ocr_server").chmod(0o755)
        self.setup_config("[general]\nno_update = false\n")
        before = (installed / "BAAS_ocr_server").read_bytes()
        with patch.object(container.subprocess, "run") as run:
            container.prepare_ocr(self.app, "unused", "linux-x64")
            run.assert_not_called()
        self.assertEqual((installed / "BAAS_ocr_server").read_bytes(), before)
        self.setup_config("[general]\nno_update = true\n")
        with patch.object(container.subprocess, "run") as run:
            container.prepare_ocr(self.app, "unused", "linux-x64")
            run.assert_not_called()

    def test_no_update_missing_ocr_never_downloads(self):
        self.setup_config("[general]\nno_update = true\n")
        with patch.object(container.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Preinstall the complete OCR package"):
                container.prepare_ocr(self.app, "unused", "linux-x64")
            run.assert_not_called()
        self.assertFalse((self.app / container.OCR_DIRECTORY).exists())

    def test_incomplete_ocr_checkout_fails_before_existing_files_change(self):
        repo = self.make_ocr_repository()
        (repo / "resource/ocr_models/rec.onnx").unlink()
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Incomplete OCR fixture")
        installed = self.app / container.OCR_DIRECTORY
        (installed / "config").mkdir(parents=True)
        (installed / "config/global_setting.json").write_text("preserve")
        (installed / "BAAS_ocr_server").write_text("partial installation")
        with self.assertRaisesRegex(RuntimeError, "OCR prebuild is incomplete"):
            container.prepare_ocr(self.app, repo.as_uri(), "linux-x64")
        self.assertEqual((installed / "BAAS_ocr_server").read_text(), "partial installation")
        self.assertEqual((installed / "config/global_setting.json").read_text(), "preserve")

    def test_main_prepares_ocr_with_explicit_environment_overrides(self):
        with patch.object(container, "prepare_service"), \
             patch.object(container, "prepare_ocr") as prepare, \
             patch.object(container, "serve", return_value=0), \
             patch.dict(container.os.environ, {"BAAS_OCR_REPO_URL": "file:///custom-ocr", "BAAS_OCR_BRANCH": "custom-linux"}):
            self.assertEqual(container.main(["service-repository"]), 0)
            prepare.assert_called_once_with(Path("/app"), "file:///custom-ocr", "custom-linux")

    def test_toml_comments_and_both_supported_table_spellings(self):
        for table in ("General", "general"):
            with self.subTest(table=table):
                self.setup_config(f"[{table}] # local settings\nno_update = true # keep version\n")
                self.assertTrue(container.no_update_enabled(self.app))

    def test_no_update_defaults_false(self):
        self.assertFalse(container.no_update_enabled(self.app))
        self.setup_config("[general]\nchannel = 'dev'\n")
        self.assertFalse(container.no_update_enabled(self.app))

    def test_invalid_config_never_invokes_git(self):
        for text in (
            "[general\nno_update = false\n",
            "[general]\nno_update = 'false'\n",
            "general = true\n",
            "[General]\nno_update = 'true'\n",
            "[general]\nno_update = 'false'\n[General]\nno_update = true\n",
        ):
            with self.subTest(text=text), patch.object(container.subprocess, "run") as run:
                self.setup_config(text)
                with self.assertRaises(RuntimeError):
                    container.prepare_service(self.app, "unused", "master")
                run.assert_not_called()

    def test_modern_flag_takes_precedence_when_both_tables_exist(self):
        for modern, legacy in ((True, False), (False, True)):
            with self.subTest(modern=modern, legacy=legacy):
                self.setup_config(
                    f"[general]\nno_update = {str(modern).lower()}\n"
                    f"[General]\nno_update = {str(legacy).lower()}\n"
                )
                self.assertIs(container.no_update_enabled(self.app), modern)

    def test_missing_modern_flag_falls_back_to_legacy(self):
        self.setup_config("[general]\nchannel = 'dev'\n[General]\nno_update = true # generated\n")
        self.assertTrue(container.no_update_enabled(self.app))

    def test_restart_accepts_legacy_table_added_after_first_install(self):
        repo = self.make_repository()
        (repo / "setup.toml").write_text("[general]\nno_update = false\n")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Modern checkout settings")
        container.prepare_service(self.app, repo.as_uri(), "master")
        # The backend's installer appends its legacy table during startup.
        with (self.app / "setup.toml").open("a") as config_file:
            config_file.write("\n[General]\nno_update = true\n")
        generated = (self.app / "setup.toml").read_bytes()
        container.prepare_service(self.app, None, "master")
        self.assertEqual((self.app / "setup.toml").read_bytes(), generated)
        self.assertFalse(container.no_update_enabled(self.app))

    def test_no_update_runs_existing_service_without_git_or_url(self):
        self.setup_config("[general]\nno_update = true # preserve installed files\n")
        (self.app / "main.service.py").write_text("# installed")
        with patch.object(container.subprocess, "run") as run:
            container.prepare_service(self.app, None, "master")
            run.assert_not_called()

    def test_no_update_missing_service_fails_without_clone(self):
        self.setup_config("[general]\nno_update = true\n")
        with patch.object(container.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "already installed service"):
                container.prepare_service(self.app, "unused", "master")
            run.assert_not_called()

    def test_first_clone_preserves_seeded_setup_and_profile_files(self):
        repo = self.make_repository()
        (repo / "setup.toml").write_text("[general]\nno_update = false\n")
        (repo / "config").mkdir()
        (repo / "config/local.json").write_text("source default")
        (repo / "config/new.json").write_text("new default")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Add defaults")
        seed = "[general]\nno_update = false # retained comment\n"
        self.setup_config(seed)
        (self.app / "config").mkdir()
        (self.app / "config/local.json").write_text("user profile")
        container.prepare_service(self.app, repo.as_uri(), "master")
        self.assertEqual((self.app / "setup.toml").read_text(), seed)
        self.assertEqual((self.app / "config/local.json").read_text(), "user profile")
        self.assertEqual((self.app / "config/new.json").read_text(), "new default")
        self.assertTrue((self.app / ".git").is_dir())

    def test_bad_repository_does_not_modify_seeded_volume(self):
        repo = self.make_repository(service=False)
        self.setup_config("[general]\nno_update = false\n")
        before = (self.app / "setup.toml").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "main.service.py"):
            container.prepare_service(self.app, repo.as_uri(), "master")
        self.assertEqual((self.app / "setup.toml").read_bytes(), before)
        self.assertFalse((self.app / ".git").exists())

    def test_update_fast_forwards_without_changing_local_profiles(self):
        repo = self.make_repository()
        container.prepare_service(self.app, repo.as_uri(), "master")
        (self.app / "config").mkdir()
        (self.app / "config/profile.json").write_text("user state")
        (repo / "main.service.py").write_text("# Updated fixture; never executed.\n")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Update fixture")
        container.prepare_service(self.app, None, "master")
        self.assertEqual(self.git(self.app, "rev-parse", "HEAD"), self.git(repo, "rev-parse", "HEAD"))
        self.assertEqual((self.app / "config/profile.json").read_text(), "user state")

    def test_diverged_update_fails_without_resetting_local_work(self):
        repo = self.make_repository()
        container.prepare_service(self.app, repo.as_uri(), "master")
        (self.app / "local.txt").write_text("local edit")
        self.git(self.app, "add", ".")
        self.git(self.app, "commit", "-m", "Local commit")
        head = self.git(self.app, "rev-parse", "HEAD")
        (repo / "remote.txt").write_text("remote edit")
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "Remote commit")
        with self.assertRaises(subprocess.CalledProcessError):
            container.prepare_service(self.app, None, "master")
        self.assertEqual(self.git(self.app, "rev-parse", "HEAD"), head)
        self.assertEqual((self.app / "local.txt").read_text(), "local edit")

    def test_copy_does_not_follow_existing_symlink(self):
        source = self.root / "seed"
        source.mkdir()
        (source / "config").mkdir()
        (source / "config/profile.json").write_text("source")
        external = self.root / "external"
        external.mkdir()
        (external / "profile.json").write_text("preserve")
        (self.app / "config").symlink_to(external, target_is_directory=True)
        container.copy_missing(source, self.app)
        self.assertEqual((external / "profile.json").read_text(), "preserve")

    def test_child_exit_stops_sibling_and_reports_failure(self):
        nginx = MagicMock(pid=100)
        nginx.poll.return_value = None
        backend = MagicMock(pid=101)
        backend.poll.return_value = 7
        with patch.object(container.subprocess, "run"), \
             patch.object(container.subprocess, "Popen", side_effect=[nginx, backend]) as spawn, \
             patch.object(container.signal, "signal"), \
             patch.object(container, "stop_processes") as stop:
            self.assertEqual(container.serve(self.app), 7)
            stop.assert_called_once_with([("nginx", nginx), ("backend", backend)])
            self.assertIn("127.0.0.1", spawn.call_args_list[1].args[0])
            self.assertEqual(spawn.call_args_list[1].kwargs["env"]["BAAS_SERVICE_OCR_UPDATE_CHECK"], "0")

    def test_sigterm_stops_both_children_cleanly(self):
        handlers = {}
        nginx, backend = MagicMock(pid=100), MagicMock(pid=101)
        nginx.poll.return_value = backend.poll.return_value = None

        def register(number, handler):
            handlers[number] = handler
            return signal.SIG_DFL

        with patch.object(container.subprocess, "run"), \
             patch.object(container.subprocess, "Popen", side_effect=[nginx, backend]), \
             patch.object(container.signal, "signal", side_effect=register), \
             patch.object(container.time, "sleep", side_effect=lambda _: handlers[signal.SIGTERM](signal.SIGTERM, None)), \
             patch.object(container, "stop_processes") as stop:
            self.assertEqual(container.serve(self.app), 0)
            stop.assert_called_once_with([("nginx", nginx), ("backend", backend)])

    def test_shutdown_escalates_only_after_grace_period(self):
        nginx, backend = MagicMock(pid=100), MagicMock(pid=101)
        backend.wait.side_effect = [subprocess.TimeoutExpired("backend", 10), 0]
        with patch.object(container.os, "killpg") as kill:
            container.stop_processes([("nginx", nginx), ("backend", backend)])
        self.assertEqual(kill.call_args_list[0].args, (100, signal.SIGQUIT))
        self.assertEqual(kill.call_args_list[1].args, (101, signal.SIGTERM))
        self.assertEqual(kill.call_args_list[2].args, (101, signal.SIGKILL))

    def test_healthcheck_uses_loopback_without_environment_proxy(self):
        response = MagicMock(status=200)
        response.read.return_value = json.dumps({"ok": True}).encode()
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(container, "build_opener", return_value=opener), \
             patch.object(container, "ProxyHandler") as proxies:
            self.assertEqual(container.healthcheck(), 0)
            proxies.assert_called_once_with({})
            opener.open.assert_called_once_with("http://127.0.0.1:8191/health", timeout=3)

    def test_healthcheck_rejects_spa_html_and_failed_backend(self):
        for payload in (b"<html>SPA fallback</html>", b'{"ok":false}'):
            with self.subTest(payload=payload):
                response = MagicMock(status=200)
                response.read.return_value = payload
                opener = MagicMock()
                opener.open.return_value.__enter__.return_value = response
                with patch.object(container, "build_opener", return_value=opener):
                    self.assertEqual(container.healthcheck(), 1)


if __name__ == "__main__":
    unittest.main()
