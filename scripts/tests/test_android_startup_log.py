"""Startup diagnostics survive rotation across stdout, stderr, and threads."""
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


BOOTSTRAP = (Path(__file__).resolve().parents[2] /
             "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py")


def load():
    spec = importlib.util.spec_from_file_location("startup_log_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StartupLogTest(unittest.TestCase):
    def test_bootstrap_reports_the_installation_failure_after_log_rotation(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            files = Path(directory) / "files"
            files.mkdir()

            def fail_installation(*_args):
                sys.stdout.write("x" * (4 * 1_048_576 + 1))
                sys.stdout.write("download finished\n")
                raise ConnectionError("original installation failure")

            with patch.object(sys, "stdout", io.StringIO()), \
                    patch.object(sys, "stderr", io.StringIO()), \
                    patch.object(module, "_configure_environment"), \
                    patch.object(module, "_ensure_backend_files", side_effect=fail_installation), \
                    patch.object(module, "_run_bootstrap_server"), \
                    patch.object(sys, "path", sys.path[:]):
                try:
                    result = module._start_once(files, files / "baas", 8190)
                    sys.stderr.flush()
                    self.assertEqual(result["error"], "original installation failure")
                    log = (files.parent / "cache/android-startup.log").read_text()
                    self.assertIn("ConnectionError: original installation failure", log)
                finally:
                    sys.stdout.sink.close()

    def test_stderr_retains_the_original_failure_after_stdout_rotates(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "android-startup.log"
            sink = module._StartupLogSink(path, max_bytes=16)
            stdout_original, stderr_original = io.StringIO(), io.StringIO()
            stdout = module._StartupOutput(stdout_original, sink)
            stderr = module._StartupOutput(stderr_original, sink)
            try:
                stdout.write("download progress\n")
                stdout.write("download complete\n")
                self.assertEqual(stderr.write("original failure\n"), 17)
                stdout.flush()
                stderr.flush()
                self.assertEqual(path.read_text(), "original failure\n")
                self.assertEqual(path.with_name(path.name + ".1").read_text(), "download complete\n")
                self.assertEqual(stdout_original.getvalue(), "download progress\ndownload complete\n")
                self.assertEqual(stderr_original.getvalue(), "original failure\n")
            finally:
                sink.close()

    def test_both_streams_count_utf8_bytes_and_share_the_current_file(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "android-startup.log"
            sink = module._StartupLogSink(path, max_bytes=8)
            stdout = module._StartupOutput(io.StringIO(), sink)
            stderr = module._StartupOutput(io.StringIO(), sink)
            try:
                stdout.write("下载")
                stderr.write("完成")
                stdout.write("next\n")
                stderr.write("error\n")
                stderr.flush()
                self.assertEqual(path.with_name(path.name + ".1").read_text(), "下载完成")
                self.assertEqual(path.read_text(), "next\nerror\n")
            finally:
                sink.close()

    def test_concurrent_streams_never_write_to_a_closed_rotated_file(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "android-startup.log"
            sink = module._StartupLogSink(path, max_bytes=64)
            errors = []
            barrier = threading.Barrier(2)

            def write_output(name):
                output = module._StartupOutput(io.StringIO(), sink)
                try:
                    barrier.wait(timeout=2)
                    for index in range(100):
                        output.write("%s %s\n" % (name, index))
                        output.flush()
                except Exception as error:
                    errors.append(error)

            workers = [threading.Thread(target=write_output, args=(name,))
                       for name in ("stdout", "stderr")]
            try:
                for worker in workers:
                    worker.start()
                for worker in workers:
                    worker.join(timeout=5)
                self.assertFalse(any(worker.is_alive() for worker in workers))
                self.assertEqual(errors, [])
                output = module._StartupOutput(io.StringIO(), sink)
                output.write("final failure\n")
                output.flush()
                self.assertIn("final failure\n", path.read_text())
            finally:
                sink.close()

    def test_failed_rotation_does_not_truncate_existing_diagnostics(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "android-startup.log"
            sink = module._StartupLogSink(path, max_bytes=8)
            output = module._StartupOutput(io.StringIO(), sink)
            try:
                output.write("first error\n")
                with patch.object(module.os, "replace", side_effect=OSError("busy")):
                    output.write("second error\n")
                output.flush()
                self.assertEqual(path.read_text(), "first error\nsecond error\n")
            finally:
                sink.close()


if __name__ == "__main__":
    unittest.main()
