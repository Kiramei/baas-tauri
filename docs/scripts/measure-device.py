import argparse
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from http.client import HTTPConnection
import importlib.metadata
import io
import json
import logging
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
TARGET = "io.github.kiramei.baas_docs_benchmark"
DEMO = "io.github.kiramei.baas_tauri.docs.x86"
OWNED_APKS = {
    DEMO: "cba686bc44dc5a46c842674da13fc23d2676505200dafab8bf7241377bcd1fc5",
    "io.github.kiramei.baas_tauri.docs": "b67e1559e342a3025a25904d73d11e0639f734cbd06a59195c5ad9bb0ce08606",
}
METHODS = ["adb", "uiautomator2", "scrcpy", "nemu"]
ORDERS = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]]
AGENT = "/data/local/tmp/baas-docs-atx-agent"
JAR = "/data/local/tmp/scrcpy-server.jar"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode_frame(image, token=None):
    if image is None or image.shape != (720, 1280, 3) or image.dtype != np.uint8:
        raise ValueError("invalid-frame-shape-or-type")

    def patch(x, y):
        return np.median(image[y - 2:y + 3, x - 2:x + 3], axis=(0, 1))

    if np.abs(patch(32, 32) - [255, 0, 255]).mean() > 30:
        raise ValueError("target-fiducial-missing")
    colors = np.array([patch(x, 32) for x in [112, 172, 232]])
    expected = np.array([[0, 0, 255], [0, 255, 0], [255, 0, 0]])
    errors = [float(np.abs(colors - expected).mean()), float(np.abs(colors[:, ::-1] - expected).mean())]
    if min(errors) > 30:
        raise ValueError("color-calibration-failed")
    values = []
    for y in [105, 165, 225, 285]:
        levels = [float(patch(56 + 72 * bit, y).mean()) for bit in range(16)]
        if any(75 < level < 190 for level in levels):
            raise ValueError("ambiguous-barcode")
        values.append(sum(1 << bit for bit, value in enumerate(levels) if value > 128))
    if token is not None and values[0] != token:
        raise ValueError("stale-target-token")
    return {"token": values[0], "inputs": values[1], "frame": values[2],
            "durationMs": values[3], "channelOrder": "BGR" if errors[0] <= errors[1] else "RGB",
            "colorMeanAbsoluteError": min(errors)}


def processes(device):
    result = {}
    for line in device.shell(["ps", "-A", "-o", "PID,ARGS"]).splitlines()[1:]:
        parts = line.strip().split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit():
            result[int(parts[0])] = parts[1]
    return result


def is_owned_agent(device, pid, command):
    if not command.startswith((AGENT + " server", "baas-docs-atx-agent server")):
        return False
    return device.shell(["readlink", "/proc/" + str(pid) + "/exe"]).strip() == AGENT


def package_hash(device, package):
    paths = [line[8:] for line in device.shell(["pm", "path", package]).splitlines()
             if line.startswith("package:")]
    if len(paths) != 1:
        raise RuntimeError("expected-single-owned-apk")
    value = device.shell(["sha256sum", paths[0]]).split()[0].lower()
    if not re.fullmatch("[a-f0-9]{64}", value):
        raise RuntimeError("apk-hash-unavailable")
    return value


def http(device, path, method="GET"):
    from adbutils import Network
    connection = HTTPConnection("localhost", 7912, timeout=10)
    connection.sock = device.create_connection(Network.TCP, 7912)
    connection.sock.settimeout(10)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def foreground(device):
    output = device.shell(["dumpsys", "activity", "activities"])
    matches = re.findall(r"topResumedActivity=ActivityRecord\{[^\n]*?\bu\d+\s+([\w.]+)/", output)
    if len(matches) != 1:
        raise RuntimeError("ambiguous-foreground-display")
    return matches[0]


def assert_target(device):
    if foreground(device) != TARGET:
        raise RuntimeError("benchmark-target-not-foreground")


def set_state(device, token=None, scene=None, reset=False):
    assert_target(device)
    command = ["am", "broadcast", "-n", TARGET + "/.TargetReceiver", "-a", TARGET + ".SET_STATE"]
    for name, value in [("token", token), ("scene", scene)]:
        if value is not None:
            command += ["--ei", name, str(value)]
    if reset:
        command += ["--ez", "reset", "true"]
    result = device.shell(command)
    if "Broadcast completed" not in result:
        raise RuntimeError("target-state-broadcast-failed")
    return json.loads(device.shell(["run-as", TARGET, "cat", "files/state.json"]))


def inspect_demo(port):
    child = subprocess.run(["node", str(ROOT / "docs/scripts/inspect-device-demo.mjs"), str(port)],
                           capture_output=True, text=True, timeout=80,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if child.returncode:
        raise RuntimeError("demo-state-validation-failed")
    line = next(line for line in child.stdout.splitlines() if line.startswith("DOCS_DEMO_STATE:"))
    return json.loads(line.split(":", 1)[1])


def cleanup_clients():
    module = sys.modules.get("core.device.scrcpy_client")
    if module:
        for client in list(module.ScrcpyClient.connections.values()):
            client.connection.stop()
            thread = client.connection.stream_loop_thread
            if thread:
                thread.join(timeout=5)
        module.ScrcpyClient.connections.clear()
    module = sys.modules.get("core.device.nemu_client")
    if module:
        seen = set()
        for client in list(module.NemuClient.connections.values()):
            if id(client) in seen:
                continue
            seen.add(id(client))
            client.disconnect()
            client._ev.close()
        module.NemuClient.connections.clear()


@contextmanager
def device_session(args, report):
    from adbutils import adb, adb_path
    device = adb.device(args.serial)
    before_processes = processes(device)
    if foreground(device) != DEMO:
        raise RuntimeError("owned-demo-not-foreground-before-test")
    forbidden = ["atx-agent", "uiautomator", "minicap", "minitouch", "apkagent.cli", "rotationagent", "com.genymobile.scrcpy"]
    if any(any(name in command for name in forbidden) for command in before_processes.values()):
        raise RuntimeError("existing-automation-service-must-not-be-replaced")
    if "@scrcpy" in device.shell(["cat", "/proc/net/unix"]):
        raise RuntimeError("existing-scrcpy-socket")
    report["before"] = inspect_demo(args.cdp_port)
    running_apps = [package for package in OWNED_APKS if package in before_processes.values()]
    for package in running_apps:
        if package_hash(device, package) != OWNED_APKS[package]:
            raise RuntimeError("owned-demo-apk-changed")
        configs = device.shell(["run-as", package, "find", "files/baas/config", "-name", "config.json"]).splitlines()
        if not configs or any(json.loads(device.shell(["run-as", package, "cat", filename])).get("autostart")
                              for filename in configs):
            raise RuntimeError("owned-demo-has-autostart-or-unreadable-config")
    remote_files = [JAR] + ["/data/local/tmp/minicap-images/" + str(index) + ".jpg" for index in range(5)]
    backups = {}
    for filename in remote_files:
        stat = device.sync.stat(filename)
        backups[filename] = (device.sync.read_bytes(filename), stat.mode) if stat.mode else None
    if device.sync.stat(AGENT).mode:
        raise RuntimeError("owned-agent-path-already-exists")
    agent_source = Path(args.backend) / "src/atx_app/atx-agent_0.10.0_linux_386/atx-agent"
    agent_data = agent_source.read_bytes()
    report["agent"] = {"version": "0.10.0", "architecture": "386", "sha256": sha(agent_data),
                       "daemon": False, "automaticRecoveryDisabled": True}
    previous_forwards = {(item.local, item.remote) for item in device.forward_list()}
    report["environment"] = {
        "python": platform.python_version(), "host": platform.platform(),
        "androidRelease": device.getprop("ro.build.version.release"),
        "sdk": int(device.getprop("ro.build.version.sdk")),
        "abi": device.getprop("ro.product.cpu.abi"),
        "versions": {name: importlib.metadata.version(name) for name in
                     ["adbutils", "uiautomator2", "av", "numpy", "opencv-python", "Pillow"]},
        "uiautomatorServer": device.app_info("com.github.uiautomator").version_name,
    }
    report["sharedPackageHashes"] = {package: package_hash(device, package)
                                     for package in ["com.github.uiautomator", "com.github.uiautomator.test"]}
    stream = None
    agent_pid = None
    stopped = []
    logs = deque(maxlen=100)
    try:
        if device.sync.stat("/data/local/tmp/baas-docs-device-target.apk").mode:
            raise RuntimeError("unexpected-owned-install-path")
        target_installed = bool(device.shell(["pm", "path", TARGET]).strip())
        target_hash = sha(Path(args.apk).read_bytes())
        if not target_installed:
            device.install(args.apk)
        if package_hash(device, TARGET) != target_hash:
            raise RuntimeError("test-target-apk-mismatch")
        report["targetApkSha256"] = target_hash
        for package in running_apps:
            device.app_stop(package)
            stopped.append(package)
        device.shell(["am", "start", "-W", "-n", TARGET + "/.MainActivity"])
        time.sleep(1)
        assert_target(device)
        try:
            http(device, "/version")
        except Exception:
            pass
        else:
            raise RuntimeError("device-port-7912-still-owned-by-another-service")
        device.sync.push(io.BytesIO(agent_data), AGENT, mode=0o755)
        stream = device.shell([AGENT, "server", "--nouia", "--addr", "127.0.0.1:7912"], stream=True)

        def drain():
            try:
                while True:
                    chunk = stream.conn.recv(4096)
                    if not chunk:
                        break
                    logs.append(chunk.decode("utf8", errors="replace"))
            except OSError:
                pass

        threading.Thread(target=drain, daemon=True).start()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            candidates = [pid for pid, command in processes(device).items() if is_owned_agent(device, pid, command)]
            if len(candidates) == 1:
                agent_pid = candidates[0]
                try:
                    if http(device, "/version")[2].strip() == b"0.10.0":
                        break
                except Exception:
                    pass
            time.sleep(0.2)
        else:
            raise RuntimeError("owned-atx-agent-did-not-start")
        state = set_state(device, token=54321, scene=0, reset=True)
        if (state["width"], state["height"]) != (1280, 720):
            raise RuntimeError("unexpected-target-geometry")
        report["targetGeometry"] = [1280, 720]
        yield device
    finally:
        cleanup_errors = []

        def attempt(operation):
            try:
                return operation()
            except Exception as error:
                cleanup_errors.append({"type": type(error).__name__, "reason": str(error)})

        attempt(cleanup_clients)
        if agent_pid and is_owned_agent(device, agent_pid, processes(device).get(agent_pid, "")):
            device.shell(["kill", "-TERM", str(agent_pid)])
            deadline = time.monotonic() + 8
            while agent_pid in processes(device) and time.monotonic() < deadline:
                time.sleep(0.2)
            if agent_pid in processes(device):
                cleanup_errors.append({"reason": "owned-agent-failed-to-stop"})
        if stream:
            stream.close()
        for pid, command in processes(device).items():
            if pid not in before_processes and command in ["com.github.uiautomator", "com.github.uiautomator.test"]:
                if processes(device).get(pid) == command:
                    attempt(lambda: device.shell(["run-as", "com.github.uiautomator", "kill", "-9", str(pid)]))
        time.sleep(0.2)
        report["agentLogTail"] = list(logs)
        if device.sync.stat(AGENT).mode:
            if sha(device.sync.read_bytes(AGENT)) != sha(agent_data):
                raise RuntimeError("owned-agent-binary-changed-during-test")
            device.shell(["rm", "--", AGENT])
        def restore_file(filename, backup):
            current = device.sync.read_bytes(filename) if device.sync.stat(filename).mode else None
            if backup and current == backup[0]:
                return
            if current:
                if filename == JAR:
                    expected = (Path(args.backend) / "src/scrcpy_bin/scrcpy-server.jar").read_bytes()
                    if current != expected:
                        raise RuntimeError("shared-jar-changed-by-another-owner")
                else:
                    decode_frame(cv2.imdecode(np.frombuffer(current, np.uint8), cv2.IMREAD_COLOR))
            if backup:
                device.sync.push(io.BytesIO(backup[0]), filename, mode=backup[1] & 0o777)
                if device.sync.read_bytes(filename) != backup[0]:
                    raise RuntimeError("shared-temp-file-restore-failed")
            elif current is not None:
                device.shell(["rm", "--", filename])

        for filename, backup in backups.items():
            attempt(lambda: restore_file(filename, backup))
        for item in device.forward_list():
            if (item.local, item.remote) not in previous_forwards and item.remote == "tcp:7912":
                attempt(lambda: subprocess.run([adb_path(), "-s", device.serial, "forward", "--remove", item.local],
                                               check=True, capture_output=True, timeout=10,
                                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)))
        device.app_stop(TARGET)
        # The two owned validation clones cannot run their backends on the same ports.
        # Restore the active x86 demo; retain the other clone's files without restarting it.
        if DEMO in stopped:
            attempt(lambda: device.shell(["am", "start", "-W", "-n", DEMO + "/io.github.kiramei.baas_tauri.MainActivity"], timeout=20))
            time.sleep(5)
        if stopped:
            pid = device.shell(["pidof", DEMO]).strip()
            if not pid.isdigit():
                raise RuntimeError("owned-demo-did-not-restart")
            device.forward("tcp:" + str(args.cdp_port), "localabstract:webview_devtools_remote_" + pid)
            report["after"] = attempt(lambda: inspect_demo(args.cdp_port))
        report["cleanup"] = {
            "demoForeground": foreground(device) == DEMO,
            "agentRemoved": not bool(device.sync.stat(AGENT).mode),
            "scrcpySocketAbsent": "@scrcpy" not in device.shell(["cat", "/proc/net/unix"]),
            "sharedFilesRestored": True,
            "inactiveOwnedClonesLeftStopped": len([package for package in stopped if package != DEMO]),
            "automationProcessesAbsent": not any(
                any(name in command for name in forbidden) for command in processes(device).values()),
            "errors": cleanup_errors,
        }
        report["cleanup"]["sharedPackagesUnchanged"] = all(
            package_hash(device, package) == expected for package, expected in report["sharedPackageHashes"].items())
        for field in ["demoForeground", "agentRemoved", "scrcpySocketAbsent", "automationProcessesAbsent", "sharedPackagesUnchanged"]:
            if not report["cleanup"][field]:
                cleanup_errors.append({"reason": "cleanup-check-failed:" + field})
        if cleanup_errors:
            raise RuntimeError("device-session-cleanup-requires-review")


def connection(args):
    logger = logging.getLogger("docs-device-benchmark")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    logger.setLevel(logging.CRITICAL)
    config = SimpleNamespace(program_address=args.emulator)
    return SimpleNamespace(serial=args.serial, logger=logger, config=config,
                           config_set=SimpleNamespace(config=config, set=lambda key, value: setattr(config, key, value)))


def adapter(method, args, kind="screenshot"):
    import importlib
    classes = {"screenshot": ["AdbScreenshot", "U2Screenshot", "ScrcpyScreenshot", "NemuScreenshot"],
               "control": ["AdbControl", "U2Control", "ScrcpyControl", "NemuControl"]}
    module = importlib.import_module("core.device." + kind + "." + method)
    return getattr(module, classes[kind][METHODS.index(method)])(connection(args))


def guarded_u2():
    import uiautomator2

    def refuse_recovery(*args, **kwargs):
        raise RuntimeError("automatic-device-repair-disabled-to-protect-shared-emulator")

    uiautomator2.Device._prepare_atx_agent = refuse_recovery
    uiautomator2.Device.reset_uiautomator = refuse_recovery


def start_uiautomator(device):
    http(device, "/services/uiautomator", "POST")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            if http(device, "/ping")[2].strip() == b"pong":
                break
        except Exception:
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError("uiautomator-instrumentation-not-ready")


def probe(device, args, report):
    start_uiautomator(device)
    report["captureProbes"] = []
    for index, method in enumerate(METHODS):
        token = 40000 + index
        set_state(device, token=token, scene=0, reset=True)
        time.sleep(0.05)
        started = time.perf_counter_ns()
        result = {"method": method}
        try:
            instance = adapter(method, args)
            result["initializeMs"] = (time.perf_counter_ns() - started) / 1e6
            result["readinessAttempts"] = []
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                started = time.perf_counter_ns()
                image = instance.screenshot()
                attempt = {"captureMs": (time.perf_counter_ns() - started) / 1e6,
                           "frame": decode_frame(image)}
                result["readinessAttempts"].append(attempt)
                if attempt["frame"]["token"] == token:
                    result["captureMs"] = attempt["captureMs"]
                    result["frame"] = attempt["frame"]
                    result["available"] = True
                    break
            else:
                raise ValueError("target-token-not-ready-within-deadline")
        except Exception as error:
            result.update(available=False, failure={"type": type(error).__name__, "reason": str(error)})
        finally:
            cleanup_clients()
        report["captureProbes"].append(result)
        print(json.dumps(result), flush=True)
    status, headers, payload = http(device, "/screenshot/0")
    report["standardAgentScreenshot"] = {
        "status": status, "method": headers.get("X-Screenshot-Method"),
        "png": payload.startswith(b"\x89PNG"), "bytes": len(payload),
    }
    status, _, payload = http(device, "/services/uiautomator", "POST")
    report["uiautomatorStartStatus"] = status
    time.sleep(2)
    report["controlProbes"] = []
    for index, method in enumerate(METHODS):
        token = 50000 + index
        set_state(device, token=token, scene=0, reset=True)
        result = {"method": method}
        try:
            instance = adapter(method, args, "control")
            if method == "scrcpy":
                decode_frame(instance.cli.screenshot(), token)
            assert_target(device)
            started = time.perf_counter_ns()
            instance.click(500, 500)
            result["clickApiMs"] = (time.perf_counter_ns() - started) / 1e6
            time.sleep(0.1)
            result["state"] = set_state(device)
            result["available"] = result["state"]["inputs"] == 1
        except Exception as error:
            result.update(available=False, failure={"type": type(error).__name__, "reason": str(error)})
        finally:
            cleanup_clients()
        report["controlProbes"].append(result)
        print(json.dumps(result), flush=True)


class FrameObserver:
    def __init__(self, client):
        self.client = client
        self.condition = threading.Condition()
        self.seen = {}
        self.decode_ms = []
        self.failures = []
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        previous = None
        while not self.stopped.is_set():
            image = self.client.last_frame
            if image is not None and image is not previous:
                previous = image
                started = time.perf_counter_ns()
                try:
                    frame = decode_frame(image)
                    observed = time.perf_counter_ns()
                    self.decode_ms.append((observed - started) / 1e6)
                    with self.condition:
                        self.seen.setdefault((frame["token"], frame["inputs"]), (observed, frame))
                        self.condition.notify_all()
                except ValueError as error:
                    self.failures.append(str(error))
            self.stopped.wait(0.001)

    def wait(self, token, inputs, timeout=3):
        with self.condition:
            if not self.condition.wait_for(lambda: (token, inputs) in self.seen, timeout=timeout):
                raise ValueError("expected-input-frame-not-observed")
            return self.seen[(token, inputs)]

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError("observer-did-not-stop")


def quality(image, frame, reference):
    normalized = image if frame["channelOrder"] == "BGR" else image[:, :, ::-1]
    difference = normalized[390:600, 940:1200].astype(np.float32) - reference
    mse = float(np.square(difference).mean())
    return {"mse": mse, "psnrDb": 10 * np.log10(255 ** 2 / mse) if mse else None}


def measure(device, args, report, save):
    report["methodology"] = {
        "orders": [[METHODS[index] for index in order] for order in ORDERS],
        "capture": {"scenes": ["static", "animated"], "rounds": 4, "warmupsPerBlock": 5,
                    "samplesPerBlock": 25, "intervalFloorIncluded": False,
                    "qualityRegion": {"left": 940, "top": 390, "width": 260, "height": 210}},
        "control": {"actions": ["click", "swipe", "long_click"], "rounds": 4,
                    "warmupsPerBlock": 3, "samplesPerBlock": 12, "gestureDurationSeconds": 0.3,
                    "clickPoint": [500, 500], "swipePoints": [[300, 500], [700, 500]],
                    "observer": "Production Scrcpy H.264 8 Mbps software decoder; 1 ms polling of immutable decoded frames; detection includes barcode decoding",
                    "scope": "Synchronous adapter calls with production sleeps; no high-level asynchronous Baas_thread click wrapper"},
    }
    report["captureBlocks"] = []
    report["controlBlocks"] = []
    from core.device.uiautomator2_client import U2Client
    service = U2Client.get_instance(args.serial).connection
    token = 1000
    for scene in [0, 1]:
        for round_index, order in enumerate(ORDERS):
            for position, method_index in enumerate(order):
                service.info
                token += 1
                set_state(device, token=token, scene=scene, reset=True)
                time.sleep(0.05)
                reference_image = adapter("adb", args).screenshot()
                decode_frame(reference_image, token)
                reference = reference_image[390:600, 940:1200].astype(np.float32)
                block = {"scene": ["static", "animated"][scene], "round": round_index,
                         "position": position, "method": METHODS[method_index], "token": token,
                         "warmups": [], "samples": []}
                try:
                    started = time.perf_counter_ns()
                    instance = adapter(block["method"], args)
                    block["initializeMs"] = (time.perf_counter_ns() - started) / 1e6
                    for index in range(30):
                        assert_target(device)
                        started = time.perf_counter_ns()
                        sample = {}
                        try:
                            image = instance.screenshot()
                            sample["apiMs"] = (time.perf_counter_ns() - started) / 1e6
                            frame = decode_frame(image, token)
                            sample["frame"] = frame
                            sample["quality"] = quality(image, frame, reference)
                        except Exception as error:
                            sample.update(elapsedMs=(time.perf_counter_ns() - started) / 1e6,
                                          failure={"type": type(error).__name__, "reason": str(error)})
                        block["warmups" if index < 5 else "samples"].append(sample)
                finally:
                    cleanup_clients()
                    report["captureBlocks"].append(block)
                    save()
                print(json.dumps({"phase": "capture", "scene": block["scene"], "round": round_index,
                                  "method": block["method"], "samples": len(block["samples"]),
                                  "failures": sum("failure" in sample for sample in block["samples"])}), flush=True)

    from core.device.scrcpy_client import ScrcpyClient
    stream = ScrcpyClient.get_instance(args.serial).connection
    observer = FrameObserver(stream)
    try:
        for action_index, action in enumerate(["click", "swipe", "long_click"]):
            for round_index, base_order in enumerate(ORDERS):
                # Rotate the row order between gestures without losing position/pair balance.
                order = ORDERS[(round_index + action_index) % len(ORDERS)]
                for position, method_index in enumerate(order):
                    service.info
                    token += 1
                    set_state(device, token=token, scene=0, reset=True)
                    observer.wait(token, 0)
                    block = {"action": action, "round": round_index, "position": position,
                             "method": METHODS[method_index], "token": token, "warmups": [], "samples": []}
                    instance = adapter(block["method"], args, "control")
                    try:
                        for index in range(15):
                            before = set_state(device)
                            observer.wait(token, before["inputs"])
                            sample = {"beforeInputs": before["inputs"]}
                            started = time.perf_counter_ns()
                            try:
                                if action == "click":
                                    instance.click(500, 500)
                                elif action == "swipe":
                                    instance.swipe(300, 500, 700, 500, 0.3)
                                else:
                                    instance.long_click(500, 500, 0.3)
                                sample["apiMs"] = (time.perf_counter_ns() - started) / 1e6
                                detected, frame = observer.wait(token, (before["inputs"] + 1) & 65535)
                                sample["visibleMs"] = (detected - started) / 1e6
                                sample["observedFrame"] = frame["frame"]
                                sample["observedDurationMs"] = frame["durationMs"]
                                state = set_state(device)
                                sample["target"] = {key: state[key] for key in ["inputs", "durationMs", "travelPixels"]}
                                if state["inputs"] != before["inputs"] + 1 or sample["visibleMs"] < 0:
                                    raise ValueError("unexpected-input-count-or-stale-observation")
                                if frame["durationMs"] != state["durationMs"]:
                                    raise ValueError("decoded-input-duration-mismatch")
                                expected_travel = 400 if action == "swipe" else 0
                                if abs(state["travelPixels"] - expected_travel) > 10:
                                    raise ValueError("input-travel-mismatch")
                            except Exception as error:
                                sample.update(elapsedMs=(time.perf_counter_ns() - started) / 1e6,
                                              failure={"type": type(error).__name__, "reason": str(error)})
                            block["warmups" if index < 3 else "samples"].append(sample)
                    finally:
                        # Keep the common Scrcpy observer/stream alive across every control block.
                        report["controlBlocks"].append(block)
                        save()
                    print(json.dumps({"phase": "control", "action": action, "round": round_index,
                                      "method": block["method"], "samples": len(block["samples"]),
                                      "failures": sum("failure" in sample for sample in block["samples"])}), flush=True)
    finally:
        observer.close()
        report["observer"] = {"decodeSamplesMs": observer.decode_ms,
                              "invalidFrames": observer.failures,
                              "distinctStates": len(observer.seen)}
        cleanup_clients()
        save()


def main():
    parser = argparse.ArgumentParser()
    for name in ["backend", "serial", "emulator", "apk", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--cdp-port", type=int, default=19233)
    parser.add_argument("--measure", action="store_true")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT / ".cache"):
        raise RuntimeError("raw-device-report-must-stay-in-ignored-cache")
    output.parent.mkdir(parents=True, exist_ok=True)
    os.environ["NO_PROXY"] = "127.0.0.1,localhost,::1"
    os.chdir(args.backend)
    sys.path.insert(0, args.backend)
    guarded_u2()
    source_files = ["core/device/" + kind + "/" + method + ".py"
                    for kind in ["screenshot", "control"] for method in METHODS]
    source_files += ["core/device/" + name for name in ["scrcpy_client.py", "scrcpy/core.py", "nemu_client.py", "uiautomator2_client.py", "Screenshot.py"]]
    source_files += ["src/scrcpy_bin/scrcpy-server.jar"]
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(), "completed": False,
        "backendRevision": "d0a86a089068766ff53682b501b90bee99857a71",
        "harnessSha256": sha(Path(__file__).read_bytes()),
        "demoInspectorSha256": sha((ROOT / "docs/scripts/inspect-device-demo.mjs").read_bytes()),
        "sourceFiles": {file: sha((Path(args.backend) / file).read_bytes()) for file in source_files},
        "targetSourceFiles": {str(file.relative_to(ROOT)).replace("\\", "/"): sha(file.read_bytes())
                              for file in sorted((ROOT / "docs/benchmarks/device-target/src").rglob("*")) if file.is_file()},
    }
    try:
        with device_session(args, report) as device:
            probe(device, args, report)
            if args.measure:
                if not all(result["available"] for result in report["captureProbes"] + report["controlProbes"]):
                    raise RuntimeError("an-adapter-failed-readiness")
                measure(device, args, report, lambda: output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8"))
        report["completed"] = True
    except Exception as error:
        report["failure"] = {"type": type(error).__name__, "reason": str(error)}
        raise
    finally:
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
