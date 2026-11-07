#!/usr/bin/env python3
"""Verify the exact macOS bundles that will be uploaded, without changing them.

This checks Apple ad-hoc code signatures and bundle contents. The updater .sig
must be present; its separate updater cryptographic signature is not checked here.
No Apple certificate, notarization credentials, or third-party Python modules are
required.
"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path, PurePosixPath
import plistlib
import posixpath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile


TARGETS = {
    "aarch64-apple-darwin": ("aarch64", "arm64"),
    "x86_64-apple-darwin": ("x64", "x86_64"),
}
TOOL_TIMEOUT_SECONDS = 120


class VerificationError(Exception):
    """A missing, damaged, or incorrectly packaged release artifact."""


def log(message):
    print("[macOS bundles] " + message, flush=True)


def run_tool(arguments):
    arguments = [str(argument) for argument in arguments]
    log("$ " + shlex.join(arguments))
    try:
        result = subprocess.run(
            arguments,
            capture_output=True,
            text=True,
            timeout=TOOL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VerificationError("Could not complete {}: {}".format(arguments[0], error)) from error
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    if result.returncode:
        raise VerificationError(
            "{} exited with {}{}".format(
                shlex.join(arguments), result.returncode, ":\n" + output if output else ""
            )
        )
    if output:
        log(output)
    return output


def require_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise VerificationError("Expected a nonempty regular file: {}".format(path))


def single_app(directory):
    apps = sorted(directory.glob("*.app"))
    if len(apps) != 1 or apps[0].is_symlink() or not apps[0].is_dir():
        raise VerificationError("Expected exactly one .app directory directly inside {}".format(directory))
    return apps[0]


def verify_app(app, expected_arch):
    log("Verifying application: {}".format(app))
    require_file(app / "Contents/_CodeSignature/CodeResources")
    info_path = app / "Contents/Info.plist"
    require_file(info_path)
    try:
        with info_path.open("rb") as info_file:
            info = plistlib.load(info_file)
    except (OSError, plistlib.InvalidFileException, ValueError) as error:
        raise VerificationError("Invalid Info.plist in {}: {}".format(app, error)) from error
    executable_name = info.get("CFBundleExecutable") if isinstance(info, dict) else None
    if (
        not isinstance(executable_name, str)
        or not executable_name
        or executable_name in (".", "..")
        or "/" in executable_name
        or "\\" in executable_name
    ):
        raise VerificationError("Invalid CFBundleExecutable in {}".format(info_path))
    executable = app / "Contents/MacOS" / executable_name
    require_file(executable)
    architectures = run_tool(["lipo", "-archs", executable]).split()
    if architectures != [expected_arch]:
        raise VerificationError(
            "Wrong architecture in {}: expected {}, found {}".format(
                executable, expected_arch, " ".join(architectures) or "none"
            )
        )
    run_tool(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    signature = run_tool(["codesign", "--display", "--verbose=4", app])
    if not re.search(r"^Signature=adhoc\s*$", signature, re.MULTILINE):
        raise VerificationError("Expected an ad-hoc application signature in {}".format(app))


def extract_app_archive(archive_path, destination):
    """Extract one app, preserving safe framework links without following them."""
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        paths = {}
        roots = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise VerificationError("Unsafe archive member: {}".format(member.name))
            if path in paths:
                raise VerificationError("Duplicate archive member: {}".format(member.name))
            if not (member.isdir() or member.isfile() or member.issym()):
                raise VerificationError("Unsupported archive member: {}".format(member.name))
            if not path.parts[0].endswith(".app"):
                raise VerificationError("Archive must contain only a top-level .app: {}".format(member.name))
            roots.add(path.parts[0])
            paths[path] = member
            if member.issym():
                link = PurePosixPath(member.linkname)
                resolved = PurePosixPath(posixpath.normpath(posixpath.join(str(path.parent), member.linkname)))
                if link.is_absolute() or not resolved.parts or resolved.parts[0] != path.parts[0]:
                    raise VerificationError("Unsafe archive symlink: {} -> {}".format(member.name, member.linkname))
        if len(roots) != 1:
            raise VerificationError("Archive must contain exactly one top-level .app: {}".format(archive_path))
        for path, member in paths.items():
            if len(path.parts) == 1 and not member.isdir():
                raise VerificationError("Archive .app root must be a directory: {}".format(member.name))
            for parent in path.parents:
                if parent in paths and not paths[parent].isdir():
                    raise VerificationError("Archive member has a non-directory parent: {}".format(member.name))

        # Materialize files before symlinks, so archive contents cannot redirect
        # extraction. A symlink can never be an ancestor of another member.
        for path, member in paths.items():
            output = destination.joinpath(*path.parts)
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                output.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise VerificationError("Cannot read archive member: {}".format(member.name))
                with source, output.open("xb") as target:
                    shutil.copyfileobj(source, target)
                output.chmod(member.mode & 0o777)
        for path, member in paths.items():
            if member.issym():
                output = destination.joinpath(*path.parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(member.linkname, output)
        app_root = destination / next(iter(roots))
        for path, member in paths.items():
            if member.issym():
                try:
                    destination.joinpath(*path.parts).resolve(strict=True).relative_to(app_root.resolve())
                except (ValueError, RuntimeError, OSError) as error:
                    raise VerificationError("Unsafe or broken archive symlink chain: {}".format(member.name)) from error
    return single_app(destination)


@contextmanager
def mounted_dmg(dmg, mountpoint):
    mountpoint.mkdir()
    attached = False
    original_error = None
    try:
        # Even a failed/timeout attach may have mounted a volume. Always attempt
        # to detach our private mountpoint, including on verification failures.
        run_tool(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mountpoint, dmg])
        attached = True
        yield mountpoint
    except BaseException as error:
        original_error = error
        raise
    finally:
        try:
            run_tool(["hdiutil", "detach", mountpoint])
        except VerificationError as detach_error:
            try:
                run_tool(["hdiutil", "detach", "-force", mountpoint])
            except VerificationError as force_error:
                if attached and original_error is None:
                    raise VerificationError("Could not detach DMG: {}".format(force_error)) from detach_error
                log("DMG cleanup after failure: {}".format(force_error))


def verify_bundles(target, bundle_dir, assets_dir, version):
    archive_arch, executable_arch = TARGETS[target]
    app = single_app(bundle_dir / "macos")
    prefix = "BAAS.Tauri_{}_{}".format(version, archive_arch)
    archive = assets_dir / (prefix + ".app.tar.gz")
    signature = assets_dir / (prefix + ".app.tar.gz.sig")
    dmg = assets_dir / (prefix + ".dmg")
    for path in (archive, signature, dmg):
        require_file(path)
    verify_app(app, executable_arch)
    with tempfile.TemporaryDirectory(prefix="baas-macos-verify-") as temporary:
        temporary_path = Path(temporary)
        extracted = temporary_path / "archive"
        extracted.mkdir()
        log("Checking normalized updater archive: {}".format(archive))
        archived_app = extract_app_archive(archive, extracted)
        if archived_app.name != app.name:
            raise VerificationError("Updater application name differs from built application")
        verify_app(archived_app, executable_arch)
        log("Checking normalized disk image: {}".format(dmg))
        run_tool(["hdiutil", "verify", dmg])
        with mounted_dmg(dmg, temporary_path / "mount") as mountpoint:
            disk_app = single_app(mountpoint)
            if disk_app.name != app.name:
                raise VerificationError("DMG application name differs from built application")
            verify_app(disk_app, executable_arch)
    log("Verified built app, updater archive, and DMG for {}.".format(target))
    log("Updater .sig is present and nonempty; this check does not verify its separate updater signature.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(TARGETS))
    parser.add_argument("--bundle-dir", required=True, type=Path)
    parser.add_argument("--assets-dir", required=True, type=Path)
    parser.add_argument("--version", required=True)
    arguments = parser.parse_args(argv)
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.(?:rc|post)\d+)?", arguments.version):
        parser.error("--version must be a public version such as 0.0.9.post1")
    try:
        verify_bundles(arguments.target, arguments.bundle_dir, arguments.assets_dir, arguments.version)
    except (VerificationError, OSError, tarfile.TarError, ValueError) as error:
        print("[macOS bundles] ERROR: {}".format(error), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
