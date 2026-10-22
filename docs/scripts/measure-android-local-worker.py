"""On-device measurements of the installed Android adapters, without scheduler tasks."""
from datetime import datetime, timezone
import hashlib
import json
import logging
import marshal
import os
from pathlib import Path
import platform
import struct
import sys
import time
import traceback
from types import SimpleNamespace
from urllib.request import Request, urlopen

import numpy as np


APP = "io.github.kiramei.baas_tauri.docs.x86"
TARGET = "io.github.kiramei.baas_docs_benchmark"
CONTROL_ORDERS = [
    ["click", "swipe", "long_click"], ["swipe", "long_click", "click"],
    ["long_click", "click", "swipe"], ["long_click", "swipe", "click"],
    ["swipe", "click", "long_click"], ["click", "long_click", "swipe"],
]


def measurement_plan(probe):
    return {"captureBlocks": 1 if probe else 10, "captureTrials": 2 if probe else 10,
            "captureWarmups": 1 if probe else 2, "controlBlocks": 1 if probe else 24,
            "controlTrials": 1 if probe else 3, "controlWarmups": 1 if probe else 2}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes((json.dumps(value, indent=2) + "\n").encode("utf-8"))
    temporary.replace(path)


def decode_frame(image, expected_token=None):
    if image is None or image.shape != (720, 1280, 3) or image.dtype != np.uint8:
        raise ValueError("invalid-frame-shape-or-type")
    centers = [56 + 72 * bit for bit in range(16)]
    values = []
    for y in [105, 165, 225, 285]:
        levels = [float(np.median(image[y-2:y+3, x-2:x+3])) for x in centers]
        if any(75 < level < 190 for level in levels):
            raise ValueError("ambiguous-barcode")
        values.append(sum(1 << bit for bit, level in enumerate(levels) if level > 128))
    colors = np.array([np.median(image[30:35, x-2:x+3], axis=(0, 1)) for x in [32, 112, 172, 232]])
    expected = np.array([[255, 0, 255], [0, 0, 255], [0, 255, 0], [255, 0, 0]])
    if float(np.abs(colors - expected).mean()) > 5:
        raise ValueError("fixture-fiducial-or-BGR-order-mismatch")
    if expected_token is not None and values[0] != expected_token:
        raise ValueError("stale-fixture-token")
    return {"token": values[0], "inputs": values[1], "frame": values[2], "durationMs": values[3]}


def texture_reference():
    y, x = np.indices((210, 260), dtype=np.uint32)
    x += 40
    y += 40
    seed = ((x // 4) * np.uint32(73856093)) ^ ((y // 4) * np.uint32(19349663)) ^ np.uint32(83492791)
    seed ^= seed >> 13
    return np.stack([40 + ((seed >> 16) & 127), 40 + ((seed >> 8) & 127), 40 + (seed & 127)], axis=2).astype(np.uint8)


def quality_mse(image, reference):
    difference = image[390:600, 940:1200].astype(np.float32) - reference
    return float(np.square(difference).mean())


def validate_input(scenario, observed, expected_inputs):
    if observed["inputs"] != expected_inputs or observed["width"] != 1280 or observed["height"] != 720:
        raise ValueError("fixture-input-count-or-size-mismatch")
    if scenario == "swipe":
        if not 380 <= observed["travelPixels"] <= 420:
            raise ValueError("swipe-travel-mismatch")
    elif observed["travelPixels"] > 3:
        raise ValueError("stationary-input-moved")
    low, high = (25, 200) if scenario == "click" else (200, 600)
    if not low <= observed["durationMs"] <= high:
        raise ValueError("input-hold-duration-mismatch")


class Measurement:
    def __init__(self, directory):
        self.directory = directory
        self.request = json.loads((directory / "request.json").read_text())
        self.plan = measurement_plan(self.request["probe"])
        self.sequence = 0
        self.token = Path(os.environ["BAAS_ANDROID_LOCAL_TOKEN_FILE"]).read_text().strip()
        self.report = {"startedAt": datetime.now(timezone.utc).isoformat(), "session": self.request["session"], "probe": self.request["probe"],
                       "success": False, "capture": [], "control": [], "warmups": [], "failures": []}

    def cancelled(self):
        if (self.directory / "stop.json").exists():
            raise RuntimeError("measurement-cancelled")

    def status(self, phase=None, finished=False):
        value = {"session": self.request["session"], "sequence": self.sequence, "phase": phase,
                 "progress": {"capture": len(self.report["capture"]), "control": len(self.report["control"])},
                 "resultReady": finished}
        write_json(self.directory / "status.json", value)

    def phase(self, action, **payload):
        self.cancelled()
        self.sequence += 1
        self.status({"session": self.request["session"], "sequence": self.sequence, "action": action, **payload})
        deadline = time.monotonic() + (180 if action == "ready" else 45)
        while time.monotonic() < deadline:
            self.cancelled()
            try:
                response = json.loads((self.directory / "response.json").read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.05)
                continue
            if response.get("session") == self.request["session"] and response.get("sequence") == self.sequence:
                if not response.get("ok"):
                    raise RuntimeError("host-fixture-coordination-failed")
                self.status()
                return response["state"]
            time.sleep(0.05)
        raise TimeoutError("fixture-coordination-timeout")

    def guard(self):
        self.cancelled()
        request = Request("http://127.0.0.1:7912/info", headers={"x-baas-token": self.token})
        with urlopen(request, timeout=10) as response:
            info = json.load(response)
        if info.get("currentPackageName") != TARGET or info.get("displayWidth") != 1280 or info.get("displayHeight") != 720:
            raise RuntimeError("owned-virtual-display-fixture-missing")

    def ready_frame(self, token):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.guard()
            image = self.raw.screenshot()
            try:
                return decode_frame(image, token)
            except ValueError as error:
                if str(error) != "stale-fixture-token":
                    raise
                time.sleep(0.02)
        raise TimeoutError("fixture-token-not-rendered")

    def capture_sample(self, method, token, previous_frame):
        self.guard()
        gap = max(0.0, (time.time() - self.script.last_screenshot_time) * 1000) if method == "script" else None
        started = time.perf_counter_ns()
        image = (self.raw if method == "adapter" else self.script).screenshot()
        elapsed = time.perf_counter_ns() - started
        frame = decode_frame(image, token)
        mse = quality_mse(image, self.reference)
        if mse > 1.0:
            raise ValueError("lossless-texture-quality-mismatch")
        return {"elapsedNs": elapsed, "outputBytes": int(image.nbytes), "frame": frame["frame"],
                "repeatedFrame": frame["frame"] == previous_frame, "mse": mse,
                "scriptGapBeforeCallMs": gap}, frame["frame"]

    def input_sample(self, scenario, token, previous_inputs):
        self.guard()
        started = time.perf_counter_ns()
        if scenario == "click":
            self.control.click(300, 490)
        elif scenario == "swipe":
            self.control.swipe(300, 490, 700, 490, 0.3)
        else:
            self.control.long_click(300, 490, 0.3)
        returned = time.perf_counter_ns()
        deadline = time.monotonic() + 5
        polls = 0
        while time.monotonic() < deadline:
            self.cancelled()
            image = self.raw.screenshot()
            frame = decode_frame(image, token)
            polls += 1
            if frame["inputs"] > previous_inputs + 1:
                raise ValueError("unexpected-extra-input")
            if frame["inputs"] == previous_inputs + 1:
                visible = time.perf_counter_ns()
                break
        else:
            raise TimeoutError("input-not-visible")
        # Snapshot transport is outside both measured intervals.
        observed = self.phase("snapshot")
        if observed["token"] != token or observed["durationMs"] != frame["durationMs"]:
            raise ValueError("snapshot-and-visible-frame-disagree")
        validate_input(scenario, observed, previous_inputs + 1)
        return {"scenario": scenario, "apiElapsedNs": returned - started, "visibleElapsedNs": visible - started,
                "polls": polls, "inputs": frame["inputs"], "frame": frame["frame"],
                "observedDurationMs": observed["durationMs"], "observedTravelPixels": observed["travelPixels"]}

    def run(self):
        process = Path("/proc/self/cmdline").read_bytes().split(b"\0")[0].decode()
        if process != APP + ":baas_backend" or os.getuid() != self.request["appUid"]:
            raise RuntimeError("not-the-owned-embedded-backend-process")
        if os.environ.get("BAAS_ANDROID_NATIVE_CAPTURE") != "1":
            raise RuntimeError("native-capture-not-selected")
        from android_backend.native_device import AndroidLocalControl, AndroidLocalScreenshot
        from service.injection import apply_service_injections
        apply_service_injections()
        from core.device.Screenshot import Screenshot
        from core.device.Control import Control

        logger = logging.getLogger("baas-docs-local-measure")
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        config = SimpleNamespace(screenshot_method="android_local", control_method="android_local", screenshot_interval=0.3)
        connection = SimpleNamespace(serial="127.0.0.1:7912")
        baas = SimpleNamespace(connection=connection, is_android_device=True,
                               get_config=lambda: SimpleNamespace(config=config), get_logger=lambda: logger)
        self.raw = AndroidLocalScreenshot(connection)
        self.script = Screenshot(baas)
        self.control = Control(baas)
        if not isinstance(self.script.screenshot_instance, AndroidLocalScreenshot) or not isinstance(self.control.control_instance, AndroidLocalControl):
            raise RuntimeError("production-wrapper-selected-another-adapter")
        self.reference = texture_reference()
        self.report["runtime"] = {"process": process, "pid": os.getpid(), "uid": os.getuid(), "python": platform.python_version(),
            "pointerBits": struct.calcsize("P") * 8, "numpy": np.__version__,
            "clock": {"implementation": time.get_clock_info("perf_counter").implementation,
                      "resolutionSeconds": time.get_clock_info("perf_counter").resolution},
            "screenshotIntervalSeconds": self.script.screenshot_interval,
            "adapterModule": AndroidLocalScreenshot.__module__,
            "adapterCodeSha256": digest(marshal.dumps(AndroidLocalScreenshot.screenshot.__code__)),
            "installedSources": {name.replace(".", "/") + ".py": digest(Path(sys.modules[name].__file__).read_bytes())
                for name in ["core.device.Screenshot", "core.device.Control", "service.injection"]}}
        self.report["methodology"] = {**self.plan,
            "callsPerMethodAndScenario": self.plan["captureBlocks"] * self.plan["captureTrials"],
            "controlOrders": CONTROL_ORDERS,
            "controlCallsPerScenario": self.plan["controlBlocks"] * self.plan["controlTrials"],
            "gestureDurationSeconds": 0.3, "swipeRequestPixels": 400,
            "inputObserver": "sequential production AndroidLocalScreenshot after API return",
            "hostCoordinationTimed": False, "fixtureSnapshotTimed": False,
            "independentConnectionMethods": False, "accountTasksStarted": False, "gameInputSent": False}

        self.phase("ready")

        for block in range(self.plan["captureBlocks"]):
            scenarios = ["static", "animated"] if block % 2 == 0 else ["animated", "static"]
            for scenario in scenarios:
                token = 31000 + block * 2 + (scenario == "animated")
                self.phase("scene", token=token, scene=int(scenario == "animated"), reset=True)
                self.ready_frame(token)
                methods = ["adapter", "script"] if (block + (scenario == "animated")) % 2 == 0 else ["script", "adapter"]
                for position, method in enumerate(methods):
                    previous = None
                    for warmup in range(self.plan["captureWarmups"]):
                        row, previous = self.capture_sample(method, token, previous)
                        self.report["warmups"].append({"kind": "capture", "block": block, "scenario": scenario, "method": method, **row})
                    for trial in range(self.plan["captureTrials"]):
                        row, previous = self.capture_sample(method, token, previous)
                        self.report["capture"].append({"ordinal": len(self.report["capture"]), "block": block,
                            "position": position, "scenario": scenario, "method": method, "trial": trial, **row})
                self.status()

        token = 32001
        self.phase("scene", token=token, scene=0, reset=True)
        previous = self.ready_frame(token)["inputs"]
        if previous != 0:
            raise RuntimeError("control-fixture-was-not-reset")
        for scenario in CONTROL_ORDERS[0]:
            for warmup in range(self.plan["controlWarmups"]):
                row = self.input_sample(scenario, token, previous)
                previous = row["inputs"]
                self.report["warmups"].append({"kind": "control", **row})
        for block in range(self.plan["controlBlocks"]):
            for position, scenario in enumerate(CONTROL_ORDERS[block % 6]):
                for trial in range(self.plan["controlTrials"]):
                    row = self.input_sample(scenario, token, previous)
                    previous = row["inputs"]
                    self.report["control"].append({"ordinal": len(self.report["control"]), "block": block,
                                                   "position": position, "trial": trial, **row})
            self.status()
        self.report["success"] = True


def main():
    directory = Path(__file__).resolve().parent
    measurement = Measurement(directory)
    try:
        measurement.run()
    except Exception as error:
        measurement.report["failures"].append({"type": type(error).__name__, "message": str(error)})
        measurement.report["privateTraceback"] = traceback.format_exc()
    finally:
        measurement.report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write_json(directory / "result.json", measurement.report)
        measurement.status(finished=True)


if __name__ == "__main__":
    main()
