import importlib.util
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
MODULES = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"


def load(name):
    spec = importlib.util.spec_from_file_location(name, MODULES / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProcessAbiTest(unittest.TestCase):
    def test_reads_loaded_library_architecture_not_kernel_or_device_preference(self):
        abi = load("process_abi")
        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp) / "libchaquopy_java.so"
            for encoding, order in ((1, "little"), (2, "big")):
                for architecture, expected in ((62, "x86_64"), (183, "aarch64")):
                    with self.subTest(encoding=encoding, architecture=architecture):
                        header = bytearray(20)
                        header[:6] = b"\x7fELF" + bytes([2, encoding])
                        header[18:20] = architecture.to_bytes(2, order)
                        library.write_bytes(header)
                        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_LIBRARY_DIR": tmp}), \
                             patch("platform.machine", return_value="misleading-kernel"):
                            self.assertEqual(abi.machine(), expected)

    def test_missing_malformed_32_bit_or_unsupported_library_fails_closed(self):
        abi = load("process_abi")
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_LIBRARY_DIR": ""}):
            with self.assertRaisesRegex(RuntimeError, "directory is unavailable"):
                abi.machine()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_LIBRARY_DIR": tmp}):
            library = Path(tmp) / "libchaquopy_java.so"
            with self.assertRaises(FileNotFoundError):
                abi.machine()
            for header in (b"", b"not ELF" + bytes(13), b"\x7fELF\x01\x01" + bytes(14),
                           b"\x7fELF\x02\x03" + bytes(14), b"\x7fELF\x02\x01" + bytes(14)):
                library.write_bytes(header)
                with self.assertRaises(RuntimeError):
                    abi.machine()

    def test_client_and_both_installer_layouts_use_same_process_abi_only_on_android(self):
        bootstrap = load("bootstrap")
        source = (
            "import os, platform\n"
            "def _android_ocr_branch():\n"
            "    if os.getenv('BAAS_ANDROID') != '1':\n        return None\n"
            '    arch = platform.machine().lower()\n    if arch in {"aarch64", "arm64"}:\n'
            "        return 'android-arm64-v8a'\n"
            "    if arch == 'x86_64':\n        return 'android-x86_64'\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = [root / relative for relative in (
                "service/android_ocr_client.py", "service/android_ocr_installer.py",
                "core/ocr/baas_ocr_client/server_installer.py")]
            for file in paths:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(source, encoding="utf-8")
            bootstrap._patch_android_ocr_process_abi(root)
            first = [file.read_text(encoding="utf-8") for file in paths]
            bootstrap._patch_android_ocr_process_abi(root)
            self.assertEqual(first, [file.read_text(encoding="utf-8") for file in paths])
            native = types.ModuleType("android_backend.process_abi")
            native.machine = Mock(return_value="x86_64")
            package = types.ModuleType("android_backend")
            with patch.dict("sys.modules", {"android_backend": package, "android_backend.process_abi": native}), \
                 patch("platform.machine", return_value="aarch64"):
                for text in first:
                    namespace = {}
                    exec(text, namespace)
                    for machine, branch in (("x86_64", "android-x86_64"), ("aarch64", "android-arm64-v8a")):
                        native.machine.return_value = machine
                        with patch.dict(os.environ, {"BAAS_ANDROID": "1"}):
                            self.assertEqual(namespace["_android_ocr_branch"](), branch)
                    native.machine.reset_mock()
                    with patch.dict(os.environ, {"BAAS_ANDROID": "0"}):
                        self.assertIsNone(namespace["_android_ocr_branch"]())
                        native.machine.assert_not_called()
