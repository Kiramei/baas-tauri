from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image


INTER_AREA = 3
TM_SQDIFF = 0
TM_CCOEFF_NORMED = 5
IMREAD_UNCHANGED = -1
IMREAD_GRAYSCALE = 0
IMREAD_COLOR = 1
COLOR_BGRA2BGR = 1
COLOR_BGRA2RGB = 2
COLOR_RGB2BGR = 4
COLOR_BGR2RGB = 4
COLOR_BGR2GRAY = 6
COLOR_RGB2GRAY = 7
COLOR_BGR2HSV = 40
ROTATE_90_CLOCKWISE = 0
CC_STAT_LEFT = 0
CC_STAT_TOP = 1
CC_STAT_WIDTH = 2
CC_STAT_HEIGHT = 3
CC_STAT_AREA = 4

__all__ = [
    "INTER_AREA",
    "TM_SQDIFF",
    "TM_CCOEFF_NORMED",
    "IMREAD_UNCHANGED",
    "IMREAD_GRAYSCALE",
    "IMREAD_COLOR",
    "COLOR_BGRA2BGR",
    "COLOR_BGRA2RGB",
    "COLOR_RGB2BGR",
    "COLOR_BGR2RGB",
    "COLOR_BGR2GRAY",
    "COLOR_RGB2GRAY",
    "COLOR_BGR2HSV",
    "ROTATE_90_CLOCKWISE",
    "CC_STAT_LEFT",
    "CC_STAT_TOP",
    "CC_STAT_WIDTH",
    "CC_STAT_HEIGHT",
    "CC_STAT_AREA",
    "imread",
    "imwrite",
    "imdecode",
    "imencode",
    "cvtColor",
    "resize",
    "rotate",
    "flip",
    "inRange",
    "bitwise_or",
    "connectedComponentsWithStats",
    "minMaxLoc",
    "matchTemplate",
]


# Handles the imread workflow.
def imread(path, flags=IMREAD_COLOR):
    try:
        image = Image.open(path)
    except OSError:
        return None
    return _pil_to_cv_array(image, flags)


# Handles the imwrite workflow.
def imwrite(path, image):
    _cv_array_to_pil(image).save(path)
    return True


# Handles the imdecode workflow.
def imdecode(buf, flags=IMREAD_COLOR):
    data = np.asarray(buf, dtype=np.uint8).tobytes()
    return _pil_to_cv_array(Image.open(BytesIO(data)), flags)


# Handles the imencode workflow.
def imencode(ext, image):
    output = BytesIO()
    fmt = "PNG" if str(ext).lower().endswith("png") else "JPEG"
    _cv_array_to_pil(image).save(output, format=fmt)
    return True, np.frombuffer(output.getvalue(), dtype=np.uint8)


# Handles the cvt color workflow.
def cvtColor(image, code):
    arr = np.asarray(image)
    if code == COLOR_RGB2BGR or code == COLOR_BGR2RGB:
        return arr[..., ::-1].copy()
    if code == COLOR_BGRA2BGR:
        return arr[..., :3].copy()
    if code == COLOR_BGRA2RGB:
        return arr[..., :3][..., ::-1].copy()
    if code == COLOR_BGR2GRAY:
        return _to_gray(arr[..., ::-1])
    if code == COLOR_RGB2GRAY:
        return _to_gray(arr)
    if code == COLOR_BGR2HSV:
        return _bgr_to_hsv(arr)
    raise RuntimeError("cv2.cvtColor code is unsupported on Android: %s" % code)


# Handles the resize workflow.
def resize(image, dsize, interpolation=INTER_AREA):
    pil = _cv_array_to_pil(image)
    resample = Image.Resampling.BOX if interpolation == INTER_AREA else Image.Resampling.BILINEAR
    return _pil_to_cv_array(pil.resize(tuple(dsize), resample=resample), IMREAD_UNCHANGED)


# Handles the rotate workflow.
def rotate(image, code):
    if code != ROTATE_90_CLOCKWISE:
        raise RuntimeError("cv2.rotate code is unsupported on Android: %s" % code)
    return np.rot90(np.asarray(image), k=3).copy()


# Handles the flip workflow.
def flip(image, flipCode, dst=None):
    arr = np.asarray(image)
    if flipCode == 0:
        result = arr[::-1].copy()
    elif flipCode == 1:
        result = arr[:, ::-1].copy()
    elif flipCode == -1:
        result = arr[::-1, ::-1].copy()
    else:
        raise RuntimeError("cv2.flip code is unsupported on Android: %s" % flipCode)
    if dst is not None:
        dst[...] = result
        return dst
    return result


# Handles the in range workflow.
def inRange(src, lowerb, upperb):
    arr = np.asarray(src)
    lower = np.asarray(lowerb, dtype=arr.dtype)
    upper = np.asarray(upperb, dtype=arr.dtype)
    mask = np.all((arr >= lower) & (arr <= upper), axis=-1)
    return (mask.astype(np.uint8) * 255)


# Handles the bitwise or workflow.
def bitwise_or(src1, src2):
    return np.bitwise_or(np.asarray(src1), np.asarray(src2)).astype(np.uint8)


# Performs the connected components with stats operation.
def connectedComponentsWithStats(image, connectivity=8):
    mask = np.asarray(image) != 0
    height, width = mask.shape[:2]
    labels = np.zeros((height, width), dtype=np.int32)
    stats = [[0, 0, width, height, int((~mask).sum())]]
    centers = [[width / 2 if width else 0, height / 2 if height else 0]]
    component_id = 0
    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    if connectivity == 8:
        neighbors += [(-1, -1), (-1, 1), (1, -1), (1, 1)]

    for start_y in range(height):
        for start_x in range(width):
            if not mask[start_y, start_x] or labels[start_y, start_x] != 0:
                continue
            component_id += 1
            stack = [(start_x, start_y)]
            labels[start_y, start_x] = component_id
            xs = []
            ys = []
            while stack:
                x, y = stack.pop()
                xs.append(x)
                ys.append(y)
                for dx, dy in neighbors:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and labels[ny, nx] == 0:
                        labels[ny, nx] = component_id
                        stack.append((nx, ny))
            left = min(xs)
            top = min(ys)
            area = len(xs)
            stats.append([left, top, max(xs) - left + 1, max(ys) - top + 1, area])
            centers.append([float(sum(xs) / area), float(sum(ys) / area)])

    return component_id + 1, labels, np.asarray(stats, dtype=np.int32), np.asarray(centers, dtype=np.float64)


# Handles the min max loc workflow.
def minMaxLoc(src):
    arr = np.asarray(src)
    min_index = np.unravel_index(np.argmin(arr), arr.shape)
    max_index = np.unravel_index(np.argmax(arr), arr.shape)
    min_val = float(arr[min_index])
    max_val = float(arr[max_index])
    return min_val, max_val, (int(min_index[1]), int(min_index[0])), (int(max_index[1]), int(max_index[0]))


# Handles the match template workflow.
def matchTemplate(image, templ, method):
    source = _to_match_array(image)
    target = _to_match_array(templ)
    ih, iw = source.shape[:2]
    th, tw = target.shape[:2]
    if th > ih or tw > iw:
        raise RuntimeError("template is larger than image")

    out_h = ih - th + 1
    out_w = iw - tw + 1
    result = np.empty((out_h, out_w), dtype=np.float32)
    target64 = target.astype(np.float64)
    target_mean = target64.mean()
    target_centered = target64 - target_mean
    target_norm = np.sqrt(np.sum(target_centered * target_centered))

    for y in range(out_h):
        rows = source[y:y + th]
        for x in range(out_w):
            patch = rows[:, x:x + tw].astype(np.float64)
            if method == TM_SQDIFF:
                diff = patch - target64
                result[y, x] = float(np.sum(diff * diff))
            elif method == TM_CCOEFF_NORMED:
                centered = patch - patch.mean()
                denom = np.sqrt(np.sum(centered * centered)) * target_norm
                result[y, x] = 0.0 if denom == 0 else float(np.sum(centered * target_centered) / denom)
            else:
                raise RuntimeError("cv2.matchTemplate method is unsupported on Android: %s" % method)
    return result


# Handles the pil to cv array workflow.
def _pil_to_cv_array(image, flags):
    if flags == IMREAD_GRAYSCALE:
        return np.array(image.convert("L"))
    if flags == IMREAD_UNCHANGED and image.mode == "RGBA":
        arr = np.array(image.convert("RGBA"))
        return arr[..., [2, 1, 0, 3]].copy()
    arr = np.array(image.convert("RGB"))
    return arr[..., ::-1].copy()


# Handles the cv array to pil workflow.
def _cv_array_to_pil(image):
    arr = np.asarray(image)
    if arr.ndim == 2:
        return Image.fromarray(arr.astype(np.uint8), "L")
    if arr.shape[2] == 4:
        return Image.fromarray(arr[..., [2, 1, 0, 3]].astype(np.uint8), "RGBA")
    return Image.fromarray(arr[..., ::-1].astype(np.uint8), "RGB")


# Handles the to gray workflow.
def _to_gray(rgb):
    arr = np.asarray(rgb, dtype=np.float32)
    return np.clip(arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114, 0, 255).astype(np.uint8)


# Handles the bgr to hsv workflow.
def _bgr_to_hsv(bgr):
    arr = np.asarray(bgr, dtype=np.float32) / 255.0
    b = arr[..., 0]
    g = arr[..., 1]
    r = arr[..., 2]
    maxc = np.max(arr, axis=-1)
    minc = np.min(arr, axis=-1)
    delta = maxc - minc

    hue = np.zeros_like(maxc)
    nonzero = delta != 0
    red = (maxc == r) & nonzero
    green = (maxc == g) & nonzero
    blue = (maxc == b) & nonzero
    hue[red] = ((g[red] - b[red]) / delta[red]) % 6
    hue[green] = ((b[green] - r[green]) / delta[green]) + 2
    hue[blue] = ((r[blue] - g[blue]) / delta[blue]) + 4
    hue = hue * 30.0

    saturation = np.zeros_like(maxc)
    value_nonzero = maxc != 0
    saturation[value_nonzero] = delta[value_nonzero] / maxc[value_nonzero] * 255.0
    value = maxc * 255.0
    return np.stack([hue, saturation, value], axis=-1).astype(np.uint8)


# Handles the to match array workflow.
def _to_match_array(image):
    arr = np.asarray(image)
    if arr.ndim == 2:
        return arr[..., None]
    return arr


# Handles the getattr workflow.
def __getattr__(name):
    if name.startswith("__") and name.endswith("__"):
        raise AttributeError(name)
    raise RuntimeError("cv2.%s is not implemented by the Android compatibility layer" % name)
