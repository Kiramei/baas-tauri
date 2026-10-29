"""Reserved Android templates never become listed or pushed user profiles."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend/bootstrap.py"
WATCH = BOOTSTRAP.with_name("config_watch.py")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load("template_bootstrap", BOOTSTRAP)
Change = load("template_watch", WATCH).Change

# The relevant unmodified service boundaries from canonical 5658a048. Executing
# these patched methods against real folders tests behavior without loading its
# native OCR, Android or HTTP dependencies into the host test process.
MANAGER = '''from __future__ import annotations
class ConfigManager:
    def list_config_ids(self) -> list[str]:
        ids = []
        if not self._config_root.exists():
            return ids
        for child in self._config_root.iterdir():
            if not child.is_dir():
                continue
            config_file = child / "config.json"
            event_file = child / "event.json"
            if config_file.exists() and event_file.exists():
                ids.append(child.name)
        return sorted(ids)

    def _classify_config_change(self, change, path):
        try:
            relative_parts = path.relative_to(self._config_root).parts
        except ValueError:
            return False, None
        if not relative_parts:
            return True, None
        if len(relative_parts) == 1:
            return change != Change.modified, None
        if len(relative_parts) == 2:
            config_id, filename = relative_parts
            if filename == "config.json":
                return change != Change.modified, ("config", config_id)
            if filename == "event.json":
                return change != Change.modified, ("event", config_id)
        return change != Change.modified, None
'''

RUNTIME = '''from __future__ import annotations
class ServiceRuntime:
    def _ensure_config(self):
        config_dir_list = []
        config_root = self._project_root / "config"
        initializer = ConfigInitializer(self._project_root)
        config_root.mkdir(exist_ok=True)
        for config_id in os.listdir(config_root):
            config_dir = config_root / config_id
            if config_dir.is_dir() and "config.json" in os.listdir(config_dir):
                initializer.check_config(config_id)
                config_dir_list.append(config_id)
        if len(config_dir_list) == 0:
            initializer.check_config('default_config')

    def _list_config_ids_sync(self) -> list[str]:
        config_root = self._project_root / "config"
        if not config_root.exists():
            return []
        ids = []
        for child in config_root.iterdir():
            if child.is_dir() and (child / "config.json").exists() and (child / "event.json").exists():
                ids.append(child.name)
        return sorted(ids)

    async def add_config(self, name, server):
        serial_name = self._new_config_id()
        ConfigInitializer(self._project_root).check_config(serial_name, name=name, server=server)
        return {"serial": serial_name}

    def _new_config_id(self):
        return str(int(time.time() * 1000))
'''


class ConfigInitializerFixture:
    def __init__(self, root):
        self.root = root

    def check_config(self, config_id, *, name=None, server=None):
        target = self.root / "config" / config_id
        target.mkdir(parents=True, exist_ok=True)
        config = target / "config.json"
        if not config.exists():
            config.write_text(json.dumps({"name": name or "template", "server": server or "CN"}))
        for resource in ("event", "switch"):
            path = target / (resource + ".json")
            if not path.exists():
                path.write_text("[]")


class AndroidProfileTemplateTest(unittest.TestCase):
    def prepare(self, root):
        import os
        (root / "service/conf").mkdir(parents=True)
        (root / "service/conf/manager.py").write_text(MANAGER)
        (root / "service/runtime.py").write_text(RUNTIME)
        bootstrap._patch_android_template_profile_filter(root)
        manager_scope = {"Change": Change}
        runtime_scope = {"ConfigInitializer": ConfigInitializerFixture, "time": time, "os": os}
        exec(compile((root / "service/conf/manager.py").read_text(), "manager.py", "exec"), manager_scope)
        exec(compile((root / "service/runtime.py").read_text(), "runtime.py", "exec"), runtime_scope)
        manager = manager_scope["ConfigManager"]()
        manager._config_root = root / "config"
        runtime = runtime_scope["ServiceRuntime"]()
        runtime._project_root = root
        return manager, runtime

    def test_template_initialization_stays_on_disk_but_zero_user_profiles_are_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager, runtime = self.prepare(root)
            runtime._ensure_config()
            self.assertTrue((root / "config/default_config/config.json").is_file())
            self.assertTrue((root / "config/default_config/event.json").is_file())
            self.assertEqual(manager.list_config_ids(), [])
            self.assertEqual(runtime._list_config_ids_sync(), [])

    def test_template_changes_never_request_rescan_or_resource_push(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager, runtime = self.prepare(root)
            runtime._ensure_config()
            for change in Change:
                for relative in ("default_config", "default_config/config.json",
                                 "default_config/event.json", "default_config/nested/file.json"):
                    with self.subTest(change=change, relative=relative):
                        self.assertEqual(manager._classify_config_change(
                            change, root / "config" / relative), (False, None))

    def test_real_copied_user_profile_remains_listed_and_changes_still_push(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager, runtime = self.prepare(root)
            runtime._ensure_config()
            copied_id = "1793236142124"
            ConfigInitializerFixture(root).check_config(copied_id, name="用户复制", server="CN")
            config_path = root / "config" / copied_id / "config.json"
            original = config_path.read_bytes()
            self.assertEqual(manager.list_config_ids(), [copied_id])
            self.assertEqual(runtime._list_config_ids_sync(), [copied_id])
            self.assertEqual(manager._classify_config_change(Change.modified, config_path),
                             (False, ("config", copied_id)))
            self.assertEqual(manager._classify_config_change(Change.added, config_path),
                             (True, ("config", copied_id)))
            self.assertEqual(config_path.read_bytes(), original)

    def test_explicit_add_config_still_creates_a_real_profile_without_removing_the_template(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager, runtime = self.prepare(root)
            runtime._ensure_config()
            template = root / "config/default_config/config.json"
            template_bytes = template.read_bytes()
            result = asyncio.run(runtime.add_config("我的日常", "JP"))
            created_id = result["serial"]
            self.assertNotEqual(created_id, "default_config")
            self.assertEqual(manager.list_config_ids(), [created_id])
            self.assertEqual(runtime._list_config_ids_sync(), [created_id])
            self.assertEqual(json.loads((root / "config" / created_id / "config.json").read_text()),
                             {"name": "我的日常", "server": "JP"})
            self.assertEqual(template.read_bytes(), template_bytes)

    def test_adapter_is_idempotent_without_touching_any_profile_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager, runtime = self.prepare(root)
            runtime._ensure_config()
            ConfigInitializerFixture(root).check_config("default_config_copy", name="复制模板", server="CN")
            first = {relative: (root / relative).read_bytes() for relative in
                     ("service/conf/manager.py", "service/runtime.py",
                      "config/default_config/config.json", "config/default_config_copy/config.json")}
            bootstrap._patch_android_template_profile_filter(root)
            self.assertEqual(first, {relative: (root / relative).read_bytes() for relative in first})
            self.assertEqual(manager.list_config_ids(), ["default_config_copy"])
            self.assertEqual(runtime._list_config_ids_sync(), ["default_config_copy"])


if __name__ == "__main__":
    unittest.main()
