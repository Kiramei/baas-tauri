"""Strict CN inventory-full handling for the Android native-capture adapter.

BAAS_ANDROID_INVENTORY_FULL_GUARD_V1
Never click a generic confirmation or spend/organize inventory. Only the exact
verified notice may be dismissed using its X, then reported as unclaimed.
"""
import json
import math
import os
import time
import unicodedata


CLAIM_TASKS = frozenset({"mail", "collect_daily_power", "collect_reward"})
REGIONS = (
    (595, 118, 687, 157),
    (490, 390, 780, 421),
    (530, 422, 750, 454),
    (590, 503, 690, 548),
)
EXPECTED = ("通知", "以上道具的库存已满。", "请先整理库存。", "确认")
CHECK_TIMEOUT = 8.0
CLOSE_POSITION = (910, 138)
_ATTEMPT = "_android_inventory_full_close_attempt"


class InventoryFull(RuntimeError):
    def __init__(self, closed, detail=""):
        super().__init__("Inventory full; rewards remain unclaimed. " + detail)
        self.closed = closed


def _enabled(baas):
    return (os.getenv("BAAS_ANDROID") == "1"
            and os.getenv("BAAS_ANDROID_NATIVE_CAPTURE") == "1"
            and getattr(baas, "server", None) == "CN")


def has_inventory_full_layout(image):
    if (image is None or getattr(image, "ndim", 0) < 3
            or tuple(image.shape[:2]) != (720, 1280)):
        return False

    def rgb(x, y):
        b, g, r = image[y, x, :3]
        return int(r), int(g), int(b)

    for x, y in ((580, 120), (700, 120), (360, 375), (380, 580)):
        pixel = rgb(x, y)
        if min(pixel) < 230 or max(pixel) - min(pixel) > 25:
            return False
    for x, y in ((920, 375), (880, 580)):
        r, g, b = rgb(x, y)
        if not (190 <= r <= 250 and r <= g <= 255 and g <= b <= 255):
            return False
    for x, y in ((900, 128), (910, 138), (920, 148)):
        r, g, b = rgb(x, y)
        if not (20 <= r <= 80 and 40 <= g <= 110 and 60 <= b <= 140):
            return False
    for x, y in ((540, 505), (740, 505), (545, 552), (730, 552)):
        r, g, b = rgb(x, y)
        if not (50 <= r <= 150 and 175 <= g <= 245 and b >= 230):
            return False
    return True


def _valid_reference_frame(image):
    if (image is None or getattr(image, "ndim", 0) < 3
            or tuple(image.shape[:2]) != (720, 1280)):
        return False
    # A blank/black/transition frame is not proof that clicking X dismissed a
    # notice. Require visible, non-uniform UI in each of two fresh captures.
    try:
        samples = [tuple(map(int, image[y, x, :3])) for x, y in
                   ((60, 40), (640, 40), (1240, 40), (350, 360), (640, 360),
                    (900, 360), (60, 680), (640, 680), (1240, 680))]
        values = [value for sample in samples for value in sample]
        spatial_range = max(max(sample[channel] for sample in samples)
                            - min(sample[channel] for sample in samples) for channel in range(3))
        return min(values) >= 0 and max(values) <= 255 and max(values) >= 100 and spatial_range >= 50
    except (TypeError, ValueError, IndexError):
        return False


def _reference_ratio(baas):
    ratio = getattr(baas, "ratio", None)
    return not isinstance(ratio, bool) and isinstance(ratio, (int, float)) and ratio == 1


def _text(result):
    """Preserve the whole OCR line: never drop uncertain characters into a match."""
    if not isinstance(result, dict):
        return None
    text, scores = result.get("text"), result.get("char_scores")
    if not isinstance(text, str) or not isinstance(scores, list) or len(scores) != len(text):
        return None
    for char, score in zip(text, scores):
        if (isinstance(score, bool) or not isinstance(score, (int, float))
                or not 0 <= score <= 1 or not math.isfinite(score)
                or (not char.isspace() and score < 0.8)):
            return None
    # OCR may use ASCII instead of Chinese full stops; no words are removed.
    return "".join(unicodedata.normalize("NFKC", text).split()).replace(".", "。")


def matches_inventory_full_text(results):
    return isinstance(results, (list, tuple)) and tuple(map(_text, results)) == EXPECTED


def _read_line(baas, frame, ratio, region, remaining):
    # The shared client has an unbounded requests.post. Reuse its image encoder
    # and exact multipart protocol, but bound this safety decision's I/O.
    import requests

    client = baas.ocr.client
    image = baas.ocr.get_area_img(frame, region, ratio)
    data = {"language": "zh-cn", "candidates": "", "image": {"pass_method": 1}}
    response = requests.post(
        client.config.base_url + "/ocr_for_single_line",
        files={"data": (None, json.dumps(data), "application/json"),
               "image": ("image.png", client.get_image_bytes(image), "image/png")},
        timeout=(min(0.5, remaining), min(1.0, remaining)),
    )
    try:
        if response.status_code != 200:
            raise ValueError("OCR response status " + str(response.status_code))
        return json.loads(response.text)
    finally:
        response.close()


def _read_notice(baas, deadline):
    frame, ratio = baas.latest_img_array, baas.ratio
    results = []
    for region in REGIONS:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Inventory notice OCR deadline reached")
        if not baas.flag_run:
            return None
        results.append(_read_line(baas, frame, ratio, region, remaining))
    return results


def handle_inventory_full(baas):
    """Raise InventoryFull only for the exact notice; return False otherwise.

    A successful close is intentionally not a successful claim. Its task owner
    decides whether this particular unclaimed activity may be safely skipped.
    """
    if not _enabled(baas) or not baas.flag_run:
        return False
    if not has_inventory_full_layout(getattr(baas, "latest_img_array", None)):
        setattr(baas, _ATTEMPT, None)
        return False
    if not _reference_ratio(baas):
        raise InventoryFull(False, "Inventory-shaped notice has an unexpected capture ratio; no action.")
    if getattr(baas, _ATTEMPT, None) is not None:
        raise InventoryFull(False, "An earlier X close is still unverified; not clicking again.")

    deadline = time.monotonic() + CHECK_TIMEOUT
    try:
        # The caller's cached image is only a cheap probe, not a confirmation.
        baas.update_screenshot_array()
        if not baas.flag_run:
            return False
        if not _reference_ratio(baas) or not has_inventory_full_layout(baas.latest_img_array):
            raise InventoryFull(False, "Notice changed before its first fresh confirmation; no action.")
        first = _read_notice(baas, deadline)
    except InventoryFull:
        raise
    except Exception as error:
        raise InventoryFull(False, "Inventory-shaped notice OCR unavailable; no action: " + str(error)) from error
    if not baas.flag_run:
        return False
    if not matches_inventory_full_text(first):
        raise InventoryFull(False, "Notice text does not exactly match inventory full; no action.")

    time.sleep(0.15)
    if not baas.flag_run:
        return False
    try:
        baas.update_screenshot_array()
        if not baas.flag_run:
            return False
        if not _reference_ratio(baas) or not has_inventory_full_layout(baas.latest_img_array):
            raise InventoryFull(False, "Notice changed before its second fresh confirmation; no action.")
        second = _read_notice(baas, deadline)
    except InventoryFull:
        raise
    except Exception as error:
        raise InventoryFull(False, "Second-frame capture/OCR failed; no close attempted: " + str(error)) from error
    if not baas.flag_run:
        return False
    if not matches_inventory_full_text(second):
        raise InventoryFull(False, "Second-frame text is not the complete verified notice; no action.")
    if not _reference_ratio(baas):
        raise InventoryFull(False, "Capture ratio changed during confirmation; no action.")
    if time.monotonic() >= deadline:
        raise InventoryFull(False, "Recognition deadline reached; no close attempted.")

    # Set before sending: a failure/late frame must never retry the same X.
    setattr(baas, _ATTEMPT, time.monotonic())
    baas.logger.warning("Confirmed inventory-full notice in two frames; closing X only, not claiming or spending.")
    try:
        baas.click(*CLOSE_POSITION, wait_over=True)
        baas.last_click_time = time.time()
        baas.last_click_position = CLOSE_POSITION
        baas.last_click_name = "android_inventory_full_close"
        absent = 0
        for _ in range(5):
            if not baas.flag_run or time.monotonic() >= deadline:
                break
            time.sleep(0.15)
            if not baas.flag_run:
                break
            baas.update_screenshot_array()
            if not baas.flag_run:
                break
            absent = (absent + 1 if _reference_ratio(baas)
                      and _valid_reference_frame(baas.latest_img_array)
                      and not has_inventory_full_layout(baas.latest_img_array) else 0)
            if absent >= 2:
                # Two valid frames prove this attempt finished. A later claim
                # may legitimately produce another notice with identical text.
                setattr(baas, _ATTEMPT, None)
                raise InventoryFull(True, "Verified the notice closed using its X.")
    except InventoryFull:
        raise
    except Exception as error:
        raise InventoryFull(False, "X close failed; no retry: " + str(error)) from error
    raise InventoryFull(False, "X close was not verified within the bounded check; no retry.")


def finish_inventory_full_task(baas, activity, error):
    if _enabled(baas) and baas.flag_run and error.closed and activity in CLAIM_TASKS:
        baas.next_time = 0
        baas.logger.warning("SKIPPED " + str(activity) + " due to inventory full; rewards remain unclaimed. "
                            "库存已满，仅跳过本次领取；未整理库存、未消耗任何资源。")
        return True  # Scheduler continuation only, never a claim-success log.
    baas.logger.error("Inventory-full notice requires manual handling for task " + str(activity)
                      + "; stopping without restarting or spending. " + str(error))
    baas.signal_stop()
    return False


def check_claim_task_result(baas, activity, result):
    """Check the post-claim frame before a successful module advances scheduling."""
    if result and activity in CLAIM_TASKS and _enabled(baas) and baas.flag_run:
        baas.update_screenshot_array()
        handle_inventory_full(baas)
    return result
