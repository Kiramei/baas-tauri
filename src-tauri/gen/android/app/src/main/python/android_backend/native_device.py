"""Automation adapters for the authenticated, Shizuku-backed local display bridge.

No ADB connection, accessibility service, UIAutomator server, or preview decoder
is involved. Screenshots come from the same native capture source as the preview.
"""
import base64
import io
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

ANDROID_LOCAL_METHOD = "android_local"


def _rpc(method, params):
    token_path = os.environ.get("BAAS_ANDROID_LOCAL_TOKEN_FILE", "")
    if not token_path:
        raise RuntimeError("Android local-device token is unavailable")
    token = Path(token_path).read_text(encoding="utf-8").strip()
    request = Request(
        "http://127.0.0.1:7912/jsonrpc/0",
        data=json.dumps({"jsonrpc": "2.0", "id": "native-device", "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "x-baas-token": token},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        payload = json.load(response)
    if payload.get("error"):
        raise RuntimeError(payload["error"].get("message", str(payload["error"])))
    return payload.get("result")


class AndroidLocalControl:
    def __init__(self, conn):
        self.serial = conn.serial

    def click(self, x, y):
        return _rpc("click", [int(x), int(y)])

    def swipe(self, x1, y1, x2, y2, duration):
        # The local bridge's existing JSON-RPC contract uses 5 ms steps.
        steps = max(1, min(2000, round(float(duration) * 200)))
        return _rpc("swipe", [int(x1), int(y1), int(x2), int(y2), steps])

    def long_click(self, x, y, duration):
        return self.swipe(x, y, x, y, duration)

    def scroll(self, x, y, clicks):
        direction = -1 if clicks > 0 else 1
        return self.swipe(x, y, x, y + direction * 240 * abs(clicks), 0.2)


class AndroidLocalScreenshot:
    def __init__(self, conn):
        self.serial = conn.serial

    def screenshot(self):
        import numpy as np
        from PIL import Image
        encoded = _rpc("takeScreenshot", [1.0, 100])
        if not encoded:
            raise RuntimeError("The game capture source has not produced a frame")
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
            return np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
