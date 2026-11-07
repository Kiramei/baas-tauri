"""Release bundle checks; native macOS cases use real clang/codesign/hdiutil.

Run with: python3 scripts/tests/test_macos_bundles.py
Linux runs the validation/cleanup regressions and skips the native integration
cases. Native fixtures need no Apple account or updater signing secret.
"""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/verify-macos-bundles.py"
SPEC = importlib.util.spec_from_file_location("verify_macos_bundles", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
VERSION = "0.0.9.post1"
TARGET = "aarch64-apple-darwin"
APP_NAME = "BAAS Tauri.app"


def make_app(directory):
    app = directory / APP_NAME
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Resources").mkdir()
    (app / "Contents/_CodeSignature").mkdir()
    (app / "Contents/_CodeSignature/CodeResources").write_bytes(b"fixture resource seal")
    (app / "Contents/MacOS/baas-fixture").write_bytes(b"fixture executable")
    (app / "Contents/Resources/message.txt").write_text("Signed resource\n", encoding="utf-8")
    with (app / "Contents/Info.plist").open("wb") as output:
        plistlib.dump({
            "CFBundleExecutable": "baas-fixture",
            "CFBundleIdentifier": "io.github.kiramei.baas-tauri.tests",
            "CFBundleName": "BAAS Tauri",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "0.0.9",
            "CFBundleVersion": "1",
        }, output)
    return app


def write_archive(path, members):
    with tarfile.open(path, "w:gz") as archive:
        for name, kind, content in members:
            member = tarfile.TarInfo(name)
            if kind == "dir":
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            elif kind == "file":
                payload = content.encode("utf-8")
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            else:
                member.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "device": tarfile.CHRTYPE}[kind]
                member.linkname = content
                archive.addfile(member)


class BundleValidationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="baas-macos-unit-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app = make_app(self.root / "bundle/macos")
        self.assets = self.root / "release-assets"
        self.assets.mkdir()
        self.artifacts = [self.assets / ("BAAS.Tauri_{}_aarch64".format(VERSION) + suffix)
                          for suffix in (".app.tar.gz", ".app.tar.gz.sig", ".dmg")]
        for artifact in self.artifacts:
            artifact.write_bytes(b"fixture artifact")
        self.quiet = redirect_stdout(io.StringIO())
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)

    def test_requires_exactly_one_built_app(self):
        (self.app.parent / "Second.app").mkdir()
        with self.assertRaisesRegex(VERIFY.VerificationError, "exactly one .app"):
            VERIFY.verify_bundles(TARGET, self.root / "bundle", self.assets, VERSION)

    def test_requires_every_normalized_artifact_to_be_nonempty(self):
        for artifact in self.artifacts:
            with self.subTest(artifact=artifact.name):
                artifact.unlink()
                with mock.patch.object(VERIFY, "verify_app") as app_check:
                    with self.assertRaisesRegex(VERIFY.VerificationError, "nonempty regular file"):
                        VERIFY.verify_bundles(TARGET, self.root / "bundle", self.assets, VERSION)
                    app_check.assert_not_called()
                artifact.write_bytes(b"fixture artifact")
        self.artifacts[1].write_bytes(b"")
        with self.assertRaisesRegex(VERIFY.VerificationError, "nonempty regular file"):
            VERIFY.verify_bundles(TARGET, self.root / "bundle", self.assets, VERSION)

    def test_requires_bundle_resource_seal(self):
        (self.app / "Contents/_CodeSignature/CodeResources").unlink()
        with mock.patch.object(VERIFY, "run_tool") as tool:
            with self.assertRaisesRegex(VERIFY.VerificationError, "CodeResources"):
                VERIFY.verify_app(self.app, "arm64")
            tool.assert_not_called()

    def test_wrong_architecture_and_universal_binary_are_rejected(self):
        for architecture in ("x86_64", "arm64 x86_64"):
            with self.subTest(architecture=architecture):
                with mock.patch.object(VERIFY, "run_tool", return_value=architecture):
                    with self.assertRaisesRegex(VERIFY.VerificationError, "Wrong architecture"):
                        VERIFY.verify_app(self.app, "arm64")

    def test_requires_adhoc_signature_after_codesign_verification(self):
        with mock.patch.object(VERIFY, "run_tool", side_effect=["arm64", "", "Authority=Developer ID Application: Fixture"]):
            with self.assertRaisesRegex(VERIFY.VerificationError, "ad-hoc"):
                VERIFY.verify_app(self.app, "arm64")

    def test_tool_reads_codesign_metadata_from_stderr_and_reports_failure(self):
        result = subprocess.CompletedProcess(["codesign"], 0, "", "Signature=adhoc\n")
        with mock.patch.object(VERIFY.subprocess, "run", return_value=result):
            self.assertEqual(VERIFY.run_tool(["codesign", "--display", self.app]), "Signature=adhoc")
        result = subprocess.CompletedProcess(["codesign"], 1, "", "a sealed resource is missing or invalid")
        with mock.patch.object(VERIFY.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(VERIFY.VerificationError, "sealed resource"):
                VERIFY.run_tool(["codesign", "--verify", self.app])

    def test_safe_framework_symlinks_are_preserved(self):
        archive = self.root / "framework.tar.gz"
        base = APP_NAME + "/Contents/Frameworks/Fixture.framework/"
        write_archive(archive, [
            (base + "Versions/A/Fixture", "file", "framework"),
            (base + "Versions/Current", "symlink", "A"),
            (base + "Fixture", "symlink", "Versions/Current/Fixture"),
        ])
        destination = self.root / "extracted"
        extracted = VERIFY.extract_app_archive(archive, destination)
        link = extracted / "Contents/Frameworks/Fixture.framework/Fixture"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.read_text(), "framework")

    def test_unsafe_archives_are_rejected_without_writing_outside_app(self):
        cases = {
            "parent traversal": [("../outside", "file", "bad")],
            "absolute path": [("/tmp/outside", "file", "bad")],
            "extra root": [(APP_NAME + "/file", "file", "ok"), ("Other.app/file", "file", "bad")],
            "duplicate": [(APP_NAME + "/file", "file", "one"), (APP_NAME + "/file", "file", "two")],
            "escape link": [(APP_NAME + "/link", "symlink", "../outside")],
            "link ancestor": [(APP_NAME + "/link", "symlink", "inside"), (APP_NAME + "/link/file", "file", "bad")],
            "hard link": [(APP_NAME + "/link", "hardlink", APP_NAME + "/file")],
            "device": [(APP_NAME + "/device", "device", "")],
            "chained escape": [(APP_NAME + "/sub/b", "symlink", ".."), (APP_NAME + "/sub/a", "symlink", "b/../../outside")],
            "link loop": [(APP_NAME + "/a", "symlink", "b"), (APP_NAME + "/b", "symlink", "a")],
        }
        for index, (name, members) in enumerate(cases.items()):
            with self.subTest(case=name):
                archive = self.root / ("unsafe-{}.tar.gz".format(index))
                write_archive(archive, members)
                with self.assertRaises(VERIFY.VerificationError):
                    VERIFY.extract_app_archive(archive, self.root / ("extract-{}".format(index)))
        self.assertFalse((self.root / "outside").exists())

    def test_verification_failure_detaches_dmg(self):
        mountpoint = self.root / "mount"
        with mock.patch.object(VERIFY, "run_tool") as tool:
            with self.assertRaisesRegex(VERIFY.VerificationError, "bad mounted app"):
                with VERIFY.mounted_dmg(self.artifacts[2], mountpoint):
                    raise VERIFY.VerificationError("bad mounted app")
        self.assertEqual(tool.call_args_list[0].args[0], ["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mountpoint, self.artifacts[2]])
        self.assertEqual(tool.call_args_list[-1].args[0], ["hdiutil", "detach", mountpoint])

    def test_partial_attach_failure_still_attempts_detach(self):
        error = VERIFY.VerificationError("attach timed out after mounting")
        with mock.patch.object(VERIFY, "run_tool", side_effect=[error, ""]) as tool:
            with self.assertRaisesRegex(VERIFY.VerificationError, "attach timed out"):
                with VERIFY.mounted_dmg(self.artifacts[2], self.root / "mount"):
                    self.fail("failed attach must not enter verification")
        self.assertEqual(tool.call_args_list[-1].args[0][0:2], ["hdiutil", "detach"])

    def test_detach_failure_retries_force_and_fails_if_volume_remains(self):
        error = VERIFY.VerificationError("volume busy")
        with mock.patch.object(VERIFY, "run_tool", side_effect=["", error, error]) as tool:
            with self.assertRaisesRegex(VERIFY.VerificationError, "Could not detach DMG"):
                with VERIFY.mounted_dmg(self.artifacts[2], self.root / "mount"):
                    pass
        self.assertEqual(tool.call_args_list[-1].args[0][0:3], ["hdiutil", "detach", "-force"])


@unittest.skipUnless(sys.platform == "darwin", "real macOS signing and disk image tools required")
class NativeMacBundleTests(unittest.TestCase):
    @classmethod
    def command(cls, arguments):
        try:
            subprocess.run([str(item) for item in arguments], check=True, capture_output=True, text=True, timeout=120)
        except subprocess.CalledProcessError as error:
            raise AssertionError("Native fixture command failed: {}\n{}{}".format(error.cmd, error.stdout, error.stderr)) from error

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="baas-macos-native-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.base = Path(cls.temporary.name) / "baseline"
        cls.arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        cls.target = "aarch64-apple-darwin" if cls.arch == "arm64" else "x86_64-apple-darwin"
        cls.dist_arch = VERIFY.TARGETS[cls.target][0]
        app = make_app(cls.base / "bundle/macos")
        shutil.rmtree(app / "Contents/_CodeSignature")
        source = Path(cls.temporary.name) / "main.c"
        source.write_text("int main(void) { return 0; }\n", encoding="utf-8")
        cls.command(["clang", "-arch", cls.arch, source, "-o", app / "Contents/MacOS/baas-fixture"])
        entitlements = Path(cls.temporary.name) / "entitlements.plist"
        with entitlements.open("wb") as output:
            plistlib.dump({"com.apple.security.app-sandbox": False}, output)
        cls.command(["codesign", "--force", "--sign", "-", "--options", "runtime", "--timestamp=none", "--entitlements", entitlements, app])
        assets = cls.base / "release-assets"
        assets.mkdir()
        prefix = "BAAS.Tauri_{}_{}".format(VERSION, cls.dist_arch)
        with tarfile.open(assets / (prefix + ".app.tar.gz"), "w:gz") as archive:
            archive.add(app, arcname=app.name)
        # These tests concern Apple code signing, not updater cryptography.
        (assets / (prefix + ".app.tar.gz.sig")).write_text("fixture updater signature\n", encoding="utf-8")
        cls.command(["hdiutil", "create", "-quiet", "-volname", "BAAS bundle verification", "-srcfolder", app.parent, "-format", "UDZO", assets / (prefix + ".dmg")])

    def setUp(self):
        self.case = Path(self.temporary.name) / self.id().split(".")[-1]
        shutil.copytree(self.base, self.case, symlinks=True)
        self.app = self.case / "bundle/macos" / APP_NAME

    def verify(self):
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            status = VERIFY.main([
                "--target", self.target,
                "--bundle-dir", str(self.case / "bundle"),
                "--assets-dir", str(self.case / "release-assets"),
                "--version", VERSION,
            ])
        return status, output.getvalue()

    def test_real_signed_app_archive_and_dmg_pass(self):
        status, output = self.verify()
        self.assertEqual(status, 0, output)
        self.assertIn("Verified built app, updater archive, and DMG", output)

    def test_correctly_signed_macho_without_bundle_seal_fails(self):
        self.command(["codesign", "--verify", self.app / "Contents/MacOS/baas-fixture"])
        shutil.rmtree(self.app / "Contents/_CodeSignature")
        status, output = self.verify()
        self.assertEqual(status, 1, output)
        self.assertIn("CodeResources", output)

    def test_tampered_signed_resource_fails(self):
        (self.app / "Contents/Resources/message.txt").write_text("tampered\n", encoding="utf-8")
        status, output = self.verify()
        self.assertEqual(status, 1, output)
        self.assertIn("codesign --verify", output)

    def test_tampered_final_updater_archive_fails(self):
        staging = self.case / "tampered"
        shutil.copytree(self.app, staging / APP_NAME, symlinks=True)
        (staging / APP_NAME / "Contents/Resources/message.txt").write_text("tampered archive\n", encoding="utf-8")
        archive_path = self.case / "release-assets" / ("BAAS.Tauri_{}_{}.app.tar.gz".format(VERSION, self.dist_arch))
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(staging / APP_NAME, arcname=APP_NAME)
        status, output = self.verify()
        self.assertEqual(status, 1, output)
        self.assertIn("Checking normalized updater archive", output)
        self.assertNotIn("Checking normalized disk image", output)

    def test_real_binary_wrong_architecture_fails(self):
        other_arch = "x86_64" if self.arch == "arm64" else "arm64"
        with redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(VERIFY.VerificationError, "Wrong architecture"):
                VERIFY.verify_app(self.app, other_arch)


if __name__ == "__main__":
    unittest.main(verbosity=2)
