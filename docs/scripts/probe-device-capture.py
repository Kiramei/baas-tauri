import argparse
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace

import cv2
import numpy as np


def validate_frame(image, token, dpr, width, height):
    if image is None or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("invalid-image-array")
    if abs(image.shape[1] - width * dpr) > 2 or abs(image.shape[0] - height * dpr) > 2:
        raise ValueError("unexpected-image-size-or-orientation")
    mask = cv2.inRange(image, np.array([180, 0, 180], dtype=np.uint8), np.array([255, 75, 255], dtype=np.uint8))
    count, _, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
    if count < 2:
        raise ValueError("fixture-fiducial-missing")
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[largest, cv2.CC_STAT_AREA] < 30:
        raise ValueError("fixture-fiducial-too-small")
    offset_x = float(centers[largest, 0]) - 26 * dpr
    offset_y = float(centers[largest, 1]) - 26 * dpr

    def patch(x, y):
        px, py = int(round(x * dpr + offset_x)), int(round(y * dpr + offset_y))
        return image[py - 2:py + 3, px - 2:px + 3].mean(axis=(0, 1))

    actual_token = sum((1 << bit) for bit in range(16) if patch(25 + 24 * bit, 100).mean() > 128)
    if actual_token != token:
        raise ValueError("fixture-token-mismatch")
    colors = np.array([patch(70 + 32 * index, 26) for index in range(3)])
    expected_bgr = np.array([[0, 0, 255], [0, 255, 0], [255, 0, 0]])
    bgr_error = float(np.abs(colors - expected_bgr).mean())
    rgb_error = float(np.abs(colors[:, ::-1] - expected_bgr).mean())
    if min(bgr_error, rgb_error) > 25:
        raise ValueError("fixture-color-calibration-failed")
    return {"width": image.shape[1], "height": image.shape[0], "channels": 3,
            "token": actual_token, "channelOrder": "BGR" if bgr_error <= rgb_error else "RGB",
            "colorMeanAbsoluteError": min(bgr_error, rgb_error),
            "fixtureOffsetPixels": [offset_x, offset_y]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--emulator", required=True)
    parser.add_argument("--cdp-port", type=int, required=True)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--method", choices=["adb", "uiautomator2", "scrcpy", "nemu"], default="adb")
    parser.add_argument("--token", type=int, default=0)
    parser.add_argument("--dpr", type=float, default=1)
    parser.add_argument("--width", type=int, default=1)
    parser.add_argument("--height", type=int, default=1)
    args = parser.parse_args()
    backend = Path(args.backend).resolve()
    os.chdir(backend)
    sys.path.insert(0, str(backend))
    from adbutils import adb
    device = adb.device(args.serial)
    forwards = [item for item in device.forward_list() if item.local == "tcp:" + str(args.cdp_port)]
    if len(forwards) != 1:
        raise RuntimeError("expected-one-owned-CDP-forward")
    target = re.fullmatch(r"localabstract:webview_devtools_remote_(\d+)", forwards[0].remote)
    if target is None:
        raise RuntimeError("unexpected-CDP-forward-target")
    process = device.shell(["cat", "/proc/" + target.group(1) + "/cmdline"]).split("\0")[0]
    if process != args.package:
        raise RuntimeError("CDP-is-not-the-owned-demo-application")
    if device.app_current().package != args.package:
        raise RuntimeError("owned-demo-application-not-foreground")
    if args.preflight_only:
        package_paths = [line.removeprefix("package:") for line in device.shell(["pm", "path", args.package]).splitlines() if line.startswith("package:")]
        if len(package_paths) != 1:
            raise RuntimeError("expected-single-owned-APK")
        apk_hash = device.shell(["sha256sum", package_paths[0]]).split()[0]
        if re.fullmatch(r"[a-fA-F0-9]{64}", apk_hash) is None:
            raise RuntimeError("APK-hash-unavailable")
        files = ["core/device/screenshot/" + method + ".py" for method in ["adb", "uiautomator2", "scrcpy", "nemu"]]
        files += ["core/device/" + name for name in ["scrcpy_client.py", "uiautomator2_client.py", "nemu_client.py", "scrcpy/core.py"]]
        return {"ownedWebViewVerified": True, "ownedAppForeground": True,
                "installedApkSha256": apk_hash.lower(),
                "androidRelease": device.getprop("ro.build.version.release"),
                "sdk": device.getprop("ro.build.version.sdk"),
                "dimensions": list(device.window_size()),
                "versions": {name: importlib.metadata.version(name) for name in ["adbutils", "uiautomator2", "av", "numpy", "opencv-python", "Pillow"]},
                "sourceFiles": {file: hashlib.sha256((backend / file).read_bytes()).hexdigest() for file in files}}
    if args.method == "scrcpy":
        sockets = device.shell("cat /proc/net/unix")
        if any(line.split()[-1] in ("@scrcpy", "scrcpy") for line in sockets.splitlines() if line.split()):
            raise RuntimeError("existing-fixed-scrcpy-socket-must-not-be-replaced")
    logger = logging.getLogger("docs-capture-probe")
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    logger.setLevel(logging.CRITICAL)
    config = SimpleNamespace(program_address=args.emulator)
    config_set = SimpleNamespace(config=config, set=lambda key, value: setattr(config, key, value))
    connection = SimpleNamespace(serial=args.serial, logger=logger, config=config, config_set=config_set)
    result = {"method": args.method, "available": False, "phase": "initialize", "scope": "One tagged-frame compatibility probe, not a steady-state performance benchmark"}
    instance = None
    try:
        started = time.perf_counter_ns()
        if args.method == "adb":
            from core.device.screenshot.adb import AdbScreenshot
            instance = AdbScreenshot(connection)
        elif args.method == "uiautomator2":
            from core.device.screenshot.uiautomator2 import U2Screenshot
            instance = U2Screenshot(connection)
        elif args.method == "scrcpy":
            from core.device.screenshot.scrcpy import ScrcpyScreenshot
            instance = ScrcpyScreenshot(connection)
        else:
            from core.device.screenshot.nemu import NemuScreenshot
            instance = NemuScreenshot(connection)
        result["initializeMs"] = (time.perf_counter_ns() - started) / 1e6
        result["phase"] = "capture"
        started = time.perf_counter_ns()
        image = instance.screenshot()
        result["firstCaptureMs"] = (time.perf_counter_ns() - started) / 1e6
        result["phase"] = "validate"
        result["frame"] = validate_frame(image, args.token, args.dpr, args.width, args.height)
        result["available"] = True
        result["phase"] = "complete"
    except Exception as error:
        result["failure"] = {"type": type(error).__name__}
        if isinstance(error, ValueError):
            result["failure"]["reason"] = str(error)
    finally:
        if args.method == "scrcpy":
            from core.device.scrcpy_client import ScrcpyClient
            for client in list(ScrcpyClient.connections.values()):
                client.connection.stop()
                thread = client.connection.stream_loop_thread
                if thread and thread.is_alive():
                    thread.join(timeout=2)
        elif args.method == "nemu":
            from core.device.nemu_client import NemuClient
            seen = set()
            for client in list(NemuClient.connections.values()):
                if id(client) in seen:
                    continue
                seen.add(id(client))
                client.disconnect()
                client._ev.close()
    return result


if __name__ == "__main__":
    print("DOCS_BENCHMARK_JSON:" + json.dumps(main()), flush=True)
