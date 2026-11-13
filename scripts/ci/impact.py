"""Plan CI from complete Git tree differences and verify the resulting jobs."""
import argparse
import fnmatch
import json
import os
import re
import subprocess
from pathlib import Path

PLATFORMS = ("linux", "windows", "macos")
RUNNERS = dict(linux="ubuntu-22.04", windows="windows-latest", macos="macos-latest")
TARGETS = dict(linux="x86_64-unknown-linux-gnu", windows="x86_64-pc-windows-msvc", macos="aarch64-apple-darwin")
TASKS = ("contracts", "cli-source", "cli-package", "docs", "android", "android-tests",
         "webui", "tauri", "android-ui", *PLATFORMS, *("cli-" + p for p in PLATFORMS))
DESKTOP = set(PLATFORMS)
CLI_PLATFORMS = {"cli-" + p for p in PLATFORMS}
UI = {"webui", "tauri", "android-ui"}
CLI = {"cli-source", "cli-package"}
ALL = set(TASKS)


def matching(path, *patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def impact(path):
    """Return verification consumers, including documentation source audits."""
    # Repository docs tests resolve these CI declarations and compiler/package contracts.
    if matching(path, ".github/workflows/docs-validation.yml", ".github/workflows/wiki-pages.yml"):
        return {"docs", "contracts"}
    if path.startswith("docs/development/"):
        return {"contracts"}
    if path.startswith("docs/"):
        return {"docs"}
    if matching(path, "baasx/README*.md", "baasx/LICENSE", "baasx/release-notes/*"):
        return {"cli-package"}
    if path in {"README.md", "README_zh.md"}:
        return {"contracts", "docs"}  # docs/tests/readme-links.test.ts
    if matching(path, ".github/actions/notify-qq/*", ".github/actions/sync-*/*",
                ".github/actions/check-release-tag/*", ".github/workflows/release-*.yml",
                ".github/workflows/sync-cnb.yml", ".github/workflows/main-source-guard.yml",
                "scripts/*release*.mjs", "scripts/*updater*.mjs", "scripts/*update-log*",
                "scripts/ci/release*", "UPDATE.md"):
        return {"contracts"}
    if matching(path, ".github/workflows/cli.yml", ".github/actions/setup-baasx/*"):
        return CLI | CLI_PLATFORMS | {"contracts"}
    if matching(path, ".github/actions/setup-tauri-build-env/*"):
        return DESKTOP | {"android", "android-tests", "contracts"}
    if matching(path, ".github/actions/*font*/*", "scripts/font-*", "scripts/*font-build*",
                "public/fonts/*"):
        return UI | {"android", "android-tests", "contracts"}
    if matching(path, "Cargo.*", ".cargo/*", "rust-toolchain*", ".github/workflows/code-quality.yml",
                "scripts/ci/*", ".github/actions/setup-bun-deps/*"):
        return ALL
    if matching(path, "baasx/packages/*", "baasx/bin/*", "baasx/registry/*",
                "baasx/scripts/*", "baasx/package.json", "baasx/src/runtime.ts",
                "baasx/src/node-entry.ts", "baasx/src/terminal*", "baasx/tests/*pty*",
                "baasx/tests/*binary*", "baasx/tests/*node-bundle*"):
        return CLI | CLI_PLATFORMS | ({"contracts"} if path == "baasx/package.json" else set())
    if matching(path, "baasx/src/workspace.ts", "baasx/src/index.ts", "baasx/src/configuration.ts", "baasx/src/activity-motion.ts"):
        return CLI | {"cli-windows"}
    if path.startswith("baasx/"):
        return CLI
    if path.startswith("crates/baas-cli-runtime/"):
        return CLI | CLI_PLATFORMS
    if matching(path, "crates/baas-updater/src/android*", "src-tauri/src/android*",
                "src-tauri/src/mobile*", "src-tauri/gen/android/*", "src-tauri/tauri.android*",
                "scripts/android-*", "scripts/prepare-android*", "scripts/tests/test_android*"):
        return {"android", "android-tests", "docs"}
    if path.startswith("crates/"):
        crate = path.split("/")[1]
        if crate in ("baas-updater", "baas-term"):
            return DESKTOP | CLI_PLATFORMS | {"android", "android-tests", "docs"}
        if crate == "baas-notifier":
            return DESKTOP | {"android", "android-tests"}
        if crate == "baas-shortcut":
            return DESKTOP
        if crate == "baas-i18n":
            return DESKTOP | {"android", "android-tests"}
        return ALL
    if matching(path, "src-tauri/src/*windows*.rs"):
        return {"windows", "docs"}
    if matching(path, "src-tauri/src/*macos*.rs"):
        return {"macos", "docs"}
    if matching(path, "src-tauri/src/*linux*.rs"):
        return {"linux", "docs"}
    if matching(path, "src-tauri/packages/windows/*", "src-tauri/tauri.windows.*", "src-tauri/webview2*"):
        return {"windows", "contracts"}
    if matching(path, "src-tauri/packages/macos/*", "src-tauri/tauri.macos.*", "scripts/*macos*"):
        return {"macos", "contracts"}
    if matching(path, "src-tauri/packages/linux/*", "src-tauri/tauri.linux.*"):
        return {"linux", "contracts"}
    if path.startswith("src-tauri/"):
        return DESKTOP | {"android", "android-tests", "docs"}
    if matching(path, "package.json", "bun.lock", "tsconfig*", "vite.config.*", "eslint.config.*"):
        return UI | CLI | CLI_PLATFORMS | {"docs", "android", "android-tests", "contracts"}
    if path.startswith("src/android/"):
        return {"android-ui", "docs"}
    if path.startswith("src/platform/"):
        return {"webui", "tauri", "docs"}
    if matching(path, "src/shared/*", "src/features/rewardedTaskConfig.ts", "public/locales/*"):
        return UI | {"cli-source", "docs"}
    if matching(path, "src/*", "tests/frontend/*", "tests/browser/*", "public/*",
                "index.html", "scripts/i18n*", "components.json"):
        return UI | {"docs"}
    if matching(path, "scripts/docker/*", "scripts/tests/test_docker*"):
        return {"contracts", "webui"}
    if matching(path, "*.md", "LICENSE", ".gitignore", ".gitattributes", "renovate.json",
                ".github/renovate.json", ".github/ISSUE_TEMPLATE/*", ".prettier*"):
        return {"contracts"}
    return ALL


def classify(paths, full=False):
    reasons = {task: [] for task in TASKS}
    for path in paths:
        for task in impact(path):
            if len(reasons[task]) < 4:
                reasons[task].append(path)
    if full:
        reasons = {task: ["full verification"] for task in TASKS}
    return {k: bool(v) for k, v in reasons.items()}, reasons


def git(*args):
    return subprocess.check_output(["git", *args])


def changes(base, head):
    # --no-renames exposes both source and destination even across component boundaries.
    if not all(re.fullmatch(r"[0-9a-f]{40,64}", value) for value in [base, head]):
        raise ValueError("expected immutable Git object IDs")
    raw = git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
    return [os.fsdecode(path) for path in raw.split(b"\0") if path]


def plan(event, event_name, head):
    full = False
    if event_name == "pull_request":
        pr = event["pull_request"]
        base = pr["base"]["sha"]
        # The tested checkout is GitHub's synthetic merge commit, including a refreshed base.
        parents = git("show", "-s", "--format=%P", head).decode().strip().split()
        if parents != [base, pr["head"]["sha"]]:
            raise ValueError("checkout does not match the PR merge parents")
    elif event_name == "push":
        base = event["before"]
        full = not base.strip("0")
        if event["after"] != head:
            raise ValueError("push SHA differs from checkout")
    elif event_name == "workflow_dispatch":
        return classify([".github/workflows/release-app.yml"], full=event["inputs"].get("mode", "full") == "full")
    else:
        raise ValueError("unsupported event")
    return classify([] if full else changes(base, head), full=full)


def jobs(tasks):
    return {"contracts": tasks["contracts"] or tasks["cli-package"],
            "generate-fonts": any(tasks[t] for t in (*UI, "android")),
            "frontend": any(tasks[t] for t in UI), "android-tests": tasks["android-tests"],
            "desktop-rust": any(tasks[t] for t in DESKTOP), "android": tasks["android"],
            "cli-source": tasks["cli-source"], "cli-platform": any(tasks[t] for t in CLI_PLATFORMS),
            "static-export": tasks["docs"]}


def verify(tasks, needs, docs=False):
    if needs.get("changes", {}).get("result") != "success":
        raise ValueError("change detection did not succeed")
    if set(tasks) != set(TASKS) or not all(type(value) is bool for value in tasks.values()):
        raise ValueError("incomplete change plan")
    for job, expected in jobs(tasks).items():
        if (job == "static-export") != docs:
            continue
        actual = needs.get(job, {}).get("result")
        wanted = "success" if expected else "skipped"
        if actual != wanted:
            raise ValueError(f"{job}: expected {wanted}, got {actual}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["plan", "gate", "replay"])
    parser.add_argument("refs", nargs="*")
    parser.add_argument("--docs", action="store_true")
    args = parser.parse_args()
    if args.action == "gate":
        verify(json.loads(os.environ["PLAN"]), json.loads(os.environ["NEEDS"]), args.docs)
        return
    if args.action == "replay":
        tasks, reasons = classify(changes(*args.refs))
    else:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        tasks, reasons = plan(event, os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_SHA"])
    print(json.dumps(tasks))
    if args.action == "replay":
        return
    selected = jobs(tasks)
    outputs = {**selected, "plan": tasks,
               "rust-matrix": {"include": [dict(name=p, os=RUNNERS[p], target=TARGETS[p])
                                          for p in PLATFORMS if tasks[p]]},
               "cli-matrix": {"os": [RUNNERS[p] for p in PLATFORMS if tasks["cli-" + p]]}}
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        for job, value in outputs.items():
            print(f"{job}={json.dumps(value, separators=(',', ':'))}", file=f)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
        print("### Verification for `" + os.environ["GITHUB_SHA"] + "`\n\n```json", file=f)
        # Escaping backticks and embedded newlines keeps untrusted filenames inside the JSON block.
        print(json.dumps({k: v or "no matching inputs" for k, v in reasons.items()},
                         indent=2, ensure_ascii=True).replace("`", "\\u0060"), file=f)
        print("```", file=f)


if __name__ == "__main__":
    main()
