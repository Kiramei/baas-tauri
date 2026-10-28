"""Publish native Android captures after local account-identifier blurring."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

import av
from PIL import Image, ImageChops, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
SIZE = (720, 1280)
ACCOUNT_BOX = (600, 132, 696, 152)
PREVIEW_BOX = (21, 129, 699, 510)
BLUR_RADIUS = 14
SOURCE_FILES = [
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/NativeGamePreview.kt",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/PreviewFrameProgress.kt",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/MainActivity.kt",
    "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri/ShizukuController.kt",
    "src/android/components/AndroidGamePanel.tsx",
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def blur_account(image):
    before = image.convert("RGBA")
    if before.size != SIZE:
        raise ValueError("Unexpected native capture dimensions")
    after = before.copy()
    after.paste(before.crop(ACCOUNT_BOX).filter(ImageFilter.GaussianBlur(BLUR_RADIUS)), ACCOUNT_BOX)
    changed = False
    for original, output in zip(before.split(), after.split()):
        bounds = ImageChops.difference(original, output).getbbox()
        if bounds:
            changed = True
            if not (ACCOUNT_BOX[0] <= bounds[0] < bounds[2] <= ACCOUNT_BOX[2]
                    and ACCOUNT_BOX[1] <= bounds[1] < bounds[3] <= ACCOUNT_BOX[3]):
                raise AssertionError("Pixels outside the account blur changed")
    if not changed:
        raise ValueError("The account blur changed no pixels; inspect the capture")
    return after


def publish_png(source, destination):
    with Image.open(source) as image:
        after = blur_account(image)
    after.save(destination, optimize=True)
    return {"file": destination.relative_to(ROOT / "docs/public").as_posix(),
            "sourceSha256": digest(source.read_bytes()), "sha256": digest(destination.read_bytes()),
            "width": SIZE[0], "height": SIZE[1], "outsideChangedPixels": 0}


def publish_motion(source, destination):
    selected, timestamps, source_hashes = [], [], []
    decoded = 0
    next_time = 0
    first_time = None
    last_time = None
    with av.open(str(source)) as video:
        stream = video.streams.video[0]
        if (stream.width, stream.height) != SIZE:
            raise ValueError("Unexpected native recording geometry")
        for frame in video.decode(stream):
            decoded += 1
            if frame.time is None:
                raise ValueError("The recording has no presentation timestamp")
            if first_time is None:
                first_time = frame.time
            elapsed = frame.time - first_time
            last_time = elapsed
            if len(selected) >= 60 or elapsed + 0.0001 < next_time:
                continue
            image = frame.to_image()
            source_hashes.append(digest(image.crop(PREVIEW_BOX).tobytes()))
            image = blur_account(image).convert("RGB")
            image.thumbnail((480, 854), Image.Resampling.LANCZOS)
            selected.append(image)
            timestamps.append(elapsed)
            next_time = len(selected) / 15
    if len(selected) != 60 or len(set(source_hashes)) < 45:
        raise ValueError("Insufficient independently changing native frames")
    # One palette avoids color flicker in the static application chrome.
    palette_source = Image.new("RGB", (960, 170 * 6), "white")
    for index, image in enumerate(selected):
        palette_source.paste(image.resize((96, 170), Image.Resampling.LANCZOS),
                             ((index % 10) * 96, (index // 10) * 170))
    palette = palette_source.quantize(colors=256)
    frames = [image.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG) for image in selected]
    durations = [70, 60, 70] * 20
    frames[0].save(destination, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, optimize=True, disposal=1)
    with Image.open(destination) as gif:
        if gif.n_frames != 60:
            raise AssertionError("GIF encoding lost frames")
        rendered = []
        duration = 0
        for index in range(gif.n_frames):
            gif.seek(index)
            duration += gif.info["duration"]
            rendered.append(digest(gif.convert("RGB").tobytes()))
    if duration != 4000 or len(set(rendered)) < 45:
        raise AssertionError("The published animation is static or has the wrong duration")
    return {"file": destination.relative_to(ROOT / "docs/public").as_posix(),
            "sourceSha256": digest(source.read_bytes()), "sha256": digest(destination.read_bytes()),
            "width": selected[0].width, "height": selected[0].height,
            "sourceDecodedFrames": decoded, "sourceDurationSeconds": last_time,
            "sourcePreviewUniqueFrames": len(set(source_hashes)), "selectedTimestampsSeconds": timestamps,
            "frames": 60, "uniqueFrames": len(set(rendered)), "durationMs": duration,
            "outputFps": 15, "lossyPaletteEncoding": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_directory", type=Path)
    parser.add_argument("source_root", type=Path)
    parser.add_argument("--restoration", type=Path, required=True)
    args = parser.parse_args()
    cache = args.capture_directory.resolve()
    if not cache.is_relative_to(ROOT / ".cache"):
        raise ValueError("Raw captures must remain in the ignored cache")
    record = json.loads((cache / "capture.json").read_text(encoding="utf-8"))
    restoration = json.loads(args.restoration.read_text(encoding="utf-8"))
    for key in ("configsUnchanged", "eventsUnchanged", "displayInactive", "gameStopped", "otherProfilesUnchanged"):
        if restoration.get(key) is not True:
            raise ValueError("Incomplete session restoration: " + key)
    for key in ("gameProcessUnchanged", "languageRestored", "configsAndEventsUnchanged"):
        if record.get(key) is not True:
            raise ValueError("Incomplete native capture: " + key)
    if record["gameInputSent"] or record["tasksStarted"]:
        raise ValueError("This recording must not send game input or run tasks")
    if len(record["captures"]) != 4 or len(record["videos"]) != 2:
        raise ValueError("Expected both native views and one recording per locale")
    revision = record["revision"]
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Expected the capture's immutable source revision")
    resolved = subprocess.check_output(["git", "rev-parse", "--verify", revision + "^{commit}"], cwd=args.source_root, text=True).strip()
    if resolved != revision:
        raise ValueError("The archived capture commit is unavailable")
    sources = []
    for file in SOURCE_FILES:
        committed = subprocess.check_output(["git", "show", revision + ":" + file], cwd=args.source_root).replace(b"\r\n", b"\n")
        sources.append({"file": file, "sha256": digest(committed), "gitContentVerified": True})
    manifest_path = ROOT / "docs/evidence/android-native-media.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    files = []
    for item in record["captures"]:
        locale, state = item["locale"], item["state"]
        if locale not in ("zh", "en") or state not in ("game-preview", "game-controls"):
            raise ValueError("Unexpected capture state")
        source = cache / item["file"]
        if source.parent != cache or digest(source.read_bytes()) != item["sourceSha256"]:
            raise ValueError("Raw capture changed")
        destination = ROOT / f"docs/public/media/android/{locale}/{state}.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        files.append({"locale": locale, "state": state, **publish_png(source, destination)})
    for item in record["videos"]:
        locale = item["locale"]
        if locale not in ("zh", "en"):
            raise ValueError("Unexpected recording locale")
        source = cache / item["file"]
        if source.parent != cache or digest(source.read_bytes()) != item["sourceSha256"]:
            raise ValueError("Raw recording changed")
        destination = ROOT / f"docs/public/media/android/{locale}/game-preview.gif"
        files.append({"locale": locale, "state": "game-motion", **publish_motion(source, destination)})
    manifest = {
        "publishedAt": datetime.now(timezone.utc).isoformat(), "capturedAt": record["capturedAt"],
        "applicationId": "io.github.kiramei.baas_tauri.docs.x86", "sourceRevision": revision,
        "apkSha256": record["apkSha256"], "publisherSha256": digest(Path(__file__).read_bytes().replace(b"\r\n", b"\n")),
        "captureHarnessSha256": digest((cache / "capture.mjs").read_bytes().replace(b"\r\n", b"\n")),
        "sources": sources, "nativePhysicalDisplayCapture": True, "theme": "light",
        "gameInputSent": False, "tasksStarted": False, "languageRestored": True,
        "configsAndEventsUnchanged": True,
        "sessionRestored": True, "restorationSha256": digest(args.restoration.read_bytes()),
        "privacy": {"method": "Local Pillow Gaussian blur before PNG publication and before GIF resizing/palette encoding",
                    "category": "game-account-identifier", "sourceRegion": list(ACCOUNT_BOX), "radius": BLUR_RADIUS,
                    "pngOutsideChangedPixels": 0, "rawSourcesPublished": False},
        "visualReview": {"checked": False}, "files": files,
    }
    previous_hashes = {item["file"]: item["sha256"] for item in previous.get("files", [])}
    current_hashes = {item["file"]: item["sha256"] for item in files}
    if previous_hashes == current_hashes and previous.get("visualReview", {}).get("checked") is True:
        manifest["visualReview"] = {**previous["visualReview"], "retainedForIdenticalAssetHashes": True}
    manifest_path.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"files": len(files), "gifFrames": sum(item.get("frames", 0) for item in files),
                      "pngOutsideChangedPixels": 0}))


if __name__ == "__main__":
    main()
