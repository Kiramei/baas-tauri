"""First-run channel choice, mirror fallback, and safe extraction contracts."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


BOOTSTRAP = (Path(__file__).resolve().parents[2] /
             "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py")


def load():
    spec = importlib.util.spec_from_file_location("setup_test_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive(entries=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        for name, body in (entries or {"backend/main.service.py": "print('ok')\n"}).items():
            bundle.writestr(name, body)
    return stream.getvalue()


class ChannelSelectionTest(unittest.TestCase):
    def test_first_install_waits_for_the_channel_written_by_the_app(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = {}
            written = []

            def choose(_seconds):
                written.append(1)
                (root / module.CHANNEL_SELECTION_FILE).write_text(
                    json.dumps({"channel": "dev"}), encoding="utf-8"
                )

            with patch.object(module, "time", wraps=module.time) as clock:
                clock.sleep.side_effect = choose
                channel = module._await_channel_selection(root, status)

            self.assertEqual(channel, "dev")
            self.assertEqual(written, [1], "the wait must end as soon as a choice exists")
            self.assertEqual(status["channel"], "dev")
            self.assertFalse(status["awaitingChannel"])
            self.assertEqual(status["stage"], "runtime")
            setup = (root / "setup.toml").read_text(encoding="utf-8")
            self.assertIn('channel = "dev"', setup)

    def test_waiting_state_is_published_before_polling(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = {}
            snapshots = []
            real_write = module._write_status

            def spy(target, document):
                snapshots.append(json.loads(json.dumps(document)))
                real_write(target, document)

            with patch.object(module, "_write_status", side_effect=spy), \
                 patch.object(module.time, "sleep", side_effect=lambda _s: (_ for _ in ()).throw(KeyboardInterrupt())):
                with self.assertRaises(KeyboardInterrupt):
                    module._await_channel_selection(root, status)

            first = snapshots[0]
            self.assertEqual(first["stage"], "channel")
            self.assertTrue(first["awaitingChannel"])
            self.assertEqual(first["channelOptions"], [
                {"id": "stable", "available": False},
                {"id": "dev", "available": True},
            ])
            self.assertIn("steps", first)
            channel_step = next(step for step in first["steps"] if step["id"] == "channel")
            self.assertEqual(channel_step["state"], "running")

    def test_a_missing_choice_times_out_to_the_saved_channel_and_says_so(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "setup.toml").write_text('[general]\nchannel = "dev"\n', encoding="utf-8")
            status = {}
            with patch.object(module, "CHANNEL_WAIT_SECONDS", 0), \
                 patch.object(module.time, "monotonic", side_effect=[0, 1, 2]):
                channel = module._await_channel_selection(root, status)
            self.assertEqual(channel, "dev")
            self.assertTrue(status["channelFallback"])
            self.assertFalse(status["awaitingChannel"])
            self.assertEqual(status["stage"], "runtime")

    def test_download_leaves_channel_stage_for_every_selection_path(self):
        for channel in ("dev",):
            for selection in ("preselected", "waiting", "fallback"):
                with self.subTest(channel=channel, selection=selection), \
                        tempfile.TemporaryDirectory() as directory:
                    module = load()
                    root = Path(directory)
                    status = {"stage": "runtime"}

                    def choose(_seconds=0):
                        (root / module.CHANNEL_SELECTION_FILE).write_text(
                            json.dumps({"channel": channel}), encoding="utf-8"
                        )

                    if selection == "preselected":
                        choose()
                    elif selection == "fallback":
                        (root / "setup.toml").write_text(
                            '[general]\nchannel = "%s"\n' % channel, encoding="utf-8"
                        )

                    def download(root, status, selected):
                        self.assertEqual(selected, channel)
                        published = json.loads((root / module.STATUS_FILE).read_text())
                        self.assertFalse(published["awaitingChannel"])
                        self.assertEqual(published["stage"], "runtime")
                        self.assertEqual(published["currentStep"], "download")
                        self.assertEqual(published["channel"], channel)
                        raise RuntimeError("download reached")

                    with patch.object(module.time, "sleep", side_effect=choose), \
                            patch.object(module, "CHANNEL_WAIT_SECONDS", 0 if selection == "fallback" else 900), \
                            patch.object(module, "_require_free_space"), \
                            patch.object(module, "_await_git2_backend_install", side_effect=download) as transfer:
                        with self.assertRaisesRegex(RuntimeError, "download reached"):
                            module._ensure_backend_files(root, status)
                    transfer.assert_called_once()

    def test_stable_first_install_fails_before_downloading_or_rewriting_setup(self):
        for selection in ("preselected", "waiting", "fallback"):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as directory:
                module = load()
                root = Path(directory)
                setup = '[general]\nchannel = "stable"\n'
                (root / "setup.toml").write_text(setup, encoding="utf-8")
                status = {"steps": module._initial_steps()}
                status["steps"][0]["state"] = "running"

                def choose(_seconds=0):
                    (root / module.CHANNEL_SELECTION_FILE).write_text(
                        json.dumps({"channel": "stable"}), encoding="utf-8"
                    )

                if selection == "preselected":
                    choose()
                with patch.object(module.time, "sleep", side_effect=choose), \
                        patch.object(module, "CHANNEL_WAIT_SECONDS", 0 if selection == "fallback" else 900), \
                        patch.object(module, "_download_backend_archive") as transfer, \
                        patch.object(module, "_install_bundled_backend_archive") as bundle, \
                        patch.object(module, "_await_git2_backend_install") as native:
                    with self.assertRaisesRegex(RuntimeError, "Stable channel lacks the Android service"):
                        module._ensure_backend_files(root, status)
                transfer.assert_not_called()
                bundle.assert_not_called()
                native.assert_not_called()
                self.assertEqual((root / "setup.toml").read_text(), setup)
                published = json.loads((root / module.STATUS_FILE).read_text())
                steps = {step["id"]: step for step in published["steps"]}
                self.assertEqual(steps["storage"]["state"], "done")
                self.assertEqual(steps["channel"]["state"], "failed")
                self.assertIn("Stable channel lacks the Android service", steps["channel"]["detail"])
                self.assertEqual(published["currentStep"], "channel")

    def test_new_android_setup_defaults_to_dev_without_changing_stable_repository(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(module._setup_channel(root), "dev")
            self.assertIn('channel = "dev"', (root / "setup.toml").read_text())
            self.assertIn('git_backend = "git2"', (root / "setup.toml").read_text())
        stable = module.REPOSITORIES["stable"]
        self.assertEqual((stable["owner"], stable["repo"]),
                         ("pur1fying", "blue_archive_auto_script"))

    def test_existing_backend_skips_the_picker_entirely(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "main.service.py").write_text("print('installed')\n", encoding="utf-8")
            (root / "setup.toml").write_text('[general]\nchannel = "stable"\n', encoding="utf-8")
            status = {}
            with patch.object(module, "_ensure_android_support_files"), \
                 patch.object(module, "_start_local_atx_agent_async_if_enabled"), \
                 patch.object(module, "_await_channel_selection") as wait:
                installed = module._ensure_backend_files(root, status)
            wait.assert_not_called()
            self.assertFalse(installed)
            self.assertEqual(status["channel"], "stable")
            self.assertEqual((root / "setup.toml").read_text(), '[general]\nchannel = "stable"\n')


class ArchiveSafetyTest(unittest.TestCase):
    def test_archive_sources_put_direct_host_first_and_include_cn_mirrors(self):
        module = load()
        sources = module._archive_sources(module.REPOSITORIES["dev"], "abc123")
        labels = [label for label, _ in sources]
        self.assertEqual(labels[0], "codeload.github.com")
        self.assertIn("gitee", labels)
        self.assertIn("cnb", labels)
        self.assertIn("gitcode", labels)
        self.assertTrue(sources[0][1].endswith("/zip/abc123"), "the pinned revision must be kept")

    def test_html_error_page_is_rejected_not_installed(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installed"
            with patch.object(module, "_get_github_branch_sha", return_value=None), \
                 patch.object(module, "_archive_sources", return_value=[("mirror", "https://example.invalid/a.zip")]), \
                 patch.object(module.urllib.request, "urlopen",
                              return_value=io.BytesIO(b"<!DOCTYPE html><html>rate limited</html>")):
                with self.assertRaisesRegex(RuntimeError, "not a ZIP archive"):
                    module._download_backend_archive(target, "dev")
            self.assertFalse(target.exists())

    def test_zip_slip_member_is_rejected(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "dest"
            destination.mkdir()
            with zipfile.ZipFile(io.BytesIO(archive({"../../escaped.py": "x"}))) as bundle:
                with self.assertRaises(module._UnusableArchive):
                    module._safe_extract(bundle, destination)
            self.assertFalse((Path(directory) / "escaped.py").exists())

    def test_symbolic_link_member_is_rejected(self):
        module = load()
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as bundle:
            info = zipfile.ZipInfo("backend/link")
            info.external_attr = (0o120777 & 0xFFFF) << 16
            bundle.writestr(info, "target")
        stream.seek(0)
        with tempfile.TemporaryDirectory() as directory:
            with zipfile.ZipFile(stream) as bundle:
                with self.assertRaises(module._UnusableArchive):
                    module._safe_extract(bundle, Path(directory))

    def test_insufficient_storage_fails_before_downloading(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module.shutil, "disk_usage") as usage:
                usage.return_value = type("Usage", (), {"free": module.MIN_FREE_BYTES - 1})()
                with self.assertRaisesRegex(RuntimeError, "Not enough free storage"):
                    module._require_free_space(Path(directory))


if __name__ == "__main__":
    unittest.main()
