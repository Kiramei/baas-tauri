import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shared_inputs import ANDROID, BAASX, JS, MEMBERS, NATIVE, UI, bun_owners, cargo_manifest_owners, cargo_owners, jsonc, manifest_owners, shared_owners, target_changes

ROOT = Path(__file__).resolve().parents[2]


class BunOwnership(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lock = jsonc((ROOT / 'bun.lock').read_text())

    def change(self, key):
        before, after = copy.deepcopy(self.lock), copy.deepcopy(self.lock)
        after['packages'][key][-1] += '-new'
        return bun_owners(json.dumps(before), json.dumps(after))

    def test_workspace_nested_package_does_not_select_ui(self):
        self.assertEqual(self.change('@baas/baasx/react'), JS)
        self.assertEqual(self.change('ink'), JS)

    def test_ui_only_and_shared_dependencies(self):
        self.assertEqual(self.change('vite'), UI)
        self.assertEqual(self.change('libsodium-wrappers-sumo'), UI | JS)

    def test_workspace_metadata_and_ambiguous_changes(self):
        after = copy.deepcopy(self.lock)
        after['workspaces']['baasx']['version'] = '99.0.0'
        self.assertEqual(bun_owners(json.dumps(self.lock), json.dumps(after)), JS)
        after['overrides'] = {'x': '1'}
        self.assertEqual(bun_owners(json.dumps(self.lock), json.dumps(after)), UI | JS)

    def test_workspace_root_isolated_from_nested_resolutions(self):
        # Package keys such as @baas/baasx/react are scoped resolutions, not react's root instance.
        self.assertNotEqual(self.change('react'), self.change('@baas/baasx/react'))

    def test_string_containing_comma_before_brace_is_unchanged(self):
        self.assertEqual(jsonc('{"value":"a, }",}'), {'value': 'a, }'})


class CargoOwnership(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tomllib
        cls.lock = tomllib.loads((ROOT / 'Cargo.lock').read_text())
        cls.manifests = {name: tomllib.loads((ROOT / path).read_text()) for path, (name, _) in MEMBERS.items()}

    @staticmethod
    def as_toml(lock):
        # Cargo entries here only contain strings and arrays of strings.
        lines = [f'version = {lock["version"]}']
        for package in lock['package']:
            lines.append('[[package]]')
            for key, value in package.items():
                lines.append(f'{key} = {json.dumps(value)}')
        return '\n'.join(lines)

    def change(self, name):
        modified = copy.deepcopy(self.lock)
        package = next(p for p in modified['package'] if p['name'] == name)
        package['checksum'] = 'updated'
        return cargo_owners(self.as_toml(self.lock), self.as_toml(modified))

    def test_helper_dependency_does_not_select_clients(self):
        self.assertEqual(self.change('ctrlc'), BAASX)

    def test_shared_native_dependency_reaches_both_products(self):
        self.assertEqual(self.change('serde'), BAASX | NATIVE | ANDROID)

    def test_unreachable_package_selects_all(self):
        modified = copy.deepcopy(self.lock)
        modified['package'].append({'name': 'unattached-ci-test', 'version': '1.0.0', 'checksum': 'x'})
        self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(modified)), BAASX | NATIVE | ANDROID)

    def test_workspace_dependency_only_selects_its_consumers(self):
        lock = self.as_toml(self.lock)
        old = '[workspace]\nmembers = ["."]\n[workspace.dependencies]\nctrlc = "3"\n'
        new = old.replace('ctrlc = "3"', 'ctrlc = "4"')
        self.assertEqual(cargo_manifest_owners(old, new, lock, lock), BAASX)
        self.assertEqual(cargo_manifest_owners(old, new + '\n[profile.release]\nlto = true\n', lock, lock), BAASX | NATIVE | ANDROID)

    def test_actual_target_manifests_and_lock_edges(self):
        for crate, target, dep, expected in (
            ('baas-notifier', 'cfg(windows)', 'windows-registry', {'native:windows'}),
            ('baas-tauri', 'cfg(target_os = "linux")', 'gdkx11', {'native:linux'}),
            ('baas-tauri', 'cfg(target_os = "android")', 'minreq', ANDROID),
        ):
            with self.subTest(dependency=dep):
                modified = copy.deepcopy(self.manifests[crate])
                modified['target'][target]['dependencies'][dep] = '999'
                selected = target_changes(self.manifests[crate], modified, NATIVE | ANDROID)
                self.assertEqual(selected, ({dep}, expected))

        # The lock has external wry/hyper-util incoming edges. Cargo.lock
        # contains no cfg for those edges, so they must remain conservative.
        for dep in ('windows-registry', 'gdkx11'):
            changed = copy.deepcopy(self.lock)
            next(p for p in changed['package'] if p['name'] == dep)['checksum'] = 'new'
            self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(changed), self.manifests, self.manifests), NATIVE | ANDROID | BAASX)

        # minreq has only one incoming lock edge, from the Android target.
        changed = copy.deepcopy(self.lock)
        next(p for p in changed['package'] if p['name'] == 'minreq')['checksum'] = 'new'
        self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(changed), self.manifests, self.manifests), ANDROID)

    def test_helper_target_and_unknown_cfg(self):
        manifests = copy.deepcopy(self.manifests)
        helper = manifests['baasx-runtime']
        ctrlc = helper['dependencies'].pop('ctrlc')
        helper['target'] = {'cfg(windows)': {'dependencies': {'ctrlc': ctrlc}}}
        changed = copy.deepcopy(self.lock)
        next(p for p in changed['package'] if p['name'] == 'ctrlc')['checksum'] = 'new'
        self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(changed), manifests, manifests), {'baasx-native:windows'})
        helper['target'] = {'cfg(target_arch = "x86_64")': {'dependencies': {'ctrlc': ctrlc}}}
        self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(changed), manifests, manifests), BAASX)

    def test_multiple_target_consumers_and_host_build_dependencies_are_conservative(self):
        manifests = copy.deepcopy(self.manifests)
        app = manifests['baas-tauri']
        app['target']['cfg(target_os = "linux")']['dependencies']['minreq'] = '3'
        changed = copy.deepcopy(self.lock)
        next(p for p in changed['package'] if p['name'] == 'minreq')['checksum'] = 'new'
        self.assertEqual(cargo_owners(self.as_toml(self.lock), self.as_toml(changed), manifests, manifests), ANDROID | {'native:linux'})
        before = {'target': {'cfg(windows)': {'build-dependencies': {'foo': '1'}}}}
        after = {'target': {'cfg(windows)': {'build-dependencies': {'foo': '2'}}}}
        self.assertEqual(target_changes(before, after, NATIVE), ({'foo'}, NATIVE))
        self.assertIsNone(target_changes({'target': {'cfg(linux)': {'dependencies': {'foo': '1'}}}},
                                         {'target': {'cfg(linux)': {'dependencies': {'foo': '2'}}}}, NATIVE))


class SharedSnapshots(unittest.TestCase):
    def test_manifest_dependencies_and_scoped_scripts(self):
        self.assertEqual(manifest_owners('{"dependencies":{"vite":"1"}}', '{"dependencies":{"vite":"2"}}'), UI)
        self.assertEqual(manifest_owners('{"scripts":{"baasx:build":"a"}}', '{"scripts":{"baasx:build":"b"}}'), JS)
        self.assertEqual(manifest_owners('{"scripts":{"build:tauri:android":"a"}}', '{"scripts":{"build:tauri:android":"b"}}'), {"ui:android"})
        self.assertEqual(manifest_owners('{"scripts":{"build:webui":"a"}}', '{"scripts":{"build:webui":"b"}}'), {"ui:webui"})
        self.assertEqual(manifest_owners('{"workspaces":[]}', '{"workspaces":["new"]}'), UI | JS)

    def test_git_blobs_and_unsupported_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'CI fixture')
            git('config', 'user.email', 'ci@example.invalid')
            package = Path(tmp, 'package.json')
            package.write_text('{"dependencies":{"vite":"1"}}')
            Path(tmp, 'bun.lock').write_text('legacy binary lock')
            git('add', '.'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD')
            package.write_text('{"dependencies":{"vite":"2"}}')
            Path(tmp, 'bun.lock').write_text('another unsupported format')
            git('add', '.'); git('commit', '-qm', 'change'); head = git('rev-parse', 'HEAD')
            package.write_text('{"workspaces":["uncommitted"]}')
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                self.assertEqual(shared_owners('package.json', base, head), UI)
                self.assertEqual(shared_owners('bun.lock', base, head), UI | JS)
                self.assertIsNone(shared_owners('src/foo.ts', base, head))
                self.assertEqual(shared_owners('Cargo.lock', base, head), NATIVE | ANDROID | BAASX)
            finally:
                os.chdir(previous)

    def test_scoped_lock_upgrades_from_committed_blobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'CI fixture')
            git('config', 'user.email', 'ci@example.invalid')
            lock = {
                'lockfileVersion': 1,
                'workspaces': {
                    '': {'name': 'app', 'dependencies': {'react': '1'}},
                    'baasx': {'name': '@baas/baasx', 'dependencies': {'react': '2'}},
                },
                'packages': {
                    'react': ['react@1', '', {}, 'ui-checksum'],
                    '@baas/baasx/react': ['react@2', '', {}, 'baasx-checksum'],
                },
            }
            cargo = ('version = 4\n'
                     '[[package]]\nname = "baas-tauri"\nversion = "1"\ndependencies = ["ui"]\n'
                     '[[package]]\nname = "baas-cli-runtime"\nversion = "1"\ndependencies = ["ctrlc"]\n'
                     '[[package]]\nname = "ui"\nversion = "1"\n'
                     '[[package]]\nname = "ctrlc"\nversion = "1"\nchecksum = "old"\n')
            Path(tmp, 'bun.lock').write_text(json.dumps(lock))
            Path(tmp, 'Cargo.lock').write_text(cargo)
            git('add', '.'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD')
            lock['packages']['@baas/baasx/react'][-1] = 'new-checksum'
            Path(tmp, 'bun.lock').write_text(json.dumps(lock))
            Path(tmp, 'Cargo.lock').write_text(cargo.replace('checksum = "old"', 'checksum = "new"'))
            git('add', '.'); git('commit', '-qm', 'updates'); head = git('rev-parse', 'HEAD')
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                self.assertEqual(shared_owners('bun.lock', base, head), JS)
                self.assertEqual(shared_owners('Cargo.lock', base, head), BAASX)
            finally:
                os.chdir(previous)

    def test_android_target_manifest_and_lock_from_real_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(['git', '-C', tmp, *args], text=True).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'CI fixture')
            git('config', 'user.email', 'ci@example.invalid')
            for name in ['Cargo.toml', 'Cargo.lock', *MEMBERS]:
                dest = Path(tmp, name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text((ROOT / name).read_text())
            git('add', '.'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD')
            app = Path(tmp, 'src-tauri/Cargo.toml')
            text = app.read_text()
            self.assertIn('minreq = { version = "3.0.0"', text)
            app.write_text(text.replace('minreq = { version = "3.0.0"', 'minreq = { version = "3.0.1"'))
            cargo = Path(tmp, 'Cargo.lock')
            text = cargo.read_text()
            self.assertIn('name = "minreq"\nversion = "3.0.0"', text)
            cargo.write_text(text.replace('name = "minreq"\nversion = "3.0.0"', 'name = "minreq"\nversion = "3.0.1"'))
            git('add', '.'); git('commit', '-qm', 'android upgrade'); head = git('rev-parse', 'HEAD')
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                self.assertEqual(shared_owners('src-tauri/Cargo.toml', base, head), ANDROID)
                self.assertEqual(shared_owners('Cargo.lock', base, head), ANDROID)
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
