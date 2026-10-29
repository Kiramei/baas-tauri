"""The Python bootstrap waits for the native git2 installer, never an archive fallback."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import sys
from unittest.mock import patch


BOOTSTRAP = (Path(__file__).resolve().parents[2] /
             "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py")


def load():
    spec = importlib.util.spec_from_file_location("git2_bridge_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_document(path, condition=lambda _value: True):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            value = json.loads(path.read_text())
            if condition(value):
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.002)
    raise AssertionError("Expected protocol document was not published: " + str(path))


def atomic_document(path, payload):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload), encoding="utf-8")
    temporary.replace(path)


class Git2InstallBridgeTest(unittest.TestCase):
    def test_a_patch_failure_is_reported_as_adaptation_without_publishing_the_checkout(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            files = Path(directory) / "files"
            root = files / "baas"
            root.mkdir(parents=True)

            def native_checkout(_root, _status, _channel):
                checkout = root / ".baas-next"
                checkout.mkdir()
                (checkout / "main.service.py").write_text("print('checked out')\n")
                return "a" * 40

            def incompatible_patch(_checkout):
                published = json.loads((root / module.STATUS_FILE).read_text())
                self.assertEqual(published["currentStep"], "adapt")
                self.assertEqual(next(step for step in published["steps"] if step["id"] == "adapt")["state"], "running")
                raise RuntimeError("Unsupported Android backend revision: compatibility boundary missing")

            with patch.object(sys, "stdout", io.StringIO()), \
                    patch.object(sys, "stderr", io.StringIO()), \
                    patch.object(sys, "path", sys.path[:]), \
                    patch.object(module, "_configure_environment"), \
                    patch.object(module, "_await_channel_selection", return_value="dev"), \
                    patch.object(module, "_await_git2_backend_install", side_effect=native_checkout), \
                    patch.object(module, "_ensure_android_support_files", side_effect=incompatible_patch), \
                    patch.object(module, "_run_bootstrap_server"):
                try:
                    result = module._start_once(files, root, 8190)
                finally:
                    sys.stdout.sink.close()
            self.assertEqual(result["stage"], "failed")
            steps = {step["id"]: step for step in result["steps"]}
            self.assertEqual(steps["adapt"]["state"], "failed")
            self.assertEqual(steps["extract"]["state"], "done")
            self.assertIn("Unsupported Android backend revision", result["error"])
            self.assertFalse((root / "main.service.py").exists())
            self.assertTrue((root / ".baas-next/main.service.py").exists())

    def test_status_publication_is_complete_during_concurrent_writes_and_reads(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = "初始" * 32768
            module._write_status(root, {"writer": -1, "sequence": -1, "payload": payload})
            stopped = threading.Event()
            started = threading.Event()
            failures = []
            observed = []

            def read_status():
                started.set()
                while not stopped.is_set():
                    try:
                        document = json.loads((root / module.STATUS_FILE).read_text())
                        marker = "初始" if document["writer"] == -1 else str(document["writer"])
                        self.assertEqual(document["payload"], marker * 32768)
                        observed.append((document["writer"], document["sequence"]))
                    except BaseException as error:
                        failures.append(error)
                        break

            def write_status(writer):
                try:
                    for sequence in range(30):
                        module._write_status(root, {"writer": writer, "sequence": sequence,
                                                    "payload": str(writer) * 32768})
                except BaseException as error:
                    failures.append(error)

            reader = threading.Thread(target=read_status, daemon=True)
            workers = [threading.Thread(target=write_status, args=(writer,)) for writer in range(4)]
            reader.start()
            self.assertTrue(started.wait(timeout=1))
            try:
                for worker in workers:
                    worker.start()
                for worker in workers:
                    worker.join(timeout=5)
                self.assertFalse(any(worker.is_alive() for worker in workers))
            finally:
                stopped.set()
                reader.join(timeout=2)
            self.assertEqual(failures, [])
            self.assertTrue(observed)
            self.assertEqual(json.loads((root / module.STATUS_FILE).read_text())["sequence"], 29)
            self.assertFalse((root / (module.STATUS_FILE + ".tmp")).exists())

    def test_native_install_publishes_progress_and_preserves_config_with_new_git_metadata(self):
        module = load()
        sha = "a" * 40
        source = "https://mirror.example/baas-dev.git"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / module.CHANNEL_SELECTION_FILE).write_text('{"channel":"dev"}')
            (root / "config").mkdir()
            (root / "config/keep.json").write_text("saved profile")
            (root / ".git").mkdir()
            (root / ".git/HEAD").write_text("incomplete old metadata")
            atomic_document(root / module.GIT_INSTALL_RESULT_FILE,
                            {"requestId": "stale", "ok": True, "sha": "b" * 40})
            worker_errors = []

            def native_fixture():
                try:
                    request = wait_document(root / module.GIT_INSTALL_REQUEST_FILE)
                    self.assertEqual(request["version"], 1)
                    self.assertEqual(request["channel"], "dev")
                    request_id = request["requestId"]
                    self.assertEqual(len(request_id), 32)
                    log = root / ("android-git-install-%s.log" % request_id)
                    log.write_text("[probe] mirror 4.5 MiB/s, 38ms\n", encoding="utf-8")
                    progress = {"requestId": request_id, "step": "download", "phase": "probe",
                                "detail": "Measuring candidate git mirrors", "source": source,
                                "metrics": {"bytesPerSecond": 4718592}}
                    atomic_document(root / module.GIT_INSTALL_PROGRESS_FILE, progress)
                    published = wait_document(root / module.STATUS_FILE,
                                              lambda value: value.get("installPhase") == "probe")
                    storage = next(step for step in published["steps"] if step["id"] == "storage")
                    self.assertEqual(storage["state"], "done")
                    target = root / ".baas-next"
                    target.mkdir()
                    (target / ".git").mkdir()
                    (target / ".git/HEAD").write_text("new git checkout")
                    (target / "main.service.py").write_text("print('native checkout')\n")
                    progress.update(step="extract", phase="checkout", detail="Checking out files: 100%")
                    atomic_document(root / module.GIT_INSTALL_PROGRESS_FILE, progress)
                    wait_document(root / module.STATUS_FILE,
                                  lambda value: value.get("currentStep") == "extract")
                    with log.open("a", encoding="utf-8") as output:
                        output.write("[git2] 已完成 checkout\n")
                    atomic_document(root / module.GIT_INSTALL_RESULT_FILE,
                                    {"requestId": request_id, "ok": True, "sha": sha, "source": source})
                except BaseException as error:
                    worker_errors.append(error)

            worker = threading.Thread(target=native_fixture, daemon=True)
            output = io.StringIO()
            worker.start()
            status = {"stage": "runtime"}
            with contextlib.redirect_stdout(output), \
                    patch.object(module, "GIT_INSTALL_POLL_SECONDS", 0.002), \
                    patch.object(module, "GIT_INSTALL_WAIT_SECONDS", 4), \
                    patch.object(module, "_ensure_android_support_files"), \
                    patch.object(module, "_start_local_atx_agent_async_if_enabled"), \
                    patch.object(module, "_download_backend_archive") as archive_download, \
                    patch.object(module, "_install_bundled_backend_archive") as bundled_archive:
                installed = module._ensure_backend_files(root, status)
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(worker_errors, [])
            self.assertTrue(installed)
            archive_download.assert_not_called()
            bundled_archive.assert_not_called()
            self.assertEqual((root / "config/keep.json").read_text(), "saved profile")
            self.assertEqual((root / ".git/HEAD").read_text(), "new git checkout")
            self.assertIn("native checkout", (root / "main.service.py").read_text())
            self.assertIn(sha, (root / "setup.toml").read_text())
            self.assertFalse((root / module.GIT_INSTALL_REQUEST_FILE).exists())
            self.assertEqual(status["downloadSource"], source)
            self.assertEqual(status["gitInstallMetrics"]["bytesPerSecond"], 4718592)
            self.assertIn("mirror 4.5 MiB/s", output.getvalue())
            self.assertIn("已完成 checkout", output.getvalue())

    def test_native_failure_keeps_the_git_error_and_does_not_fall_back_to_an_archive(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            errors = []

            def fail_native():
                try:
                    request = wait_document(root / module.GIT_INSTALL_REQUEST_FILE)
                    result = {"requestId": request["requestId"], "ok": False,
                              "error": "All git mirrors failed: HTTP 403; TLS handshake timed out"}
                    atomic_document(root / module.GIT_INSTALL_RESULT_FILE, result)
                except BaseException as error:
                    errors.append(error)

            worker = threading.Thread(target=fail_native, daemon=True)
            worker.start()
            with patch.object(module, "GIT_INSTALL_POLL_SECONDS", 0.002), \
                    patch.object(module, "GIT_INSTALL_WAIT_SECONDS", 4), \
                    patch.object(module, "_download_backend_archive") as archive:
                with self.assertRaisesRegex(RuntimeError, "HTTP 403; TLS handshake timed out"):
                    module._await_git2_backend_install(root, {}, "dev")
            worker.join(timeout=3)
            self.assertEqual(errors, [])
            archive.assert_not_called()
            self.assertFalse((root / module.GIT_INSTALL_REQUEST_FILE).exists())
            self.assertFalse((root / "main.service.py").exists())

    def test_missing_native_worker_times_out_with_a_phase_and_removes_its_request(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(module, "GIT_INSTALL_WAIT_SECONDS", 0):
                with self.assertRaisesRegex(RuntimeError, "native-start.*did not acknowledge"):
                    module._await_git2_backend_install(root, {}, "dev")
            self.assertFalse((root / module.GIT_INSTALL_REQUEST_FILE).exists())

    def test_a_matching_success_without_a_service_checkout_is_rejected(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            errors = []

            def incomplete_native():
                try:
                    request = wait_document(root / module.GIT_INSTALL_REQUEST_FILE)
                    atomic_document(root / module.GIT_INSTALL_RESULT_FILE,
                                    {"requestId": request["requestId"], "ok": True, "sha": "a" * 40})
                except BaseException as error:
                    errors.append(error)

            worker = threading.Thread(target=incomplete_native, daemon=True)
            worker.start()
            with patch.object(module, "GIT_INSTALL_POLL_SECONDS", 0.002), \
                    patch.object(module, "GIT_INSTALL_WAIT_SECONDS", 4):
                with self.assertRaisesRegex(RuntimeError, "missing main.service.py"):
                    module._await_git2_backend_install(root, {}, "dev")
            worker.join(timeout=3)
            self.assertEqual(errors, [])

    def test_channel_confirmation_heartbeat_does_not_pretend_to_download(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = io.StringIO()
            times = iter([0, 0, 5, 5, 6])
            sleeps = []

            def confirm(_delay):
                sleeps.append(1)
                (root / module.CHANNEL_SELECTION_FILE).write_text('{"channel":"dev"}')

            with contextlib.redirect_stdout(output), \
                    patch.object(module.time, "monotonic", side_effect=lambda: next(times)), \
                    patch.object(module.time, "sleep", side_effect=confirm):
                selected = module._await_channel_selection(root, {})
            self.assertEqual(selected, "dev")
            self.assertEqual(sleeps, [1])
            self.assertIn("5s elapsed", output.getvalue())
            self.assertIn("no download has started", output.getvalue())


if __name__ == "__main__":
    unittest.main()
