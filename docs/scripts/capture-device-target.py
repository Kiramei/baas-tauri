import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import time

import cv2
import numpy as np
from adbutils import adb

spec = importlib.util.spec_from_file_location("measure_device", Path(__file__).with_name("measure-device.py"))
measurement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measurement)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("serial")
    parser.add_argument("--cdp-port", type=int, default=19233)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    record = json.loads((root / "docs/public/benchmarks/device-current.json").read_text(encoding="utf8"))
    device = adb.device(args.serial)
    if measurement.foreground(device) != measurement.DEMO:
        raise RuntimeError("owned-demo-not-foreground")
    before = measurement.inspect_demo(args.cdp_port)
    if measurement.package_hash(device, measurement.TARGET) != record["targetApkSha256"]:
        raise RuntimeError("unexpected-target-apk")
    try:
        device.shell(["am", "start", "-W", "-n", measurement.TARGET + "/.MainActivity"])
        time.sleep(0.5)
        measurement.set_state(device, token=9012, scene=1, reset=True)
        time.sleep(0.2)
        measurement.assert_target(device)
        png = device.shell(["screencap", "-p"], encoding=None)
        image = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        frame = measurement.decode_frame(image, 9012)
        (root / "docs/public/benchmarks/device-target.png").write_bytes(png)
    finally:
        device.shell(["am", "start", "-W", "-n", measurement.DEMO + "/io.github.kiramei.baas_tauri.MainActivity"])
        device.app_stop(measurement.TARGET)
        time.sleep(0.5)
    after = measurement.inspect_demo(args.cdp_port)
    if before["taskSelections"] != after["taskSelections"] or measurement.foreground(device) != measurement.DEMO:
        raise RuntimeError("demo-restore-check-failed")
    evidence = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Untimed ADB PNG of the independent benchmark target, not the BAAS interface or a game",
        "file": "benchmarks/device-target.png", "sha256": hashlib.sha256(png).hexdigest(),
        "targetApkSha256": record["targetApkSha256"], "frame": frame,
        "dimensions": [1280, 720], "privacy": "Generated test counters and deterministic texture only; no account, game or host-path content",
        "demoRestored": True,
    }
    (root / "docs/evidence/device-target-capture.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf8")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
