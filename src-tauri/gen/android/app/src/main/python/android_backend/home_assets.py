"""Read the CN home resource bar after its transition has settled.

Only the Android native-capture path uses these coordinates. Never click or
infer a balance from a partial OCR result; keep the last reading on failure.
"""
import json
import math
import os
import re
import time


REGIONS = {
    "ap": (484, 20, 578, 53),
    "creditpoints": (654, 22, 798, 52),
    "pyroxene": (871, 25, 967, 52),
}


def parse_reading(key, text):
    value = str(text).strip()
    if key == "ap":
        match = re.fullmatch(r"(\d{1,3})\s*/\s*(\d{1,3})", value)
        if not match:
            return None
        count, maximum = map(int, match.groups())
        return {"count": count, "max": maximum} if maximum > 0 else None
    if not re.fullmatch(r"(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})", value):
        return None
    return {"count": int(value.replace(",", ""))}


def parse_raw_reading(key, result):
    """Reject an uncertain full line; never remove individual OCR characters."""
    if not isinstance(result, dict):
        return None
    text, scores = result.get("text"), result.get("char_scores")
    if not isinstance(text, str) or not isinstance(scores, list) or len(scores) != len(text):
        return None
    for char, score in zip(text, scores):
        if (isinstance(score, bool) or not isinstance(score, (int, float))
                or not 0 <= score <= 1 or not math.isfinite(score)):
            return None
        if (char.isdecimal() or char in ",/") and score <= 0.5:
            return None
    return parse_reading(key, text)


def _read_region(baas, key, region):
    try:
        image = baas.ocr.get_area_img(baas.latest_img_array, region, baas.ratio)
        response = baas.ocr.client.ocr_for_single_line(
            language="en-us", origin_image=image,
            candidates="0123456789/" if key == "ap" else "0123456789,",
            pass_method=1,
        )
        if response.status_code != 200:
            raise ValueError("OCR response status " + str(response.status_code))
        return parse_raw_reading(key, json.loads(response.text))
    except Exception as error:
        baas.logger.warning("Home " + key + " OCR failed; preserving previous reading: " + str(error))
        return None


def update_home_assets(baas):
    if (os.getenv("BAAS_ANDROID") != "1"
            or os.getenv("BAAS_ANDROID_NATIVE_CAPTURE") != "1"
            or getattr(baas, "server", None) != "CN"):
        return False
    previous = {}
    recorded = set()
    for _ in range(4):
        if not baas.flag_run:
            return True
        time.sleep(0.5)
        if not baas.flag_run:
            return True
        baas.update_screenshot_array()
        for key, region in REGIONS.items():
            if key in recorded:
                continue
            reading = _read_region(baas, key, region)
            if reading is not None and previous.get(key) == reading:
                baas.config_set.set(key, {**reading, "time": time.time()})
                recorded.add(key)
            previous[key] = reading
        if len(recorded) == len(REGIONS):
            break
    for key in REGIONS.keys() - recorded:
        baas.logger.warning("Unstable home resource reading; preserving previous " + key)
    return True
