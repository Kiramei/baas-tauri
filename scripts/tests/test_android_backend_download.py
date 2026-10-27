"""Interrupted archives must never be installed or mislabeled as another revision."""
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile


BOOTSTRAP = (Path(__file__).resolve().parents[2] /
             "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py")


def load():
    spec = importlib.util.spec_from_file_location("download_test_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive(service=True):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        bundle.writestr("backend/setup.toml", '[general]\ncurrent_baas_sha = ""\n')
        if service:
            bundle.writestr("backend/main.service.py", "print('downloaded')\n")
    return stream.getvalue()


class Interrupted(io.BytesIO):
    def read(self, size=-1):
        if self.tell():
            raise http.client.IncompleteRead(b"last partial bytes")
        return super().read(size)


class BackendDownloadTest(unittest.TestCase):
    def test_interrupted_stream_restarts_empty_and_pins_recorded_revision(self):
        module = load()
        revision = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installed"
            with patch.object(module, "_get_github_branch_sha", return_value=revision), \
                 patch.object(module.urllib.request, "urlopen", side_effect=[Interrupted(b"discard"), io.BytesIO(archive())]) as get, \
                 patch.object(module.time, "sleep") as sleep:
                self.assertEqual(module._download_backend_archive(target, "dev"), revision)
            self.assertEqual((target / "main.service.py").read_text(), "print('downloaded')\n")
            metadata = json.loads((target / "android-backend-source.json").read_text())
            self.assertEqual(metadata["sha"], revision)
            self.assertTrue(metadata["source"].endswith("/zip/" + revision))
            self.assertEqual(get.call_count, 2)
            sleep.assert_called_once_with(1)
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_cleanly_truncated_zip_is_retried_before_any_install(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installed"
            with patch.object(module, "_get_github_branch_sha", return_value=None), \
                 patch.object(module.urllib.request, "urlopen", side_effect=[io.BytesIO(archive()[:-30]), io.BytesIO(archive())]) as get, \
                 patch.object(module.time, "sleep"):
                module._download_backend_archive(target, "dev")
            self.assertTrue((target / "main.service.py").is_file())
            self.assertEqual(get.call_count, 2)

    def test_exhaustion_preserves_network_error_and_leaves_no_partial_install(self):
        module = load()
        error = http.client.IncompleteRead(b"truncated")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installed"
            with patch.object(module, "_get_github_branch_sha", return_value=None), \
                 patch.object(module.urllib.request, "urlopen", side_effect=error) as get, \
                 patch.object(module.time, "sleep"):
                with self.assertRaises(http.client.IncompleteRead) as raised:
                    module._download_backend_archive(target, "dev")
            self.assertIs(raised.exception, error)
            self.assertEqual(get.call_count, 3)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_permanent_http_rejection_is_not_retried(self):
        module = load()
        error = urllib.error.HTTPError("https://example.invalid/", 403, "denied", {}, None)
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(module, "_get_github_branch_sha", return_value=None), \
                 patch.object(module.urllib.request, "urlopen", side_effect=error) as get, \
                 patch.object(module.time, "sleep") as sleep:
                with self.assertRaises(urllib.error.HTTPError):
                    module._download_backend_archive(Path(directory) / "installed", "dev")
            self.assertEqual(get.call_count, 1)
            sleep.assert_not_called()

    def test_valid_archive_without_backend_is_rejected_without_retry(self):
        module = load()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installed"
            with patch.object(module, "_get_github_branch_sha", return_value=None), \
                 patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(archive(False))) as get:
                with self.assertRaisesRegex(RuntimeError, "main.service.py"):
                    module._download_backend_archive(target, "dev")
            self.assertFalse(target.exists())
            self.assertEqual(get.call_count, 1)


if __name__ == "__main__":
    unittest.main()
