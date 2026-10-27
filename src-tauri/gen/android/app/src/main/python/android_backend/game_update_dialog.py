"""Recognize the CN game's resource download notice before generic popup rules.

This APK-owned adapter runs only in Android's native capture mode. Layout alone
never authorizes a click: every notice label must also pass strict Chinese OCR.
"""
import os
import re
import time
import unicodedata
from decimal import Decimal


class ManualGameUpdateRequired(RuntimeError):
    pass


def _compact(value):
    if isinstance(value, (tuple, list)):
        value = "".join(str(item) for item in value)
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or ""))).lower()


def _words(value):
    return re.sub(r"[\W_]+", "", _compact(value))


def has_download_layout(image):
    """Cheap fixed-layout gate, using the game's 1280x720 reference coordinates."""
    if image is None or getattr(image, "ndim", 0) < 3:
        return False
    height, width = image.shape[:2]
    if width < 640 or abs(width * 9 - height * 16) > 16:
        return False
    scale = width / 1280

    def rgb(x, y):
        b, g, r = image[min(height - 1, round(y * scale)),
                        min(width - 1, round(x * scale)), :3]
        return int(r), int(g), int(b)

    white = ((365, 220), (912, 220), (365, 400), (912, 400),
             (450, 420), (640, 420), (850, 420), (600, 150), (700, 150))
    if not all(min(rgb(x, y)) >= 215 and max(rgb(x, y)) - min(rgb(x, y)) <= 35
               for x, y in white):
        return False
    for x, y in ((680, 490), (850, 490), (680, 525), (850, 525)):
        r, g, b = rgb(x, y)
        if not (50 <= r <= 150 and 175 <= g <= 245 and b >= 230 and b - r >= 90):
            return False
    for x, y in ((420, 490), (600, 490)):
        r, g, b = rgb(x, y)
        if not (190 <= r <= 240 and g >= 215 and b >= 225 and 10 <= b - r <= 60):
            return False
    return sum(max(rgb(x, y)) < 205 for x, y in
               ((350, 300), (925, 300), (640, 125), (640, 590))) >= 3


def matches_download_text(title, download, question, cancel, confirm):
    amount = re.fullmatch(r"需要下载(\d+(?:\.\d+)?)(?:kb|mb|gb|kib|mib|gib)的更新包[。.]*",
                          _compact(download))
    return bool(amount and Decimal(amount.group(1)) > 0
                and _words(title) == "通知"
                and _words(question) == "是否继续推荐在wifi环境下载"
                and _words(cancel) == "取消" and _words(confirm) == "确认")


def _stop_for_manual_confirmation(baas, detail):
    message = "游戏资源更新提示无法安全自动确认，请手动确认后重新启动任务。" + detail
    baas.logger.error(message)
    baas.signal_stop()
    raise ManualGameUpdateRequired(message)


def handle_resource_update(baas):
    """Return True when a verified resource notice consumes this detection frame."""
    if (os.getenv("BAAS_ANDROID") != "1" or os.getenv("BAAS_ANDROID_NATIVE_CAPTURE") != "1"
            or getattr(baas, "server", None) != "CN"):
        return False
    if not has_download_layout(getattr(baas, "latest_img_array", None)):
        baas._android_resource_update_confirmation = None
        return False

    def read(region, label):
        return baas.ocr.get_region_res(baas, region, language="zh-cn",
                                       log_info="游戏资源更新" + label, filter_score=0.5)

    try:
        download = read((460, 300, 810, 334), "下载说明")
        question = read((410, 335, 860, 368), "网络提示")
    except Exception as error:
        _stop_for_manual_confirmation(baas, "更新样式弹窗的文字识别失败：" + str(error))
    text = _compact(download) + _compact(question)
    if "需要下载" not in text and "更新包" not in text:
        baas._android_resource_update_confirmation = None
        return False  # Ordinary game notices retain the original popup handling.
    try:
        title = read((595, 144, 688, 182), "标题")
        cancel = read((470, 485, 560, 526), "取消按钮")
        confirm = read((718, 485, 812, 526), "确认按钮")
    except Exception as error:
        _stop_for_manual_confirmation(baas, "更新提示的标题或按钮识别失败：" + str(error))
    if not matches_download_text(title, download, question, cancel, confirm):
        _stop_for_manual_confirmation(baas, "提示内容或按钮不符合已验证的资源下载窗口。")

    now = time.monotonic()
    previous = getattr(baas, "_android_resource_update_confirmation", None)
    signature = _compact(download)
    if previous and previous[0] == signature and now - previous[1] < 30:
        time.sleep(0.1)
        return True
    if previous and previous[0] == signature:
        _stop_for_manual_confirmation(baas, "确认后仍显示同一个下载窗口。")
    baas._android_resource_update_confirmation = (signature, now)
    baas.logger.info("已严格识别游戏资源更新通知，确认下载：" + str(download))
    baas.click(768, 504, wait_over=True)
    baas.last_click_time = time.time()
    baas.last_click_position = (768, 504)
    baas.last_click_name = "android_game_resource_update"
    return True
