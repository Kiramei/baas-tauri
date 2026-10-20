"""Encode captured native UI frames as an animated GIF, without UI overlays."""
import sys
from pathlib import Path
from PIL import Image

frames_path, destination = map(Path, sys.argv[1:])
frames = []
for frame_path in sorted(frames_path.glob("*.png")):
    with Image.open(frame_path) as source:
        frame = source.convert("RGB")
        frame.thumbnail((1120, 700), Image.Resampling.LANCZOS)
        frames.append(frame.copy())
if not frames:
    raise ValueError("No captured frames")
frames[0].save(destination, save_all=True, append_images=frames[1:], duration=160,
               loop=0, optimize=False, disposal=2)
