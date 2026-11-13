"""Map changed paths to their owners, then check the results of those jobs."""
import argparse
import fnmatch
import json
import os
import re
import subprocess
from pathlib import Path

from shared_inputs import shared_owners

ROOT = Path(__file__).resolve().parents[2]
DISTRIBUTIONS = json.loads((ROOT / "baasx/scripts/distribution-platforms.json").read_text())
HOST_OS = {"win32": "windows", "darwin": "macos", "linux": "linux"}
RUST_SUFFIX = {"windows": "pc-windows-msvc", "macos": "apple-darwin", "linux": "unknown-linux-gnu"}
CPU = {"x64": "x86_64", "arm64": "aarch64", "x86": "i686"}
DESKTOP = ("windows", "linux", "macos")
UI = {"ui:webui", "ui:tauri", "ui:android"}
NATIVE = {"native:" + os_name for os_name in DESKTOP}
ANDROID = {"android:arm64", "android-tests"}
BAASX_NATIVE = {"baasx-native:" + os_name for os_name in DESKTOP}
JS = {"baasx-source"}
CONTRACTS = {"contracts"}
REGISTRY = {"registry"}

# First matching ownership rule wins. Markdown is handled first in owners().
RULES = [
    ((".github/workflows/docs-validation.yml", ".github/workflows/wiki-pages.yml", "docs/*"), {"site"}),
    (("public/docs/*", "baasx/docs/*"), {"readme"}),
    (("baasx/scripts/distribution-platforms.*",), REGISTRY | BAASX_NATIVE),
    (("baasx/registry/*", "baasx/scripts/*registry*", "baasx/tests/registry-*"), REGISTRY),
    (("baasx/packages/baas-client/src/SecureWebSocket.ts", "src/shared/SweepPlan.ts",
      "src/shared/SweepCounts.ts", "src/shared/ExplorePlan.ts", "src/features/rewardedTaskConfig.ts"), JS | UI),
    (("baasx/src/runtime.ts", "baasx/tests/runtime.test.ts", "baasx/tests/*pty*", "baasx/src/terminal.ts"),
     {"baasx-js:" + name for name in DESKTOP}),
    (("baasx/scripts/build.ts", "baasx/bin/*", "baasx/package.json"), JS | REGISTRY),
    (("baasx/*",), JS),
    (("crates/baas-cli-runtime/*",), BAASX_NATIVE),
    (("crates/baas-updater/src/android*",), ANDROID),
    (("crates/baas-updater/src/app.rs",), NATIVE),
    (("crates/baas-updater/runtime/shm_macos.py",), {"native:macos", "baasx-native:macos"}),
    (("crates/baas-updater/src/environ*", "crates/baas-updater/src/workflow*", "crates/baas-updater/src/mirrorc*",
      "crates/baas-updater/tests/mirrorc*"), NATIVE | BAASX_NATIVE),
    (("crates/baas-term/src/renderer.rs",), NATIVE | ANDROID),
    (("crates/baas-updater/*", "crates/baas-term/*", "Cargo.toml", "Cargo.lock", ".cargo/*", "rust-toolchain*"), NATIVE | ANDROID | BAASX_NATIVE),
    (("crates/baas-shortcut/*",), NATIVE),
    (("crates/baas-notifier/*", "crates/baas-i18n/*"), NATIVE | ANDROID),
    (("scripts/tests/test_android*", "src-tauri/tests/android_*", "src-tauri/gen/android/app/src/main/python/*"), {"android-tests"}),
    (("src-tauri/src/android*", "src-tauri/src/mobile*", "src-tauri/gen/android/*", "src-tauri/tauri.android*",
      "src-tauri/capabilities/android*", "src-tauri/icons/android/*",
      "scripts/android-build*", "scripts/android-script-utils*", "scripts/prepare-android-runtime*",
      "scripts/tests/android*", "scripts/android-dev-hot*", "scripts/android-smoke*"), ANDROID),
    (("tests/fixtures/transport_echo_peer.py", "src-tauri/src/main.rs", "src-tauri/src/commands.rs", "src-tauri/src/shm_native.rs", "src-tauri/src/shm_protocol.rs",
      "src-tauri/capabilities/default.json", "src-tauri/examples/*", "src-tauri/tests/client_release_version.rs"), NATIVE),
    (("src-tauri/src/window_material.rs", "src-tauri/icons/*.ico", "src-tauri/icons/Square*", "src-tauri/icons/StoreLogo*",
      "scripts/portable-fixed-webview2*"), {"native:windows"}),
    (("src-tauri/icons/*macos*", "src-tauri/icons/*.icns", "scripts/*macos*", "scripts/tests/test_macos*"), {"native:macos"}),
    (("src-tauri/*",), NATIVE | ANDROID),
    (("scripts/android-css*", "src/android/*", "src/shared/Android*", "tests/frontend/*Android*", "tests/frontend/MobileNavigation*", "src/components/Android*", "tsconfig.ci.android.json"), {"ui:android"}),
    (("src/App.tsx", "src/platform/App.tsx", "src/platform/startup.ts", "src/pages/SettingsPage.tsx", "tsconfig.ci.desktop.json"), {"ui:webui", "ui:tauri"}),
    (("tests/frontend/CiPolicy.test.ts", "tests/frontend/ReleasePublishing.test.ts", "tests/frontend/ReleaseWorkflows.test.ts"), CONTRACTS),
    (("src/*", "tests/frontend/*", "tests/browser/*", "public/*", "index.html", "components.json",
      "vite.config.*", "tsconfig*.json", "scripts/vite/*", "scripts/i18n*", "scripts/*font*",
      "scripts/fonts-src/*", "scripts/*log-batching*", "scripts/benchmark-pipe*", "scripts/appearance*",
      "scripts/live-game*", "scripts/webkit*", ".github/actions/*font*/*"), UI),
    (("package.json", "bun.lock", "eslint.config.*"), UI | JS),
    (("scripts/docker/*", "scripts/tests/test_docker*"), {"docker"}),
    ((".github/actions/setup-linux-arm/*",), {"native:linux:armv7", "native:linux:arm64"}),
    ((".github/workflows/baasx-checks.yml", ".github/actions/setup-baasx/*"), JS | REGISTRY | BAASX_NATIVE),
    ((".github/workflows/client-native.yml", ".github/actions/setup-tauri-build-env/*"), NATIVE | ANDROID),
    ((".github/workflows/client-frontend.yml", "scripts/ci/client-frontend.mjs", "scripts/ci/build-frontend-adapter.mjs", "scripts/ci/test_client_frontend.py"), UI | {"ui:" + name for name in DESKTOP}),
    ((".github/workflows/baasx.yml", ".github/workflows/release-baasx.yml"), CONTRACTS | REGISTRY),
    ((".github/actions/setup-bun-deps/*",), UI | JS),
    (("scripts/ci/*", ".github/workflows/*", ".github/actions/*", "scripts/*updat*", "scripts/*release*",
      "scripts/audit-archived-shm.py", "scripts/backend-smoke.py", "scripts/prepare-local-preview.py"), CONTRACTS),
    ((".github/*", ".git*", ".prettier*", "renovate.json", "LICENSE"), set()),
]


def owners(path):
    if path.startswith("docs/content/"):
        return {"site"}
    if path.lower().endswith((".md", ".mdx")) or path.rsplit("/", 1)[-1] == "LICENSE":
        return {"readme"}
    # OS/architecture directories take precedence over their parent module.
    for name in (*DESKTOP, "android", "desktop", "posix"):
        systems = {"desktop": DESKTOP, "posix": ("linux", "macos")}.get(name, (name,))
        for base, layer in (("src/platform/", "ui"), ("tests/frontend/platform/", "ui"),
                            ("baasx/src/platform/", "baasx-js"), ("baasx/tests/platform/", "baasx-js"),
                            ("crates/baas-cli-runtime/src/platform/", "baasx-native"),
                            ("crates/baas-notifier/src/platform/", "native"),
                            ("src-tauri/src/platform/", "native")):
            prefix = base + name + "/"
            if path.startswith(prefix) or path == base + name + ".rs":
                if layer.startswith("baasx-") and name == "android":
                    raise ValueError(f"No Android BAASX distribution for {path!r}")
                arch = path.removeprefix(prefix).split("/", 1)[0]
                if layer == "ui":
                    return {"ui:" + ("tauri" if name == "desktop" else os_name) for os_name in systems}
                if name == "android":
                    return {"android:" + arch, "android-tests"} if arch in ANDROID_TARGETS else ANDROID
                if arch in (*CPU, "armv7"):
                    supported = {HOST_OS[row["os"]] + ":" + row["cpu"] for row in DISTRIBUTIONS}
                    if layer == "native":
                        supported.update(("windows:x86", "linux:armv7"))
                    if any(system + ":" + arch not in supported for system in systems):
                        raise ValueError(f"No {layer} target for {path!r}")
                    return {f"{layer}:{system}:{arch}" for system in systems}
                return {f"{layer}:{system}" for system in systems}
    for name in DESKTOP:
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in (
                f"src-tauri/src/shm_native/{name}.rs", f"src-tauri/src/shm_{name}.rs",
                f"src-tauri/packages/{name}/*", f"src-tauri/tauri.{name}.*")):
            return {"native:" + name}
    for prefix, mode in (("Windows", "windows"), ("Linux", "linux"), ("Mac", "macos")):
        if path.startswith("tests/frontend/" + prefix):
            return {"ui:" + mode}
    if path.startswith("src-tauri/webview2."):
        arch = path.split(".")[1]
        if arch not in CPU:
            raise ValueError(f"Unknown WebView2 architecture in {path!r}")
        return {"native:windows:" + arch}
    for patterns, tasks in RULES:
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns):
            return tasks
    raise ValueError(f"No CI owner for {path!r}. Register this input in scripts/ci/impact.py.")


ANDROID_TARGETS = {"arm64": ("aarch64-linux-android", "Arm64"), "x86_64": ("x86_64-linux-android", "X86_64"),
                   "arm": ("armv7-linux-androideabi", "Arm"), "x86": ("i686-linux-android", "X86")}


def classify(paths, full=False, revisions=None):
    scopes = set()
    for path in paths:
        resolved = shared_owners(path, *revisions) if revisions else None
        scopes.update(owners(path) if resolved is None else resolved)
    if full:
        scopes |= UI | NATIVE | ANDROID | BAASX_NATIVE | JS | REGISTRY | CONTRACTS | {"site", "readme", "docker"}
        scopes.update("ui:" + name for name in DESKTOP)
    modes = sorted(key[3:] for key in scopes if key.startswith("ui:"))
    native, baasx = [], []
    for row in DISTRIBUTIONS:
        name, arch, runner = HOST_OS[row["os"]], row["cpu"], row["runner"]
        # Common desktop Rust is tested on a representative host per OS. ABI-specific
        # code is tested on its actual target. All shipped BAASX helper ABIs run natively.
        primary = arch == ("arm64" if name == "macos" else "x64")
        if f"native:{name}:{arch}" in scopes or (primary and "native:" + name in scopes):
            native.append(dict(os=runner, target=CPU[arch] + "-" + RUST_SUFFIX[name]))
        rust = "baasx-native:" + name in scopes or f"baasx-native:{name}:{arch}" in scopes
        js = "baasx-js:" + name in scopes or f"baasx-js:{name}:{arch}" in scopes
        if rust or js:
            baasx.append(dict(os=runner, rust=rust, js=js))
    if "native:linux:armv7" in scopes:
        native.append(dict(os="ubuntu-22.04", target="armv7-unknown-linux-gnueabihf"))
    if "native:windows:x86" in scopes:
        native.append(dict(os="windows-latest", target="i686-pc-windows-msvc"))
    android = [dict(abi=abi, target=target, gradle=gradle) for abi, (target, gradle) in ANDROID_TARGETS.items()
               if "android:" + abi in scopes]
    return {"baasx-package": False, "frontend": modes, "desktop": native, "android": android, "android-tests": "android-tests" in scopes,
            "baasx-source": "baasx-source" in scopes, "baasx-platform": baasx, "registry": "registry" in scopes,
            "site": "site" in scopes, "readme": "readme" in scopes, "contracts": "contracts" in scopes, "docker": "docker" in scopes}


def git(*args):
    return subprocess.check_output(["git", *args])


def changes(base, head):
    if not all(re.fullmatch(r"[0-9a-f]{40,64}", sha) for sha in (base, head)):
        raise ValueError("expected immutable Git object IDs")
    return [os.fsdecode(p) for p in git("diff", "--no-renames", "--name-only", "-z", base, head, "--").split(b"\0") if p]


def diff_plan(base, head):
    return classify(changes(base, head), revisions=(base, head))


def plan(event, event_name, head):
    if event_name == "workflow_dispatch":
        mode = event["inputs"]["mode"]
        if mode == "full":
            return classify([], full=True)
        if mode == "baasx-package":
            result = classify([])
            result["baasx-package"] = True
            return result
        if mode == "contracts":
            return classify(["scripts/ci/impact.py", "baasx/registry/baasx.mjs"])
        if mode == "changes":
            return diff_plan(git("rev-parse", head + "^1").decode().strip(), head)
        raise ValueError("unknown dispatch mode")
    if event_name == "pull_request":
        pr = event["pull_request"]
        base = pr["base"]["sha"]
        if git("show", "-s", "--format=%P", head).decode().split() != [base, pr["head"]["sha"]]:
            raise ValueError("checkout does not match the PR merge parents")
    elif event_name == "push" and event["after"] == head:
        base = event["before"]
        if not base.strip("0"):
            base = git("merge-base", head, "origin/" + event["repository"]["default_branch"]).decode().strip()
    else:
        raise ValueError("unsupported event or unexpected checkout")
    return diff_plan(base, head)


def frontend_inputs(modes):
    runners = dict(windows="windows-latest", linux="ubuntu-24.04", macos="macos-latest")
    return {"bundles": any("ui:" + mode in UI for mode in modes),
            "adapters": {"include": [dict(mode=mode, os=runners[mode]) for mode in modes if mode in runners]}}


def jobs(plan):
    return {"baasx-package": plan["baasx-package"], "frontend": bool(plan["frontend"]), "client-native": bool(plan["desktop"] or plan["android"] or plan["android-tests"]),
            "baasx": bool(plan["baasx-source"] or plan["baasx-platform"] or plan["registry"]),
            "docs": plan["site"] or plan["readme"], "contracts": plan["contracts"], "docker": plan["docker"]}


def verify(plan, needs, docs=False):
    if needs.get("changes", {}).get("result") != "success":
        raise ValueError("change detection did not succeed")
    for name, run in jobs(plan).items():
        if (name == "docs") == docs:
            expected = "success" if run else "skipped"
            actual = needs.get(name, {}).get("result")
            if actual != expected:
                raise ValueError(f"{name}: expected {expected}, got {actual}")


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
        print(json.dumps(diff_plan(*args.refs), indent=2))
        return
    result = plan(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()), os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_SHA"])
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for key, value in {**jobs(result), **frontend_inputs(result["frontend"]), "plan": result}.items():
            print(f"{key}={json.dumps(value, separators=(',', ':'))}", file=stream)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        print("Selected modules and targets\n\n```json\n" + json.dumps(result, indent=2) + "\n```", file=stream)


if __name__ == "__main__":
    main()
