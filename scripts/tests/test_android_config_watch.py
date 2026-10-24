import asyncio
import importlib.util
import json
import os
import tempfile
import threading
import types
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
MODULES = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"


def load(name):
    spec = importlib.util.spec_from_file_location(name, MODULES / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


watch = load("config_watch")


class AndroidConfigWatchTest(unittest.IsolatedAsyncioTestCase):
    @asynccontextmanager
    async def running(self, *paths, **options):
        ready = threading.Event()
        stop = threading.Event()
        queue = asyncio.Queue()
        original = watch._snapshot

        def snapshot(*args):
            result = original(*args)
            ready.set()
            return result

        async def consume():
            async for batch in watch.awatch(
                *paths, poll_delay_ms=10, debounce=30, step=10, stop_event=stop, **options
            ):
                await queue.put(batch)

        with patch.object(watch, "_snapshot", side_effect=snapshot):
            worker = asyncio.create_task(consume())
            try:
                async def started():
                    while not ready.is_set():
                        if worker.done():
                            await worker
                        await asyncio.sleep(0.001)

                await asyncio.wait_for(started(), 2)
                yield queue, worker
            finally:
                stop.set()
                await asyncio.wait_for(worker, 2)

    async def batch(self, queue):
        return await asyncio.wait_for(queue.get(), 2)

    async def quiet(self, queue):
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(queue.get(), 0.12)

    def test_change_values_and_bootstrap_reexport_are_compatible(self):
        self.assertEqual([change.value for change in watch.Change], [1, 2, 3])
        self.assertEqual(watch.Change.modified, 2)
        package = types.ModuleType("android_backend")
        package.__path__ = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            load("bootstrap")._write_watchfiles_stub(root)
            source = (root / "watchfiles.py").read_text(encoding="utf-8")
            self.assertEqual(source, "from android_backend.config_watch import Change, awatch\n")
            with patch.dict("sys.modules", {"android_backend": package, "android_backend.config_watch": watch}):
                namespace = {}
                exec(source, namespace)
            self.assertIs(namespace["Change"], watch.Change)
            self.assertIs(namespace["awatch"], watch.awatch)

    async def test_existing_configuration_modifications_are_observed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config.json"
            path.write_text('{"value": 1}', encoding="utf-8")
            async with self.running(root) as (queue, _):
                path.write_text('{"value": 2}', encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.modified, str(path))})
                self.assertEqual(json.loads(path.read_text())["value"], 2)
                await self.quiet(queue)

    async def test_additions_and_deletions_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "event.json"
            async with self.running(root) as (queue, _):
                path.write_text("[]", encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.added, str(path))})
                path.unlink()
                self.assertEqual(await self.batch(queue), {(watch.Change.deleted, str(path))})

    async def test_recursive_nested_profile_and_missing_root_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "config"
            path = root / "new_profile" / "config.json"
            async with self.running(root) as (queue, _):
                path.parent.mkdir(parents=True)
                path.write_text('{"name":"new"}', encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.added, str(path))})
                path.unlink()
                path.parent.rmdir()
                root.rmdir()
                self.assertEqual(await self.batch(queue), {(watch.Change.deleted, str(path))})

    async def test_nonrecursive_watch_only_observes_direct_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nested = root / "profile" / "config.json"
            direct = root / "gui.json"
            nested.parent.mkdir()
            nested.write_text("{}", encoding="utf-8")
            async with self.running(root, recursive=False) as (queue, _):
                nested.write_text('{"value":1}', encoding="utf-8")
                await self.quiet(queue)
                direct.write_text("{}", encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.added, str(direct))})

    async def test_explicit_file_does_not_watch_its_parent_or_other_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "setup.toml"
            other = root / "unwatched.json"
            target.write_text("value = 1\n", encoding="utf-8")
            async with self.running(target) as (queue, _):
                other.write_text("{}", encoding="utf-8")
                await self.quiet(queue)
                target.write_text("value = 2\n", encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.modified, str(target))})

    async def test_multiple_explicit_watch_paths_are_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            config.mkdir()
            setup = root / "setup.toml"
            setup.write_text("value = 1\n", encoding="utf-8")
            path = config / "gui.json"
            async with self.running(config, setup) as (queue, _):
                path.write_text("{}", encoding="utf-8")
                setup.write_text("value = 2\n", encoding="utf-8")
                changes = await self.batch(queue)
                if len(changes) == 1:
                    changes |= await self.batch(queue)
                self.assertEqual(changes, {(watch.Change.added, str(path)), (watch.Change.modified, str(setup))})

    async def test_half_written_json_and_its_sibling_wait_for_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            event = root / "event.json"
            config.write_text('{"value": 1}', encoding="utf-8")
            event.write_text("[]", encoding="utf-8")
            async with self.running(root) as (queue, _):
                config.write_text('{"value":', encoding="utf-8")
                event.write_text('[{"done":true}]', encoding="utf-8")
                await self.quiet(queue)
                config.write_text('{"value": 2}', encoding="utf-8")
                self.assertEqual(await self.batch(queue), {
                    (watch.Change.modified, str(config)), (watch.Change.modified, str(event)),
                })
                await self.quiet(queue)

    async def test_invalid_json_does_not_block_an_unrelated_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first" / "config.json"
            second = root / "second" / "config.json"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_text("{}", encoding="utf-8")
            second.write_text("{}", encoding="utf-8")
            async with self.running(root) as (queue, _):
                first.write_text('{"invalid":', encoding="utf-8")
                second.write_text('{"value":2}', encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.modified, str(second))})
                await self.quiet(queue)

    async def test_new_profile_pair_is_not_reported_while_one_json_is_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "new_profile" / "config.json"
            event = config.with_name("event.json")
            async with self.running(root) as (queue, _):
                config.parent.mkdir()
                config.write_text('{"name":"new"}', encoding="utf-8")
                event.write_text("[", encoding="utf-8")
                await self.quiet(queue)
                event.write_text("[]", encoding="utf-8")
                self.assertEqual(await self.batch(queue), {
                    (watch.Change.added, str(config)), (watch.Change.added, str(event)),
                })

    async def test_short_write_burst_is_debounced_into_the_final_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config.json"
            path.write_text('{"value":0}', encoding="utf-8")
            async with self.running(root) as (queue, _):
                for value in range(1, 6):
                    path.write_text(json.dumps({"value": value}), encoding="utf-8")
                    await asyncio.sleep(0.01)
                    self.assertTrue(queue.empty())
                self.assertEqual(await self.batch(queue), {(watch.Change.modified, str(path))})
                self.assertEqual(json.loads(path.read_text())["value"], 5)
                await self.quiet(queue)

    async def test_log_growth_is_ignored_and_log_directories_are_never_scanned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            log = logs / "baas-service.jsonl"
            direct_log = root / "script.log"
            target = root / "gui.json"
            visited = []
            scandir = os.scandir

            def tracked(path):
                visited.append(os.fspath(path))
                self.assertNotEqual(os.path.basename(path), "logs")
                return scandir(path)

            with patch.object(watch.os, "scandir", side_effect=tracked):
                async with self.running(root) as (queue, _):
                    for index in range(4):
                        log.write_text("x" * (index + 1), encoding="utf-8")
                        direct_log.write_text("y" * (index + 1), encoding="utf-8")
                        await asyncio.sleep(0.015)
                    await self.quiet(queue)
                    target.write_text("{}", encoding="utf-8")
                    self.assertEqual(await self.batch(queue), {(watch.Change.added, str(target))})
            self.assertNotIn(str(logs), visited)

    async def test_symlink_directory_cannot_escape_the_explicit_watch_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            watched = root / "config"
            outside = root / "outside"
            watched.mkdir()
            outside.mkdir()
            (watched / "linked").symlink_to(outside, target_is_directory=True)
            async with self.running(watched) as (queue, _):
                (outside / "config.json").write_text("{}", encoding="utf-8")
                await self.quiet(queue)

    async def test_watch_filter_and_timeout_yields_are_compatible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            accepted = root / "config.json"
            async with self.running(root, watch_filter=lambda change, path: path == str(accepted)) as (queue, _):
                (root / "other.json").write_text("{}", encoding="utf-8")
                await self.quiet(queue)
                accepted.write_text("{}", encoding="utf-8")
                self.assertEqual(await self.batch(queue), {(watch.Change.added, str(accepted))})
            generator = watch.awatch(root, poll_delay_ms=10, rust_timeout=20, yield_on_timeout=True)
            try:
                self.assertEqual(await asyncio.wait_for(generator.__anext__(), 1), set())
            finally:
                await generator.aclose()

    async def test_task_cancellation_and_stop_event_exit_promptly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generator = watch.awatch(root, poll_delay_ms=10000)
            pending = asyncio.create_task(generator.__anext__())
            await asyncio.sleep(0.03)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(pending, 0.5)
            await generator.aclose()
            for event in (threading.Event(), asyncio.Event()):
                generator = watch.awatch(root, poll_delay_ms=10000, stop_event=event)
                pending = asyncio.create_task(generator.__anext__())
                await asyncio.sleep(0.03)
                event.set()
                with self.assertRaises(StopAsyncIteration):
                    await asyncio.wait_for(pending, 0.5)
                await generator.aclose()

    async def test_already_stopped_watcher_does_not_start_a_filesystem_scan(self):
        stop = threading.Event()
        stop.set()
        with patch.object(watch, "_snapshot", side_effect=AssertionError("unexpected scan")):
            generator = watch.awatch("unused", stop_event=stop)
            with self.assertRaises(StopAsyncIteration):
                await generator.__anext__()
            await generator.aclose()


if __name__ == "__main__":
    unittest.main()
