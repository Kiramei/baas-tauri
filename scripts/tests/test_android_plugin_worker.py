"""Portable boundary tests for the APK helper; real Chaquopy lifecycle is tested on Android."""
import asyncio
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock


HELPER = Path(__file__).resolve().parents[2] / "src-tauri/gen/android/app/src/main/python/android_backend/plugin_worker.py"
BOOTSTRAP = HELPER.with_name("bootstrap.py")
DRIVER = """import importlib.util, sys
spec = importlib.util.spec_from_file_location('android_plugin_helper', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.run(sys.argv[2], sys.argv[3], sys.argv[4])
"""


class AndroidPluginWorkerTest(unittest.TestCase):
    def bootstrap(self):
        spec = importlib.util.spec_from_file_location("android_plugin_bootstrap_test", BOOTSTRAP)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_native_worker_receives_canonical_private_paths_from_android_aliases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            storage = root / "data/user/0/app"
            job = storage / "cache/job"
            package = storage / "files/plugin"
            job.mkdir(parents=True)
            package.mkdir(parents=True)
            legacy = root / "data/data"
            legacy.symlink_to(root / "data/user/0", target_is_directory=True)
            adapter = root / "service/plugins/android.py"
            adapter.parent.mkdir(parents=True)
            adapter.write_text(
                "import asyncio\n"
                "class Worker:\n"
                "    async def launch(self, bridge, slot, directory, package_dir):\n"
                "        try:\n"
                "            starting = asyncio.create_task(asyncio.to_thread(bridge.start, slot, str(directory), str(package_dir)))\n"
                "            return await starting\n"
                "        finally:\n"
                "            pass\n"
            )
            bootstrap = self.bootstrap()
            bootstrap._patch_android_plugin_worker_paths(root)
            patched = adapter.read_text()
            bootstrap._patch_android_plugin_worker_paths(root)
            self.assertEqual(adapter.read_text(), patched)
            namespace = {}
            exec(compile(patched, str(adapter), "exec"), namespace)
            bridge = Mock()
            bridge.start.return_value = "native-lease"
            result = asyncio.run(namespace["Worker"]().launch(
                bridge, 1, legacy / "app/cache/job", legacy / "app/files/plugin"
            ))
            self.assertEqual(result, "native-lease")
            bridge.start.assert_called_once_with(1, str(job.resolve()), str(package.resolve()))

    def test_older_backend_without_plugin_workers_is_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.bootstrap()._patch_android_plugin_worker_paths(root)
            self.assertEqual(list(root.iterdir()), [])

    def execute(self, request, worker):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            helper = root / "helper" / "plugin_worker.py"
            helper.parent.mkdir()
            shutil.copyfile(HELPER, helper)
            package = root / "package"
            package.mkdir()
            (package / "main.py").write_text("VALUE = 'plugin code'\n", encoding="utf-8")
            job = root / "job"
            job.mkdir()
            (job / "worker.py").write_text(worker, encoding="utf-8")
            payload = request if isinstance(request, bytes) else json.dumps(request, ensure_ascii=False).encode("utf-8")
            (job / "request.json").write_bytes(payload)
            child = subprocess.run([sys.executable, "-I", "-c", DRIVER, str(helper), str(package), str(job / "request.json"), str(job / "result.json")], capture_output=True, timeout=10)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(child.stdout, b"")
            self.assertEqual(child.stderr, b"")
            self.assertFalse((job / "result.json.tmp").exists())
            self.assertFalse((job / "__pycache__").exists())
            self.assertFalse((package / "__pycache__").exists())
            content = (job / "result.json").read_bytes()
            self.assertLessEqual(len(content), 131072)
            return json.loads(content), content

    def test_unicode_atomic_output_and_bytecode_disabled_before_host_import(self):
        worker = """import sys
assert sys.dont_write_bytecode
def execute_request(package_dir, request):
    import importlib.util
    spec = importlib.util.spec_from_file_location('example_plugin', package_dir + '/main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    print('private-plugin-detail')
    sys.stderr.write('private-plugin-detail')
    return {'ok': True, 'result': request['input']}
"""
        response, content = self.execute({"input": {"message": "体力预算 😀"}}, worker)
        self.assertEqual(response, {"ok": True, "result": {"message": "体力预算 😀"}})
        self.assertIn("体力预算".encode("utf-8"), content)
        self.assertNotIn(b"private-plugin-detail", content)

    def test_invalid_or_excessive_requests_never_execute_host_worker(self):
        worker = "def execute_request(*args):\n    return {'ok':True,'result':'must not execute'}\n"
        for request in [b"{invalid", b"{}" + b" " * 131072, b'{"input":NaN}', b"\xff"]:
            with self.subTest(request_type=str(request[:20])):
                response, _ = self.execute(request, worker)
                self.assertEqual(response, {"ok": False, "code": "ACTION_FAILED", "message": "Plugin action failed."})

    def test_host_exception_has_no_traceback_path_or_exception_message(self):
        response, content = self.execute({}, "def execute_request(*args):\n    raise RuntimeError('private-plugin-detail ' + __file__)\n")
        self.assertFalse(response["ok"])
        self.assertNotIn(b"private-plugin-detail", content)
        self.assertNotIn(b"worker.py", content)
        self.assertNotIn(b"Traceback", content)

    def test_excessive_or_nonfinite_host_results_fail_closed(self):
        for result in ["'x'*131073", "float('nan')"]:
            with self.subTest(result=result):
                response, _ = self.execute({}, f"def execute_request(*args):\n    return {{'ok':True,'result':{result}}}\n")
                self.assertFalse(response["ok"])


if __name__ == "__main__":
    unittest.main()
