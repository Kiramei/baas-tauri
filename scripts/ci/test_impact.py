import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from impact import classify, changes, frontend_inputs, jobs, owners, plan, verify


class Routing(unittest.TestCase):
    def test_only_owning_layers_run(self):
        cases = {
            "README.md": {"readme"},
            "crates/baas-updater/README.md": {"readme"},
            "docs/development/CI.md": {"readme"},
            "baasx/release-notes/v1.md": {"readme"},
            "docs/content/docs/en/guide.mdx": {"site"},
            "docs/components/Terminal.tsx": {"site"},
            ".github/actions/sync-cnb-release/action.yml": {"contracts"},
            ".github/workflows/source-dispatch.yml": {"contracts"},
            ".github/actions/mirror-upstream-release/action.yml": {"contracts"},
            "scripts/mirror-upstream-release.py": {"contracts"},
            "scripts/tests/test_mirror_upstream_release.py": {"contracts"},
            "src/android/pages/SettingsPage.tsx": {"ui:android"},
            "src/shared/AndroidAuth.ts": {"ui:android"},
            "src/platform/linux/useNativeWindowControls.ts": {"ui:linux"},
            "src/platform/windows/acrylic.css": {"ui:windows"},
            "src/App.tsx": {"ui:webui", "ui:tauri"},
            "src/main.tsx": {"ui:webui", "ui:tauri", "ui:android"},
            "src/shared/SweepCounts.ts": {"ui:webui", "ui:tauri", "ui:android", "baasx-source"},
            "baasx/src/runtime.ts": {"baasx-source", "baasx-js:windows", "baasx-js:linux", "baasx-js:macos"},
            "baasx/src/workspace.ts": {"baasx-source"},
            "baasx/registry/alias.mjs": {"registry"},
            "baasx/src/platform/posix/process-tree.ts": {"baasx-js:linux", "baasx-js:macos"},
            "baasx/src/platform/windows/process-tree.ts": {"baasx-js:windows"},
            "src-tauri/src/platform/android.rs": {"android:arm64", "android-tests"},
            "src-tauri/src/platform/windows/window_material.rs": {"native:windows"},
            "src-tauri/src/shm_native/macos.rs": {"native:macos"},
            "src-tauri/webview2.arm64.json": {"native:windows:arm64"},
            "src-tauri/gen/android/app/src/main/python/adapter.py": {"android-tests"},
            "crates/baas-notifier/src/platform/windows.rs": {"native:windows"},
            "crates/baas-notifier/src/platform/android.rs": {"android:arm64", "android-tests"},
            "baasx/scripts/platform/windows/runtime-alias.rs": {"baasx-native:windows"},
            "crates/baasx-runtime/src/platform/windows/process.rs": {"baasx-native:windows"},
            "crates/baas-cli-runtime/src/main.rs": {"baasx-native:windows","baasx-native:linux","baasx-native:macos"},
            "crates/baasx-runtime/src/progress.rs": {"baasx-native:windows","baasx-native:linux","baasx-native:macos"},
            "crates/baas-updater/src/mirrorc.rs": {"native:windows", "native:linux", "native:macos", "android:arm64", "android-tests", "baasx-native:windows", "baasx-native:linux", "baasx-native:macos"},
            "scripts/docker/entrypoint.sh": {"docker"},
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(owners(path), expected)
        with self.assertRaisesRegex(ValueError, "No CI owner"):
            owners("new-product/src/main.rs")

    def test_targets_and_mixed_changes(self):
        result = classify(["src-tauri/webview2.arm64.json", "src/android/App.tsx", "baasx/src/platform/windows/process-tree.ts"])
        self.assertEqual(result["desktop"], [dict(os="windows-11-arm", target="aarch64-pc-windows-msvc")])
        self.assertEqual(result["frontend"], ["android"])
        self.assertEqual({(p["os"], p["rust"], p["js"]) for p in result["baasx-platform"]},
                         {("windows-11-arm", False, True), ("windows-latest", False, True)})
        self.assertFalse(result["site"] or result["android"] or result["baasx-source"] or result["readme"])
        rust = classify(["crates/baasx-runtime/src/lib.rs"])
        self.assertEqual(len(rust["baasx-platform"]), 6)
        self.assertTrue(all(p["rust"] and not p["js"] for p in rust["baasx-platform"]))
        self.assertEqual([k for k, run in jobs(rust).items() if run], ["baasx"])
        arm = classify(["src-tauri/src/platform/android/x86_64/adapter.rs"])
        self.assertEqual([target["abi"] for target in arm["android"]], ["x86_64"])
        self.assertFalse(frontend_inputs(["windows"])["bundles"])
        self.assertEqual(frontend_inputs(["android"])["adapters"]["include"], [])

    def test_gate_enforces_exact_results(self):
        for paths in [["docs/content/example.mdx"], ["src/android/App.tsx"], ["crates/baas-cli-runtime/src/lib.rs"]]:
            result = classify(paths)
            expected = {key: {"result": "success" if run else "skipped"} for key, run in jobs(result).items()}
            expected["changes"] = {"result": "success"}
            for docs in (True, False):
                verify(result, expected, docs)
                for name, state in expected.items():
                    if name != "changes" and (name == "docs") != docs:
                        continue
                    for bad in ("failure", "cancelled", None, "skipped" if state["result"] == "success" else "success"):
                        with self.assertRaises(ValueError):
                            verify(result, {**expected, name: {"result": bad}}, docs)
    def test_real_git_diff_and_merge_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            def run(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], text=True).strip()
            run("init","-q","-b","base")
            run("config","user.name","fixture"); run("config","user.email","ci@example.invalid")
            src = Path(tmp,"docs","content","a.mdx"); src.parent.mkdir(parents=True); src.write_text("a")
            run("add","."); run("commit","-qm","base")
            base=run("rev-parse","HEAD")
            run("switch","-qc","feature")
            dst=Path(tmp,"baasx","README.md"); dst.parent.mkdir(); src.rename(dst)
            run("add","-A"); run("commit","-qm","move"); feature=run("rev-parse","HEAD")
            run("switch","-q","base"); run("merge","--no-ff","-qm","merge","feature")
            merge=run("rev-parse","HEAD")
            old=os.getcwd()
            try:
                os.chdir(tmp)
                self.assertCountEqual(changes(base, merge), ["docs/content/a.mdx","baasx/README.md"])
                event={"pull_request":{"base":{"sha":base},"head":{"sha":feature}}}
                for action in ["synchronize","ready_for_review","edited"]:
                    tasks=plan(dict(event,action=action),"pull_request",merge)
                    self.assertTrue(tasks["readme"] and tasks["site"])
                with self.assertRaises(ValueError): plan(event,"pull_request",feature)
                with self.assertRaises(subprocess.CalledProcessError): changes("1"*40,merge)
                run("update-ref", "refs/remotes/origin/base", base)
                first = plan({"before":"0"*40, "after":merge, "repository":{"default_branch":"base"}}, "push", merge)
                self.assertEqual(first, tasks)
            finally:
                os.chdir(old)

    def test_distribution_smoke_is_manual_and_isolated(self):
        selected = plan({"inputs": {"mode": "baasx-package"}}, "workflow_dispatch", "")
        self.assertEqual([name for name, run in jobs(selected).items() if run], ["baasx-package"])
        self.assertFalse(classify(["baasx/src/runtime.ts"])["baasx-package"])

    def test_manual_contract_mode_has_no_platform_jobs(self):
        tasks=plan({"inputs":{"mode":"contracts"}}, "workflow_dispatch","")
        self.assertEqual([k for k,v in jobs(tasks).items() if v],["baasx", "contracts"])


if __name__ == "__main__":
    unittest.main()
