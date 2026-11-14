import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { publicUpdateSettings } from "../../src/shared/MirrorCdk";

test("legacy backend settings expose credential presence without keeping the credential", () => {
  for (const name of ["mirrorcCdk", "mirrorc_cdk"]) {
    const legacy = { updateMethod: "github", [name]: "synthetic-test-cdk" };
    expect(publicUpdateSettings(legacy)).toEqual({
      updateMethod: "github",
      mirrorcCdkConfigured: true,
    });
    expect(publicUpdateSettings({ [name]: "" })).toEqual({ mirrorcCdkConfigured: false });
    expect(publicUpdateSettings({ ...legacy, mirrorcCdkConfigured: false })).toEqual({
      updateMethod: "github",
      mirrorcCdkConfigured: false,
    });
  }
});

test("CDK editing and validation use local native IPC, never backend sync or WebUI", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  for (const file of [
    "../../src/pages/SettingsPage.tsx",
    "../../src/android/pages/SettingsPage.tsx",
  ]) {
    const page = read(file);
    expect(page).toMatch(/__WITH_TAURI__ && updateChannel === "stable" && \(\s*<MirrorCdkField/);
    expect(page).not.toContain('"valid_cdk"');
    expect(page).not.toMatch(/modify\([^)]*mirrorcCdk/);
  }
  const ipc = read("../../src/shared/MirrorCdk.ts");
  expect(ipc).toContain('"updater_validate_mirrorc_cdk"');
  expect(ipc).toContain('"updater_update_config"');
  expect(ipc).not.toMatch(/localStorage|\.trigger\(|console\./);
});
