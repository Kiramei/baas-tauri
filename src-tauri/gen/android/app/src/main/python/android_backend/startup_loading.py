"""Recognize the CN client's explicit initialization status, without clicking.

BAAS_ANDROID_STARTUP_LOADING_V1
This is not a general loading heuristic: both the lower-left spinner geometry
and complete high-confidence known status words must be present. Only their
strictly limited animated punctuation suffix may have lower OCR confidence.
"""
import json
import math
import os
import re
import time
import unicodedata


REGION = (67, 680, 430, 712)
CACHE_SECONDS = 2.0
_CACHE = "_android_startup_loading_ocr"


def has_startup_spinner(frame):
    if (frame is None or getattr(frame, "ndim", 0) != 3
            or tuple(frame.shape[:2]) != (720, 1280)):
        return False
    ring = inner = outside = 0
    for y in range(682, 707):
        for x in range(34, 61):
            b, g, r = map(int, frame[y, x, :3])
            if not (0 <= r <= 90 and 110 <= g <= 225 and 175 <= b <= 255
                    and b - r >= 100 and g - r >= 60):
                continue
            radius = (x - 47) ** 2 + (y - 694) ** 2
            if radius <= 16:
                inner += 1
            elif 36 <= radius <= 144:
                ring += 1
            elif radius > 169:
                outside += 1
    return ring >= 70 and inner <= 3 and outside <= 15


def matches_initialization_text(result):
    if not isinstance(result, dict):
        return False
    text, scores = result.get("text"), result.get("char_scores")
    if not isinstance(text, str) or not isinstance(scores, list) or len(text) != len(scores):
        return False
    if any(isinstance(score, bool) or not isinstance(score, (int, float))
           or not math.isfinite(score) or not 0 <= score <= 1 for score in scores):
        return False
    normalized, confidence = [], []
    for char, score in zip(text, scores):
        for part in unicodedata.normalize("NFKC", char).lower():
            if not part.isspace():
                normalized.append(part)
                confidence.append(score)
    # Animated trailing dots are not semantic words. Their OCR can become a
    # low-confidence period/exclamation/middle-dot; no uncertain letter or
    # Chinese character may be removed or accepted inside the known status.
    match = re.fullmatch(r"(initializecatalog|游戏数据初始化中|正在初始化游戏数据)([.。…·!]{0,12})", "".join(normalized))
    return match is not None and all(score >= 0.8 for score in confidence[:len(match.group(1))])


def _request_status(baas, frame, language="zh-cn", scale=1):
    import requests

    client = baas.ocr.client
    crop = baas.ocr.get_area_img(frame, REGION, 1)
    if scale == 2:
        from io import BytesIO
        from PIL import Image
        image = Image.fromarray(crop[:, :, ::-1])
        payload = BytesIO()
        image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS).save(payload, format="PNG")
        image_bytes = payload.getvalue()
    else:
        image_bytes = client.get_image_bytes(crop)
    data = {"language": language, "candidates": "", "image": {"pass_method": 1}}
    response = requests.post(
        client.config.base_url + "/ocr_for_single_line",
        files={"data": (None, json.dumps(data), "application/json"),
               "image": ("image.png", image_bytes, "image/png")},
        timeout=(0.3, 0.8),
    )
    try:
        if response.status_code != 200:
            return None
        return json.loads(response.text)
    finally:
        response.close()


def _read_status(baas, frame):
    result = _request_status(baas, frame)
    if matches_initialization_text(result):
        return True
    # The CN model can read the English catalog status with uncertain letters.
    # Retry only this exact textual candidate using the verified 2x English
    # model; do not lower its letter threshold or retry uncertain Chinese text.
    text = result.get("text", "") if isinstance(result, dict) else ""
    if re.fullmatch(r"initialize\s*catalog[.。…·!！\s]*", text, re.IGNORECASE):
        return matches_initialization_text(_request_status(baas, frame, "en-us", 2))
    return False


def is_startup_loading(baas):
    if (os.getenv("BAAS_ANDROID") != "1"
            or os.getenv("BAAS_ANDROID_NATIVE_CAPTURE") != "1"
            or getattr(baas, "server", None) != "CN"
            or not getattr(baas, "flag_run", False)
            or isinstance(getattr(baas, "ratio", None), bool)
            or getattr(baas, "ratio", None) != 1):
        return False
    frame = getattr(baas, "latest_img_array", None)
    if not has_startup_spinner(frame):
        setattr(baas, _CACHE, None)
        return False
    # Preserve the existing strict login template's precedence. OCR evidence
    # must never hold a now-actionable login screen in a loading loop.
    from core import picture
    if picture.match_img_feature(baas, "main_page_login-feature", threshold=0.9, rgb_diff=12):
        setattr(baas, _CACHE, None)
        return False
    now = time.monotonic()
    cached = getattr(baas, _CACHE, None)
    if cached is not None and 0 <= now - cached[0] < CACHE_SECONDS:
        return cached[1]
    try:
        matched = _read_status(baas, frame)
    except Exception:
        # An OCR outage cannot turn an unknown screen into known loading.
        matched = False
    setattr(baas, _CACHE, (time.monotonic(), matched))
    if matched:
        baas.logger.info("Recognized explicit Android CN initialization status; waiting without tentative clicks.")
    return matched and baas.flag_run
