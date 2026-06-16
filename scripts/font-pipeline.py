#!/usr/bin/env python3
import os
import re
import json
import hashlib
import subprocess
import sys
from pathlib import Path

# 配置区 -------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_DIRS = [PROJECT_ROOT / "src", PROJECT_ROOT / "public"]
FONT_SOURCE_DIR = PROJECT_ROOT / "scripts" / "fonts-src"
OUTPUT_DIR = PROJECT_ROOT / ".cache" / "fonts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

CACHE_FILE = OUTPUT_DIR / ".font-subset-cache.json"
OUTPUT_FONT_DIR = PROJECT_ROOT / "public" / "fonts"

LATIN_RANGES = [
    (0x0020, 0x007E),
    (0x00A0, 0x00FF),
    (0x0100, 0x017F),
    (0x0180, 0x024F),
    (0x1E00, 0x1EFF),
    (0xFF00, 0xFFEF),
]

FONT_TARGETS = [
    {
        "key": "blueaka",
        "family": "Blueaka",
        "source": FONT_SOURCE_DIR / "Blueaka.ttf",
        "output": OUTPUT_FONT_DIR / "Blueaka-Subset.woff2",
        "ranges": LATIN_RANGES
        + [
            (0x0370, 0x03FF),
            (0x4E00, 0x9FFF),
            (0x3040, 0x30FF),
        ],
    },
    {
        "key": "nanum_square_round",
        "family": "NanumSquareRound",
        "source": FONT_SOURCE_DIR / "NanumSquareRound.ttf",
        "output": OUTPUT_FONT_DIR / "NanumSquareRound-Subset.woff2",
        "ranges": LATIN_RANGES + [(0xAC00, 0xD7AF)],
    },
    {
        "key": "rubik",
        "family": "Rubik",
        "source": FONT_SOURCE_DIR / "Rubik.ttf",
        "output": OUTPUT_FONT_DIR / "Rubik-Subset.woff2",
        "ranges": LATIN_RANGES
        + [
            (0x0400, 0x04FF),
            (0x0500, 0x052F),
        ],
    },
]


# --------------------------------------------------------


def collect_chars():
    chars = set()
    pattern = re.compile(
        r"["
        r"\u0020-\u007E"  # Basic Latin
        r"\u00A0-\u00FF"  # Latin-1 Supplement
        r"\u0100-\u017F"  # Latin Extended-A
        r"\u0180-\u024F"  # Latin Extended-B
        r"\u0370-\u03FF"  # Greek and Coptic
        r"\u0400-\u04FF"  # Cyrillic
        r"\u0500-\u052F"  # Cyrillic Supplement
        r"\u1E00-\u1EFF"  # Latin Extended Additional
        r"\u4E00-\u9FFF"  # CJK Unified Ideographs
        r"\u3040-\u30FF"  # Japanese Hiragana + Katakana
        r"\uAC00-\uD7AF"  # Hangul Syllables
        r"\uFF00-\uFFEF"  # Fullwidth forms
        r"]"
    )
    for d in SCAN_DIRS:
        if not d.exists():
            continue
        for root, _, files in os.walk(d):
            for name in files:
                if not name.endswith((".ts", ".tsx", ".js", ".jsx", ".vue",
                                      ".json", ".yaml", ".yml", ".html")):
                    continue
                p = Path(root) / name
                try:
                    text = p.read_text(encoding="utf-8")
                except Exception:
                    continue
                for m in pattern.findall(text):
                    chars.add(m)
    return "".join(sorted(chars))


def calc_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def calc_file_hash(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    return {}


def save_cache(data):
    CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def in_ranges(char: str, ranges) -> bool:
    code = ord(char)
    return any(start <= code <= end for start, end in ranges)


def filter_chars(chars: str, ranges) -> str:
    filtered = [char for char in chars if in_ranges(char, ranges)]
    return "".join(filtered) or " "


def run_pyftsubset(target, textfile: Path):
    OUTPUT_FONT_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(target["source"]),
        f"--output-file={target['output']}",
        f"--text-file={textfile}",
        "--flavor=woff2",
        "--layout-features=*",
        "--with-zopfli",
    ]
    print("Running:", " ".join(cmd))
    subprocess.check_call(cmd)


def main():
    for target in FONT_TARGETS:
        if not target["source"].exists():
            raise FileNotFoundError(f"Font source not found: {target['source']}")

    collected = collect_chars()
    cache = load_cache()
    target_cache = cache.get("targets", {})
    generated = []

    for target in FONT_TARGETS:
        target_chars = filter_chars(collected, target["ranges"])
        chars_hash = calc_hash(target_chars)
        source_hash = calc_file_hash(target["source"])
        cached = target_cache.get(target["key"], {})

        if (
            cached.get("chars_hash") == chars_hash
            and cached.get("source_hash") == source_hash
            and target["output"].exists()
        ):
            print(f"{target['family']} subset up-to-date. Skip.")
            continue

        tmp_chars = OUTPUT_DIR / f".subset-chars-{target['key']}.txt"
        tmp_chars.write_text(target_chars, encoding="utf-8")
        run_pyftsubset(target, tmp_chars)
        generated.append(str(target["output"]))

        target_cache[target["key"]] = {
            "font_family": target["family"],
            "source_font": str(target["source"]),
            "source_hash": source_hash,
            "chars_hash": chars_hash,
            "output_font": str(target["output"]),
        }

    cache["targets"] = target_cache
    save_cache(cache)
    if generated:
        print("Font subsets generated:", ", ".join(generated))
    else:
        print("Font subsets up-to-date. Skip.")


if __name__ == "__main__":
    main()
