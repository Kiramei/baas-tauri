import importlib.util
import io
import json
import os
import re
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
JAVA = ROOT / "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri"
BOOTSTRAP = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py"


def load_bootstrap():
    spec = importlib.util.spec_from_file_location("android_lifecycle_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AndroidBackendLifecycleTest(unittest.TestCase):
    def test_only_foreground_service_calls_python_bootstrap(self):
        callers = [path.name for path in JAVA.glob("*.kt")
                   if re.search(r"BaasBackend\s*\.\s*ensureStarted\s*\(", path.read_text(encoding="utf-8"))]
        self.assertEqual(callers, ["BaasForegroundService.kt"])

    def test_process_guard_precedes_process_local_singleton(self):
        source = (JAVA / "BaasBackend.kt").read_text(encoding="utf-8")
        self.assertIn('processName != "${appContext.packageName}:baas_backend"', source)
        self.assertLess(source.index("Refusing Python bootstrap"), source.index("started.compareAndSet"))
        # A returned Python call may leave the diagnostic HTTP thread alive.
        # Only destroying this process may re-arm the native startup claim.
        self.assertNotRegex(source, r"started\.(?:set|lazySet)\s*\(\s*false\s*\)")
        manifest = (ROOT / "src-tauri/gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertRegex(manifest, r'<service\s+android:name="\.BaasForegroundService"[^>]*android:process=":baas_backend"')

    @contextmanager
    def environment(self):
        bootstrap = load_bootstrap()
        logs = []
        original_open = Path.open

        def tracked_open(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if path.name == "android-startup.log":
                logs.append(stream)
            return stream

        with tempfile.TemporaryDirectory() as directory:
            files = Path(directory) / "files"
            files.mkdir()
            root = files / "baas"
            try:
                with patch.dict(os.environ), patch.object(sys, "path", sys.path[:]), \
                        patch.object(sys, "stdout", io.StringIO()), patch.object(sys, "stderr", io.StringIO()), \
                        patch.object(Path, "open", tracked_open):
                    yield bootstrap, files, root
            finally:
                if bootstrap._BOOTSTRAP_HTTP_SERVER is not None:
                    bootstrap._BOOTSTRAP_HTTP_SERVER.shutdown()
                    bootstrap._BOOTSTRAP_HTTP_SERVER.server_close()
                    bootstrap._BOOTSTRAP_HTTP_THREAD.join(timeout=2)
                for stream in logs:
                    stream.close()

    def test_failed_download_retains_first_diagnostics_and_never_rebinds_on_reconnect(self):
        with self.environment() as (bootstrap, files, root):
            with patch.object(bootstrap, "_ensure_backend_files", side_effect=ConnectionError("first download interrupted")) as install, \
                    patch.object(bootstrap, "_run_bootstrap_server", wraps=bootstrap._run_bootstrap_server) as serve:
                result = bootstrap.start(files, root, 0)
                original_status = (root / bootstrap.STATUS_FILE).read_bytes()
                log_path = files.parent / "cache/android-startup.log"
                original_log = log_path.read_bytes()
                for _ in range(3):
                    self.assertEqual(bootstrap.start(files, root, 0), result)
                install.assert_called_once()
                serve.assert_called_once()
                self.assertFalse(result["ok"])
                self.assertEqual(result["stage"], "failed")
                self.assertEqual(result["error"], "first download interrupted")
                self.assertIn("ConnectionError: first download interrupted", result["traceback"])
                self.assertEqual((root / bootstrap.STATUS_FILE).read_bytes(), original_status)
                self.assertEqual(log_path.read_bytes(), original_log)
                port = bootstrap._BOOTSTRAP_HTTP_SERVER.server_address[1]
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
                self.assertEqual(failure.exception.code, 503)
                self.assertEqual(json.loads(failure.exception.read())["error"], result["error"])
                failure.exception.close()

    def test_concurrent_reconnect_cannot_start_a_second_installation(self):
        with self.environment() as (bootstrap, files, root):
            entered = threading.Event()
            finish = threading.Event()

            def installation(*_args):
                entered.set()
                if not finish.wait(2):
                    raise RuntimeError("test installation did not finish")
                raise ConnectionError("original transfer failed")

            with patch.object(bootstrap, "_ensure_backend_files", side_effect=installation) as install:
                worker = threading.Thread(target=bootstrap.start, args=(files, root, 0))
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    waiting = bootstrap.start(files, root, 0)
                    self.assertFalse(waiting["ok"])
                    self.assertEqual(waiting["stage"], "runtime")
                    install.assert_called_once()
                finally:
                    finish.set()
                    worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(bootstrap.start(files, root, 0)["error"], "original transfer failed")

    def test_diagnostic_bind_failure_is_secondary_to_the_original_installation_error(self):
        with self.environment() as (bootstrap, files, root), socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with patch.object(bootstrap, "_ensure_backend_files", side_effect=ConnectionError("original download failure")):
                status = bootstrap.start(files, root, occupied.getsockname()[1])
            self.assertFalse(status["ok"])
            self.assertEqual(status["error"], "original download failure")
            self.assertIn("ConnectionError: original download failure", status["traceback"])
            self.assertTrue(status["diagnosticError"])
            self.assertIn("server_bind", status["diagnosticTraceback"])
            self.assertIn(status["diagnosticError"], status["diagnosticTraceback"])
            self.assertEqual(json.loads((root / bootstrap.STATUS_FILE).read_text(encoding="utf-8")), status)
            self.assertEqual(bootstrap.start(files, root, occupied.getsockname()[1]), status)

    def test_service_initialization_failure_clears_the_installed_runtime_success_flag(self):
        with self.environment() as (bootstrap, files, root):
            with patch.object(bootstrap, "_ensure_backend_files", return_value=False), \
                    patch.object(bootstrap, "_activate_bundled_service_transport"), \
                    patch.object(bootstrap, "_run_baas_service", side_effect=ImportError("missing service dependency")):
                status = bootstrap.start(files, root, 0)
            self.assertFalse(status["ok"])
            self.assertEqual(status["stage"], "failed")
            self.assertEqual(status["error"], "missing service dependency")

    def test_returned_service_is_reported_failed_rather_than_ready(self):
        with self.environment() as (bootstrap, files, root):
            with patch.object(bootstrap, "_ensure_backend_files", return_value=False), \
                    patch.object(bootstrap, "_activate_bundled_service_transport"), \
                    patch.object(bootstrap, "_run_baas_service", return_value=None):
                status = bootstrap.start(files, root, 0)
            self.assertFalse(status["ok"])
            self.assertIn("local backend service stopped", status["error"])

    def test_diagnostic_server_reuses_only_its_own_root_and_allows_explicit_process_restart(self):
        with self.environment() as (bootstrap, files, root):
            with patch.object(bootstrap, "_ensure_backend_files", side_effect=ConnectionError("original failure")):
                bootstrap.start(files, root, 0)
            server = bootstrap._BOOTSTRAP_HTTP_SERVER
            port = server.server_address[1]
            self.assertIs(bootstrap._run_bootstrap_server(port, root, {}), server)
            with self.assertRaisesRegex(RuntimeError, "different Android bootstrap"):
                bootstrap._run_bootstrap_server(port, root / "other", {})
            exited = threading.Event()
            with patch.object(bootstrap, "_exit_backend_process", side_effect=exited.set) as exit_process:
                request = urllib.request.Request(f"http://127.0.0.1:{port}/android/bootstrap-restart", data=b"", method="POST")
                with urllib.request.urlopen(request, timeout=1) as response:
                    self.assertEqual(json.load(response), {"ok": True, "restartScheduled": True})
                self.assertTrue(exited.wait(1))
                bootstrap.restart()
                exit_process.assert_called_once()
            # A new process imports a new module and can claim initialization.
            fresh_process = load_bootstrap()
            with patch.object(fresh_process, "_start_once", return_value={"ok": False, "stage": "starting"}) as start:
                fresh_process.start(files, root, port)
                start.assert_called_once_with(files, root, port, None)


if __name__ == "__main__":
    unittest.main()
