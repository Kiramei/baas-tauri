"""Identify the embedded interpreter's ABI independently of the kernel ABI."""
import os
from pathlib import Path


def machine():
    library_dir = os.environ.get("BAAS_ANDROID_NATIVE_LIBRARY_DIR", "").strip()
    if not library_dir:
        raise RuntimeError("The embedded Python native library directory is unavailable")
    with (Path(library_dir) / "libchaquopy_java.so").open("rb") as library:
        header = library.read(20)
    if len(header) != 20 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] not in (1, 2):
        raise RuntimeError("Android OCR requires a valid 64-bit embedded Python library")
    architecture = int.from_bytes(header[18:20], "little" if header[5] == 1 else "big")
    machines = {62: "x86_64", 183: "aarch64"}
    if architecture not in machines:
        raise RuntimeError("Unsupported embedded Python ELF architecture: " + str(architecture))
    return machines[architecture]
