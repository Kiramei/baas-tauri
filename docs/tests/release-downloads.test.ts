import { expect, test } from "bun:test";
import { classifyAsset } from "../components/ReleaseDownloadPanel";

const asset = (suffix: string) => ({
  name: `BAAS.Tauri_0.0.10_${suffix}`,
  browser_download_url: `https://example.invalid/${suffix}`,
  size: 1024,
});

test("current downloads expose both AppImage architectures and standard Windows portable files", () => {
  for (const locale of ["en", "zh"] as const) {
    for (const [suffix, arch] of [["x86_64.AppImage", "x64"], ["aarch64.AppImage", "arm64"]]) {
      expect(classifyAsset(asset(suffix), locale)).toMatchObject({ kind: "appimage", platform: "linux", arch });
    }
    for (const [suffix, arch] of [["x64_portable.exe", "x64"], ["arm64_portable.exe", "arm64"]]) {
      expect(classifyAsset(asset(suffix), locale)).toMatchObject({ kind: "portable", platform: "windows", arch });
    }
  }
});

test("current downloads exclude discontinued packages, updater archives and signatures", () => {
  for (const suffix of [
    "x64_fixed_webview2-setup.exe", "arm64_fixed_webview2_portable.zip", "armhf.deb", "armv7hl.rpm",
    "armv7l.AppImage", "i386.deb", "x86_64.AppImage.sig", "aarch64.app.tar.gz", "x64-setup.nsis.zip",
  ]) {
    expect(classifyAsset(asset(suffix), "en")).toBeNull();
    expect(classifyAsset(asset(suffix), "zh")).toBeNull();
  }
});

test("DEB, RPM, macOS and standard Windows installers retain matching architectures", () => {
  for (const [suffix, kind, arch] of [
    ["amd64.deb", "deb", "x64"], ["arm64.deb", "deb", "arm64"], ["x86_64.rpm", "rpm", "x64"],
    ["aarch64.rpm", "rpm", "arm64"], ["x64.dmg", "dmg", "x64"], ["aarch64.dmg", "dmg", "arm64"],
    ["x64-setup.exe", "installer", "x64"], ["arm64-setup.exe", "installer", "arm64"],
  ]) expect(classifyAsset(asset(suffix), "en")).toMatchObject({ kind, arch });
});
