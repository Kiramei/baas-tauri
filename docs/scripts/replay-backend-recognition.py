"""Replay the production co_detect function with deterministic, device-free adapters."""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
from importlib import metadata
import json
from pathlib import Path
import platform
import subprocess
from types import SimpleNamespace
from xml.etree import ElementTree


REVISION = "d0a86a089068766ff53682b501b90bee99857a71"
SOURCES = {
    "pyproject.toml": [],
    "main.py": ["Main"],
    "main.service.py": ["parse_args", "main"],
    "service/app.py": [],
    "service/api/http.py": ["health"],
    "service/api/commands.py": ["execute_command"],
    "service/api/state.py": ["LazyServiceContext"],
    "service/system_logging.py": ["configure_system_logging"],
    "service/conf/resources.py": ["ResourcePathResolver"],
    "service/context.py": ["ServiceContext"],
    "service/runtime.py": ["ServiceRuntime", "ConfigSession", "run_blocking"],
    "service/injection.py": ["apply_startup_injections", "apply_service_injections"],
    "service/image_compat.py": ["install_popup_image_compat"],
    "service/gesture_compat.py": ["install_gesture_compat"],
    "service/asset_compat.py": ["install_asset_compat"],
    "service/android_local_device.py": ["AndroidLocalControl", "AndroidLocalScreenshot"],
    "service/android_ocr_client.py": [],
    "service/conf/initializer.py": ["ConfigInitializer"],
    "service/conf/manager.py": ["ConfigManager"],
    "service/channels/sync.py": ["SyncChannelHandler"],
    "core/Baas_thread.py": ["Baas_thread"],
    "core/scheduler.py": ["Scheduler"],
    "core/picture.py": ["co_detect", "match_img_feature", "deal_with_pop_ups"],
    "core/image.py": ["compare_image", "search_in_area", "screenshot_cut"],
    "core/color.py": ["rgb_in_range", "match_rgb_feature", "wait_loading"],
    "core/position.py": ["init_image_data", "get_area"],
    "core/ocr/ocr.py": ["Baas_ocr"],
    "core/device/Screenshot.py": ["Screenshot"],
    "core/config/default_config.py": [],
    "core/config/config_set.py": ["ConfigSet"],
    "core/config/generated_user_config.py": ["Config"],
    "core/config/generated_static_config.py": ["StaticConfig"],
    "core/utils.py": ["Logger"],
    "core/exception.py": ["FunctionCallTimeout", "RequestHumanTakeOver", "PackageIncorrect"],
    "develop_tools/generate_dataclass_code.py": ["generate_dataclass_code"],
    "deploy/service/requirements.service.windows.txt": [],
    "deploy/service/requirements.service.linux.txt": [],
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verified_sources(backend):
    head = subprocess.check_output(["git", "-C", str(backend), "rev-parse", "HEAD"], text=True).strip()
    if head != REVISION:
        raise ValueError("Review the changed backend revision before regenerating this reference")
    records = []
    for name, symbols in SOURCES.items():
        data = (backend / name).read_bytes().replace(b"\r\n", b"\n")
        committed = subprocess.check_output(["git", "-C", str(backend), "show", REVISION + ":" + name]).replace(b"\r\n", b"\n")
        if data != committed:
            raise ValueError("Uncommitted source change: " + name)
        found = {}
        if name.endswith(".py"):
            tree = ast.parse(data.decode("utf-8"))
            for node in tree.body:
                if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in symbols:
                    found[node.name] = {"line": node.lineno, "endLine": node.end_lineno}
            if set(found) != set(symbols):
                raise ValueError("Source symbol changed: " + name)
        records.append({"file": name, "sha256": sha(data), "gitContentVerified": True, "symbols": found})
    return records


def production_functions(backend):
    namespaces = {}
    for name, selected in [
        ("core/exception.py", {"FunctionCallTimeout", "RequestHumanTakeOver", "PackageIncorrect"}),
        ("core/picture.py", {"co_detect", "match_img_feature"}),
    ]:
        tree = ast.parse((backend / name).read_text(encoding="utf-8"))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in selected]
        if len(nodes) != len(selected):
            raise ValueError("Production function extraction changed")
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
        exec(compile(ast.fix_missing_locations(module), name, "exec"), namespaces)
    return namespaces


CASES = [
    {"id": "end-first", "frames": [{"rgb": {"done": True, "go_rgb": True}}], "expect": "done", "clicks": 0, "captures": 1},
    {"id": "rgb-first", "frames": [{"rgb": {"go_rgb": True}, "image": {"go_image": True}}, {"rgb": {"done": True}}], "expect": "done", "clicks": 1, "captures": 2},
    {"id": "image-fallback", "frames": [{"image": {"go_image": True}}, {"rgb": {"done": True}}], "expect": "done", "clicks": 1, "captures": 2},
    {"id": "repeat-suppressed", "frames": [{"rgb": {"go_rgb": True}}, {"rgb": {"go_rgb": True}}, {"rgb": {"done": True}}], "expect": "done", "clicks": 1, "captures": 3},
    {"id": "popup-fallback", "frames": [{"popup": True}, {"rgb": {"done": True}}], "expect": "done", "clicks": 0, "captures": 2},
    {"id": "tentative-limit", "frames": [{}, {}, {"rgb": {"done": True}}], "kwargs": {"tentative_click": True, "max_fail_cnt": 1}, "expect": "done", "clicks": 1, "captures": 3},
    {"id": "timeout", "frames": [{}, {}], "frameSeconds": 2, "kwargs": {"time_out": 1}, "exception": "FunctionCallTimeout", "clicks": 0, "captures": 2},
    {"id": "stopped", "frames": [{}], "stopped": True, "exception": "RequestHumanTakeOver", "clicks": 0, "captures": 0},
    {"id": "template-end", "frames": [{"image": {"ready": True}, "rgb": {"go_rgb": True}}], "expect": ("ready", 0.91, 12), "clicks": 0, "captures": 1},
    {"id": "negative-action", "frames": [{"rgb": {"go_rgb": True}}, {"rgb": {"done": True}}], "negative": True, "expect": "done", "clicks": 0, "captures": 2},
    {"id": "wrong-package", "frames": [{}, {}], "android": True, "frameSeconds": 2, "kwargs": {"check_pkg_interval": 1}, "exception": "PackageIncorrect", "clicks": 0, "captures": 2},
    {"id": "cached-first", "frames": [{"rgb": {"done": True}}], "kwargs": {"skip_first_screenshot": True}, "expect": "done", "clicks": 0, "captures": 0},
]


def replay(backend, case):
    events = []
    state = {"frame": 0, "seconds": 0.0}

    def record(kind, **values):
        events.append({"kind": kind, "frame": state["frame"], **values})

    def frame():
        return case["frames"][max(0, state["frame"] - 1)]

    def capture():
        state["frame"] += 1
        if state["frame"] > len(case["frames"]):
            raise AssertionError("Unexpected extra recognition iteration")
        state["seconds"] += case.get("frameSeconds", 0.5)
        record("capture")

    def rgb(_context, name):
        result = frame().get("rgb", {}).get(name, False)
        record("rgb", name=name, matched=result)
        return result

    def image(_context, name, threshold=0.8, rgb_diff=20):
        result = frame().get("image", {}).get(name, False)
        record("image", name=name, threshold=threshold, rgbDiff=rgb_diff, matched=result)
        return result

    def popup(*_args):
        result = frame().get("popup", False)
        record("popup", matched=result)
        return result

    def sleep(seconds):
        record("sleep", seconds=seconds)
        state["seconds"] += seconds

    def package():
        record("package", expected=False)
        return "other.game"

    def click(x, y):
        record("click", x=x, y=y)

    ns = production_functions(backend)
    ns.update(time=SimpleNamespace(time=lambda: state["seconds"], sleep=sleep),
              color=SimpleNamespace(match_rgb_feature=rgb, wait_loading=lambda _context: record("loading")),
              match_rgb_feature=rgb, image=SimpleNamespace(compare_image=image), deal_with_pop_ups=popup)
    context = SimpleNamespace(flag_run=not case.get("stopped", False), is_android_device=case.get("android", False),
                              update_screenshot_array=capture, logger=SimpleNamespace(info=lambda _message: None),
                              click=click, screenshot_interval=0.3, connection=SimpleNamespace(get_current_package=package),
                              package_name="expected.game")
    kwargs = dict(rgb_ends=["done"], img_ends=[("ready", 0.91, 12)],
                  rgb_reactions={"go_rgb": (-1, -1) if case.get("negative") else (100, 200)},
                  img_reactions={"go_image": (300, 400, 0.85, 15)})
    kwargs.update(case.get("kwargs", {}))
    try:
        value = ns["co_detect"](context, **kwargs)
    except (ns["FunctionCallTimeout"], ns["RequestHumanTakeOver"], ns["PackageIncorrect"]) as error:
        outcome = {"kind": "exception", "value": type(error).__name__}
        assert outcome["value"] == case.get("exception"), case["id"]
    else:
        outcome = {"kind": "return", "value": value}
        assert value == case.get("expect"), case["id"]
    record(outcome["kind"], value=outcome["value"])
    clicks = [event for event in events if event["kind"] == "click"]
    assert len(clicks) == case["clicks"], case["id"]
    assert state["frame"] == case["captures"], case["id"]
    if case["id"] == "rgb-first":
        assert all(event.get("name") != "go_image" for event in events)
        assert clicks[0]["x"] == 100
    if case["id"] == "image-fallback":
        assert clicks[0]["x"] == 300
    if case["id"] == "tentative-limit":
        assert clicks[0]["frame"] == 2
        assert any(event["kind"] == "sleep" and event["seconds"] == 1.5 for event in events)
    return {"id": case["id"], "inputs": {"frames": case["frames"], "options": case.get("kwargs", {}),
            "initiallyStopped": case.get("stopped", False), "androidPackageProbe": case.get("android", False),
            "negativeActionCoordinates": case.get("negative", False), "secondsPerCapture": case.get("frameSeconds", 0.5)},
            "events": events, "outcome": outcome, "clickRequests": len(clicks), "captures": state["frame"], "verified": True}


def publish_validation(root, backend, snapshot, junit, source_records, replay_file):
    tree = ElementTree.parse(junit)
    tests = tree.findall(".//testcase")
    failures = tree.findall(".//failure") + tree.findall(".//error")
    if not tests or failures:
        raise ValueError("Backend validation has no successful complete test run")
    test_files = {"tests/conftest.py"}
    skipped = []
    for test in tests:
        name = test.get("classname").replace(".", "/") + ".py"
        test_files.add(name)
        if test.find("skipped") is not None:
            skipped.append({"test": test.get("name"), "reason": test.find("skipped").get("message")})
    files = []
    for name in sorted(test_files | set(SOURCES)):
        data = (snapshot / name).read_bytes().replace(b"\r\n", b"\n")
        expected = subprocess.check_output(["git", "-C", str(backend), "show", REVISION + ":" + name]).replace(b"\r\n", b"\n")
        if data != expected:
            raise ValueError("Tested snapshot differs from the pinned source: " + name)
        files.append({"file": name, "sha256": sha(data)})
    packages = {}
    for name in ["pytest", "httpx", "httpx2", "fastapi", "pydantic", "numpy", "opencv-python", "av", "adbutils", "uiautomator2"]:
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "backendRevision": REVISION,
              "scope": "Backend service suite, core task retry and OCR tests in a separate Git archive; test doubles and temporary state, not real-game execution or a fresh dependency installation",
              "pythonVersion": platform.python_version(), "packages": packages,
              "junitSha256": sha(junit.read_bytes()), "recognitionReplaySha256": sha(replay_file.read_bytes()),
              "collected": len(tests), "passed": len(tests) - len(skipped), "failed": len(failures), "skipped": skipped,
              "verifiedSnapshotFiles": files, "auditedSourceFiles": len(source_records)}
    (root / "docs/evidence/backend-development-validation.json").write_bytes((json.dumps(report, indent=2) + "\n").encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend", type=Path)
    parser.add_argument("--tested-source", type=Path)
    parser.add_argument("--junit", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    source_records = verified_sources(args.backend)
    cases = [replay(args.backend, case) for case in CASES]
    generated = datetime.now(timezone.utc).isoformat()
    report = {"generatedAt": generated, "backendRevision": REVISION, "scriptSha256": sha(Path(__file__).read_bytes().replace(b"\r\n", b"\n")),
              "method": "Unmodified production co_detect and match_img_feature AST compiled without module imports; deterministic matcher, frame, clock, popup and input adapters. No image recognition engine, real device, game, network or timing measurement.",
              "sources": source_records, "cases": cases}
    destination = root / "docs/public/developer/recognition-replay.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    if bool(args.tested_source) != bool(args.junit):
        parser.error("--tested-source and --junit are required together")
    if args.junit:
        publish_validation(root, args.backend, args.tested_source, args.junit, source_records, destination)
    print(json.dumps({"cases": len(cases), "sourceFiles": len(source_records), "deviceInputSent": False}))


if __name__ == "__main__":
    main()
