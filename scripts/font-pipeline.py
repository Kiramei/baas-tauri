#!/usr/bin/env python3
import os
import re
import json
import hashlib
import subprocess
from pathlib import Path

# 配置区 -------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_DIRS = [PROJECT_ROOT / "src", PROJECT_ROOT / "public"]
ORIGIN_FONT = PROJECT_ROOT / "scripts" / "fonts-src" / "SourceHanSans-VF.otf.ttc"
OUTPUT_DIR = PROJECT_ROOT / ".cache" / "fonts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

FONT_NUMBER = 0

OUTPUT_FONT = None
CACHE_FILE = OUTPUT_DIR / ".font-subset-cache.json"
OUTPUT_FONT_DIR = PROJECT_ROOT / "public" / "fonts"

FONT_VARIANTS = {
    "SC": 2,  # CJK Unified Ideographs
    "JP": 0,  # Japanese Hiragana + Katakana + Kanji
}


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


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    return {}


def save_cache(data):
    CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run_pyftsubset(textfile: Path):
    cmd = [
        "pyftsubset",
        str(ORIGIN_FONT),
        f"--font-number={FONT_NUMBER}",
        f"--output-file={OUTPUT_FONT}",
        f"--text-file={textfile}",
        "--flavor=woff2",
        "--layout-features='*'",
        "--with-zopfli",
    ]
    print("Running:", " ".join(cmd))
    subprocess.check_call(" ".join(cmd), shell=True)


def main():
    global OUTPUT_FONT, OUTPUT_FONT_DIR, FONT_NUMBER

    collected = collect_chars()
    current_hash = calc_hash(collected)
    cache = load_cache()
    last_hash = cache.get("chars_hash")

    if last_hash == current_hash:
        for tag, _ in FONT_VARIANTS.items():
            if not (OUTPUT_FONT_DIR / f"SourceHanSans-Subset-{tag}.woff2").exists():
                break
        print("✅ Font subset up-to-date. Skip.")
        return

    tmp_chars = OUTPUT_DIR / ".subset-chars.txt"
    tmp_chars.write_text(collected, encoding="utf-8")

    for tag, number in FONT_VARIANTS.items():
        OUTPUT_FONT = OUTPUT_FONT_DIR / f"SourceHanSans-Subset-{tag}.woff2"
        FONT_NUMBER = number
        run_pyftsubset(tmp_chars)

    cache["chars_hash"] = current_hash
    cache["output_font"] = str(OUTPUT_FONT)
    save_cache(cache)
    print("✅ Font subset generated:", OUTPUT_FONT)


if __name__ == "__main__":
    main()
