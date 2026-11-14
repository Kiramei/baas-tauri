"""Exercise cache recovery against real temporary files without loading native code."""
import importlib.util
import json
import os
import shutil
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend/ocr_runtime_cache.py"
spec = importlib.util.spec_from_file_location("ocr_runtime_cache_test", MODULE)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def elf(machine=183, content=b"payload"):
    header = bytearray(20)
    header[:4] = b"\x7fELF"
    header[4:6] = b"\x02\x01"
    header[18:20] = machine.to_bytes(2, "little")
    return bytes(header) + content


def payload(root, sha="sha-a", machine=183, abi="arm64-v8a"):
    root = Path(root)
    library = root / "lib" / abi
    library.mkdir(parents=True, exist_ok=True)
    for name in ("libBAAS_ocr_server.so", "libonnxruntime.so", "libopencv_java4.so", "libc++_shared.so"):
        (library / name).write_bytes(elf(machine, sha.encode() + b"\0libc++_shared.so"))
    resource = root / "resource"
    models = resource / "ocr_models"
    (models / "test_images").mkdir(parents=True, exist_ok=True)
    (resource / "global_setting.json").write_text('{"ocr": {"server": {"host": "127.0.0.1", "port": 1145}}}')
    (resource / "static.json").write_text(json.dumps({"ocr_model_name": {
        language: {"det": "model.onnx", "cls": "model.onnx", "rec": "model.onnx", "dict": "dict.txt"}
        for language in ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr")
    }}))
    (models / "configs.txt").write_text("English\nmodel.onnx\ndict.txt\n")
    (models / "model.onnx").write_bytes(b"model bytes")
    (models / "dict.txt").write_text("characters")
    for lang in ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr"):
        (models / "test_images" / (lang + ".png")).write_bytes(b"test-image-placeholder")
    (root / ".baas-ocr-prebuild-sha").write_text(sha)


class CacheRepair(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = self.root / "baas"
        self.service = self.backend / "service"
        self.service.mkdir(parents=True)
        self.source = self.backend / "core/ocr/baas_ocr_client/bin-android/android-arm64-v8a"
        self.internal_files = self.root / "internal"
        self.internal = self.internal_files / "ocr-runtime/android-arm64-v8a"
        self.native = self.root / "apk-libs"
        self.native.mkdir()
        (self.native / "libc++_shared.so").write_bytes(elf(content=b"apk-a\0libc++_shared.so"))
        environment = patch.dict(os.environ, {
            "BAAS_ANDROID": "1", "BAAS_ANDROID_INTERNAL_FILES_DIR": str(self.internal_files),
            "BAAS_ANDROID_NATIVE_LIBRARY_DIR": str(self.native),
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.downloads = 0
        self.remote = "sha-a"
        self.fail_download = False
        installer = types.SimpleNamespace(
            TARGET_BRANCH="android-arm64-v8a", SERVER_BIN_DIR=str(self.source),
            ANDROID_VERSION_FILE=str(self.source / ".baas-ocr-prebuild-sha"),
            _get_android_remote_sha=lambda _branch: self.remote,
        )

        def install(_logger):
            remote = installer._get_android_remote_sha(installer.TARGET_BRANCH)
            internal_marker = self.internal / ".baas-ocr-prebuild-sha"
            local_marker = Path(installer.ANDROID_VERSION_FILE)
            for directory, marker in ((self.internal, internal_marker), (Path(installer.SERVER_BIN_DIR), local_marker)):
                if marker.exists() and (directory / "lib/arm64-v8a/libBAAS_ocr_server.so").exists():
                    if not remote or marker.read_text() == remote:
                        return
            self.downloads += 1
            if self.fail_download:
                raise RuntimeError("offline")
            destination = Path(installer.SERVER_BIN_DIR)
            shutil.rmtree(destination, ignore_errors=True)
            payload(destination, remote or "downloaded")

        class Client:
            def _prepare_android_runtime_folder(self):
                raise AssertionError("Legacy whole-directory replacement must not run")

        installer._install_android_prebuild = install
        self.installer = installer
        self.client = types.SimpleNamespace(__file__=str(self.service / "android_ocr_client.py"), BaasOcrClient=Client)
        for base in (self.source, self.internal):
            (base / "config").mkdir(parents=True)
            (base / "output").mkdir()
            (base / "config/global_setting.json").write_bytes(b"user OCR config: preserve exactly")
            (base / "output/user.log").write_bytes(b"user log: preserve exactly")
        (self.backend / "config").mkdir()
        (self.backend / "setup.toml").write_bytes(b"backend settings: preserve exactly")
        (self.backend / "config/user.json").write_bytes(b"profile: preserve exactly")

    def install_guard(self):
        self.assertTrue(cache.install_ocr_cache_guards(self.client, self.installer))

    def assert_user_data(self):
        for base in (self.source, self.internal):
            self.assertEqual((base / "config/global_setting.json").read_bytes(), b"user OCR config: preserve exactly")
            self.assertEqual((base / "output/user.log").read_bytes(), b"user log: preserve exactly")
        self.assertEqual((self.backend / "setup.toml").read_bytes(), b"backend settings: preserve exactly")
        self.assertEqual((self.backend / "config/user.json").read_bytes(), b"profile: preserve exactly")

    def test_first_install_downloads_to_staging_and_copies_only_managed_runtime(self):
        self.install_guard()
        self.installer._install_android_prebuild(None)
        result = self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual(result, str(self.internal))
        self.assertEqual(self.downloads, 1)
        self.assertEqual((self.internal / "lib/arm64-v8a/libBAAS_ocr_server.so").stat().st_mode & 0o777, 0o755)
        self.assertFalse(cache.cache_errors(self.internal, "arm64-v8a", 183))
        self.assert_user_data()
        self.assertFalse(list(self.source.parent.glob(".ocr-repair-*")))

    def test_incomplete_marked_caches_cannot_skip_repair(self):
        for missing in ("lib/arm64-v8a/libonnxruntime.so", "lib/arm64-v8a/libopencv_java4.so", "resource/ocr_models/model.onnx", "resource/ocr_models/test_images/en-us.png"):
            with self.subTest(missing=missing):
                payload(self.source)
                payload(self.internal)
                (self.source / missing).unlink()
                (self.internal / missing).unlink()
                if not getattr(self.client.BaasOcrClient, "_android_cache_guard_installed", False):
                    self.install_guard()
                before = self.downloads
                self.installer._install_android_prebuild(None)
                self.client.BaasOcrClient()._prepare_android_runtime_folder()
                self.assertEqual(self.downloads, before + 1)
                self.assertFalse(cache.cache_errors(self.internal, "arm64-v8a", 183))
                self.assert_user_data()

    def test_valid_source_repairs_internal_without_network_or_config_replacement(self):
        payload(self.source)
        payload(self.internal)
        (self.internal / "resource/ocr_models/model.onnx").unlink()
        self.install_guard()
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual(self.downloads, 0)
        self.assertFalse(cache.cache_errors(self.internal, "arm64-v8a", 183))
        self.assert_user_data()

    def test_complete_internal_runtime_is_available_when_the_source_cache_is_missing(self):
        payload(self.internal)
        self.remote = None
        self.install_guard()
        self.installer._install_android_prebuild(None)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(self.client.BaasOcrClient()._prepare_android_runtime_folder(), str(self.internal))
        self.assert_user_data()

    def test_newer_internal_runtime_is_not_downgraded_by_an_older_source_cache(self):
        payload(self.source, "old")
        payload(self.internal, "new")
        self.remote = "new"
        self.install_guard()
        self.installer._install_android_prebuild(None)
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual((self.internal / ".baas-ocr-prebuild-sha").read_text(), "new")
        self.assertEqual(self.downloads, 0)
        self.assert_user_data()

    def test_newer_source_runtime_replaces_only_managed_files(self):
        payload(self.source, "new")
        payload(self.internal, "old")
        self.remote = "new"
        self.install_guard()
        self.installer._install_android_prebuild(None)
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual((self.internal / ".baas-ocr-prebuild-sha").read_text(), "new")
        self.assertEqual(self.downloads, 0)
        self.assert_user_data()

    def test_apk_libcxx_changes_are_refreshed_even_with_an_unchanged_prebuild_sha(self):
        payload(self.source)
        self.install_guard()
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        target = self.internal / "lib/arm64-v8a/libc++_baasxx.so"
        before = target.read_bytes()
        (self.native / "libc++_shared.so").write_bytes(elf(content=b"apk-b\0libc++_shared.so"))
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertNotEqual(before, target.read_bytes())
        self.assertIn(b"apk-b\0libc++_baasxx.so", target.read_bytes())
        self.assertEqual(self.downloads, 0)
        self.assert_user_data()

    def test_missing_both_caches_fails_without_deleting_user_files_if_download_is_disabled(self):
        self.install_guard()
        with self.assertRaisesRegex(RuntimeError, "cache is incomplete"):
            self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assert_user_data()

    def test_failed_download_does_not_delete_existing_payload_or_configuration(self):
        payload(self.source)
        (self.source / "resource/ocr_models/model.onnx").unlink()
        before = (self.source / "lib/arm64-v8a/libBAAS_ocr_server.so").read_bytes()
        self.fail_download = True
        self.install_guard()
        with self.assertRaisesRegex(RuntimeError, "offline"):
            self.installer._install_android_prebuild(None)
        self.assertEqual((self.source / "lib/arm64-v8a/libBAAS_ocr_server.so").read_bytes(), before)
        self.assertFalse((self.source / ".baas-ocr-prebuild-sha").exists())
        self.assert_user_data()
        self.assertEqual(self.installer.SERVER_BIN_DIR, str(self.source))

    def test_copy_failure_retains_an_invalid_marker_and_can_retry_locally(self):
        payload(self.source)
        self.install_guard()
        original = cache._atomic_bytes
        def fail(path, content, mode=0o600):
            if Path(path) == self.internal / "resource/ocr_models/model.onnx":
                raise OSError("injected write failure")
            return original(path, content, mode)
        with patch.object(cache, "_atomic_bytes", side_effect=fail):
            with self.assertRaisesRegex(OSError, "injected"):
                self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertFalse((self.internal / ".baas-ocr-prebuild-sha").exists())
        self.assert_user_data()
        self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertFalse(cache.cache_errors(self.internal, "arm64-v8a", 183))

    def test_cache_guard_is_idempotent(self):
        self.install_guard()
        first = self.installer._install_android_prebuild
        self.install_guard()
        self.assertIs(self.installer._install_android_prebuild, first)

    def test_architecture_mismatch_and_unsafe_model_paths_are_rejected(self):
        payload(self.source, machine=62)
        self.assertTrue(cache.cache_errors(self.source, "arm64-v8a", 183))
        payload(self.source)
        (self.source / "resource/ocr_models/configs.txt").write_text("../outside.onnx\ndict.txt")
        self.assertIn("unsafe filename", cache.cache_errors(self.source, "arm64-v8a", 183)[0])

    def test_all_supported_recognition_images_are_required_for_repair(self):
        for language in ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr"):
            with self.subTest(language=language):
                payload(self.source)
                (self.source / "resource/ocr_models/test_images" / (language + ".png")).unlink()
                self.assertTrue(cache.cache_errors(self.source, "arm64-v8a", 183))

    def test_static_catalog_assets_are_required_even_when_the_manifest_omits_them(self):
        payload(self.source)
        path = self.source / "resource/static.json"
        catalog = json.loads(path.read_text())
        catalog["ocr_model_name"]["ko-kr"]["rec"] = "missing.onnx"
        path.write_text(json.dumps(catalog))
        self.assertTrue(cache.cache_errors(self.source, "arm64-v8a", 183))

    def test_source_and_destination_symlinks_cannot_touch_external_data(self):
        payload(self.source)
        external = self.root / "external"
        external.mkdir()
        (external / "model.onnx").write_bytes(b"external")
        (self.internal / "resource").symlink_to(external, target_is_directory=True)
        self.install_guard()
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual((external / "model.onnx").read_bytes(), b"external")
        self.assertFalse((external / "ocr_models").exists())
        self.assert_user_data()

    def test_library_destination_symlink_does_not_even_create_external_directories(self):
        payload(self.source)
        external = self.root / "external"
        external.mkdir()
        (self.internal / "lib").symlink_to(external, target_is_directory=True)
        self.install_guard()
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.client.BaasOcrClient()._prepare_android_runtime_folder()
        self.assertEqual(list(external.iterdir()), [])
        self.assert_user_data()

    def test_installer_outside_the_active_backend_is_rejected(self):
        self.installer.SERVER_BIN_DIR = str(self.root / "unrelated-cache")
        with self.assertRaisesRegex(RuntimeError, "outside the active backend"):
            self.install_guard()
        self.assertFalse((self.root / "unrelated-cache").exists())


if __name__ == "__main__":
    unittest.main()
