import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from impact import ALL, classify, changes, jobs, plan, verify


class Routing(unittest.TestCase):
    def test_consumers(self):
        examples = [
            ("baasx/README_zh.md", {"cli-package"}),
            ("baasx/release-notes/0.1.4.md", {"cli-package"}),
            ("docs/components/ReleaseDownloadPanel.tsx", {"docs"}),
            ("docs/content/docs/en/foo.mdx", {"docs"}),
            (".github/actions/notify-qq/action.yml", {"contracts"}),
            (".github/actions/sync-cnb-release/action.yml", {"contracts"}),
            (".github/workflows/sync-cnb.yml", {"contracts"}),
            (".github/workflows/source-dispatch.yml", {"contracts"}),
            ("src/android/pages/SettingsPage.tsx", {"android-ui", "docs"}),
            ("src/shared/ConfigurationSections.ts", {"cli-source","docs","android-ui","webui","tauri"}),
            ("baasx/src/workspace.ts", {"cli-source","cli-package","cli-windows"}),
            ("baasx/scripts/build.ts", {"cli-source","cli-package","cli-linux","cli-macos","cli-windows"}),
            ("crates/baas-cli-runtime/src/lib.rs", {"cli-source","cli-package","cli-linux","cli-macos","cli-windows"}),
            ("src-tauri/packages/windows/test.nsh", {"windows","contracts"}),
            ("src-tauri/packages/macos/test.plist", {"macos","contracts"}),
            ("src-tauri/gen/android/app/build.gradle.kts", {"android","android-tests","docs"}),
            (".github/actions/setup-tauri-build-env/action.yml", {"linux","windows","macos","android","android-tests","contracts"}),
            ("crates/baas-notifier/src/lib.rs", {"linux","macos","windows","android","android-tests"}),
            ("Cargo.lock", ALL), ("future/build.input", ALL),
        ]
        for path, expected in examples:
            with self.subTest(path=path):
                tasks, _ = classify([path])
                self.assertEqual({key for key, value in tasks.items() if value}, expected)

    def test_gate_enforces_exact_results(self):
        for paths in [["docs/index.mdx"], ["unknown"], ["baasx/README.md"]]:
            tasks, _ = classify(paths)
            done = {key: {"result": "success" if run else "skipped"} for key, run in jobs(tasks).items()}
            done["changes"] = {"result": "success"}
            for docs in [True, False]:
                verify(tasks, done, docs)
                for job, state in done.items():
                    if job != "changes" and (job == "static-export") != docs:
                        continue
                    for broken in ["failure", "cancelled", None, "skipped" if state["result"] == "success" else "success"]:
                        invalid = {**done, job: {"result": broken}}
                        with self.assertRaises(ValueError):
                            verify(tasks, invalid, docs)
                with self.assertRaises(ValueError):
                    verify({}, done, docs)

    def test_real_git_diff_and_merge_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            def run(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], text=True).strip()
            run("init","-q","-b","base")
            run("config","user.name","fixture"); run("config","user.email","ci@example.invalid")
            src = Path(tmp,"docs","a.mdx"); src.parent.mkdir(); src.write_text("a")
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
                self.assertCountEqual(changes(base, merge), ["docs/a.mdx","baasx/README.md"])
                event={"pull_request":{"base":{"sha":base},"head":{"sha":feature}}}
                for action in ["synchronize","ready_for_review","edited"]:
                    tasks,_=plan(dict(event,action=action),"pull_request",merge)
                    self.assertTrue(tasks["docs"] and tasks["cli-package"])
                with self.assertRaises(ValueError): plan(event,"pull_request",feature)
                with self.assertRaises(subprocess.CalledProcessError): changes("1"*40,merge)
                self.assertTrue(all(plan({"before":"0"*40,"after":merge},"push",merge)[0].values()))
            finally:
                os.chdir(old)

    def test_manual_contract_mode_has_no_platform_jobs(self):
        tasks,_=plan({"inputs":{"mode":"contracts"}}, "workflow_dispatch","")
        self.assertEqual([k for k,v in jobs(tasks).items() if v],["contracts"])


if __name__ == "__main__":
    unittest.main()
