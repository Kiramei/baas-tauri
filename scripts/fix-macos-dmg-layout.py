#!/usr/bin/env python3
"""Keep the Finder window of a Tauri-built DMG from scrolling.

Tauri's bundled create-dmg script parks the hidden `.background` folder at
`{window right edge + 100, 100}`. Finder still counts that hidden item when it
sizes the icon view, so the installer window can be scrolled sideways into
empty space. This rewrites the DMG with the hidden item's icon location moved
inside the window (between the app and Applications icons), where it stays
hidden.

The icon location is a fixed-size `Iloc` record in the volume's .DS_Store, so it
is patched in place: Finder is not involved, and the window bounds and every
other layout setting written by Tauri stay byte-for-byte unchanged.

Usage: fix-macos-dmg-layout.py <file.dmg> [<file.dmg> ...]

Needs macOS (hdiutil). No third-party Python modules are required.
"""

import json
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

MACOS_CONFIG = Path(__file__).resolve().parents[1] / "src-tauri/tauri.macos.conf.json"
HIDDEN_ITEMS = (".background", ".VolumeIcon.icns")
TOOL_TIMEOUT_SECONDS = 300


class LayoutError(Exception):
    """The DMG could not be rewritten as expected."""


def log(message):
    print("[dmg layout] " + message, flush=True)


def run(arguments, *, input_text=None):
    arguments = [str(argument) for argument in arguments]
    log("$ " + shlex.join(arguments))
    try:
        result = subprocess.run(
            arguments,
            capture_output=True,
            text=True,
            input=input_text,
            timeout=TOOL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise LayoutError("Could not complete {}: {}".format(arguments[0], error)) from error
    if result.returncode:
        output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        raise LayoutError("{} exited with {}:\n{}".format(shlex.join(arguments), result.returncode, output))
    return result.stdout


def hidden_item_position():
    dmg = json.loads(MACOS_CONFIG.read_text(encoding="utf-8"))["bundle"]["macOS"]["dmg"]
    app, folder = dmg["appPosition"], dmg["applicationFolderPosition"]
    return (app["x"] + folder["x"]) // 2, (app["y"] + folder["y"]) // 2


def patch_icon_locations(store, names, position):
    """Rewrite the `Iloc` record of each name in a .DS_Store, keeping its size."""
    data = bytearray(store.read_bytes())
    patched = []
    for name in names:
        record = struct.pack(">I", len(name)) + name.encode("utf-16-be") + b"Ilocblob" + struct.pack(">I", 16)
        offset = data.find(record)
        if offset < 0:
            continue
        if data.find(record, offset + 1) >= 0:
            raise LayoutError("Several icon locations for {} in {}".format(name, store))
        value = offset + len(record)
        data[value:value + 8] = struct.pack(">II", *position)
        patched.append(name)
    store.write_bytes(bytes(data))
    return patched


def attach(image, mountpoint):
    # Release DMGs embed the project license; accept its prompt once.
    run(
        ["hdiutil", "attach", "-readwrite", "-noverify", "-noautoopen", "-nobrowse", "-mountpoint", mountpoint, image],
        input_text="Y\n",
    )


def detach(mountpoint):
    try:
        run(["hdiutil", "detach", mountpoint])
    except LayoutError:
        run(["hdiutil", "detach", "-force", mountpoint])


def license_resources(dmg):
    """The embedded license agreement resources of a DMG, if it has any."""
    try:
        result = subprocess.run(["hdiutil", "udifderez", "-xml", str(dmg)], capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode or b"LPic" not in result.stdout:
        return None
    return result.stdout


def fix(dmg):
    dmg = Path(dmg).resolve()
    position = hidden_item_position()
    with tempfile.TemporaryDirectory(prefix="dmg-layout-") as temporary:
        temporary = Path(temporary)
        writable = temporary / "writable.dmg"
        output = temporary / "fixed.dmg"
        mountpoint = temporary / "mount"
        mountpoint.mkdir()

        run(["hdiutil", "convert", dmg, "-format", "UDRW", "-o", writable], input_text="Y\n")
        attach(writable, mountpoint)
        try:
            store = mountpoint / ".DS_Store"
            if not store.is_file():
                raise LayoutError("{} has no Finder layout (.DS_Store)".format(dmg))
            patched = patch_icon_locations(store, HIDDEN_ITEMS, position)
            if ".background" not in patched:
                raise LayoutError("No icon location for .background in {}".format(dmg))
            # A writable mount makes the system create .fseventsd; create-dmg removes it too.
            shutil.rmtree(mountpoint / ".fseventsd", ignore_errors=True)
            run(["sync"])
        finally:
            detach(mountpoint)

        run(["hdiutil", "convert", writable, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", output])
        resources = license_resources(dmg)
        if resources:
            license_plist = temporary / "license.plist"
            license_plist.write_bytes(resources)
            run(["hdiutil", "udifrez", "-xml", license_plist, "", output])
        output.replace(dmg)
    log("Moved {} to {} in {}".format(", ".join(patched), position, dmg))


def main(arguments):
    if not arguments:
        raise SystemExit(__doc__)
    try:
        for dmg in arguments:
            fix(dmg)
    except LayoutError as error:
        raise SystemExit("[dmg layout] error: {}".format(error)) from error


if __name__ == "__main__":
    main(sys.argv[1:])
