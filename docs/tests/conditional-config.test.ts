import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { readPublishedMedia } from "../scripts/published-media.mjs";

const root = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root));
const json = (file: string) => JSON.parse(read(file).toString("utf8"));
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const states = [
  "cafe-student-search", "cafe-student-empty", "cafe-named", "cafe-starred",
  "craft-phase3-materials", "craft-phase2-materials", "craft-recommendation",
  "craft-recommended-priority", "craft-node-picker", "craft-invalid-count",
  "team-preset", "team-preset-cell", "team-order", "lesson-student-search", "lesson-students",
  "sweep-invalid-count", "sweep-student-search", "sweep-student-stages", "sweep-legacy-plan",
  "sweep-legacy-count", "explore-legacy-mission", "explore-legacy-plan",
];

for (const platform of ["desktop", "android"]) {
  test(`${platform} conditional captures are complete, native, hash-bound and restored`, async () => {
    const report = json(`docs/public/media/${platform}/conditional-manifest.json`);
    expect(report.platform).toBe(platform);
    expect(report.runtimeOwnerVerified).toBe(true);
    expect(report.scenariosCompleted).toBe(true);
    expect(report.restored).toBe(true);
    expect(report.demoEventsUnchanged).toBe(true);
    expect(report.protectedProfilesUnchanged).toBe(true);
    expect(report.restoredFieldsSha256).toBe(report.originalFieldsSha256);
    expect(report.captureScriptSha256).toBe(digest(read("docs/scripts/capture-conditional-config.mjs")));
    const proof = platform === "desktop"
      ? json("docs/public/media/desktop/installer-manifest.json")
      : json("docs/evidence/android-x86-provenance.json");
    expect(report.sourceRevision).toBe(proof.sourceRevision);
    expect(report.executableOrApkSha256).toBe((proof.executableSha256 || proof.apkSha256).toLowerCase());
    expect(JSON.stringify(report)).not.toMatch(/WorkSpace|\.codex_tmp|\\Users\\|baas-shm-/i);
    expect(report.checks).toHaveLength(22);
    for (const locale of ["en", "zh"]) {
      const expected = platform === "desktop" ? [...states, "craft-priority-still"] : states;
      const shots = report.shots.filter((shot: any) => shot.locale === locale);
      expect(shots.map((shot: any) => shot.state).sort()).toEqual(expected.sort());
      const checks = report.checks.filter((check: any) => check.locale === locale);
      expect(checks).toHaveLength(11);
      expect(checks.every((check: any) => check.passed)).toBe(true);
      for (const shot of shots) {
        expect(shot.file).toBe(`media/${platform}/${locale}/conditional-${shot.state}.png`);
        const { bytes: image } = readPublishedMedia(shot.file, shot.sha256);
        expect(await sharp(image).metadata()).toMatchObject({ width: shot.width, height: shot.height });
        expect(shot.width).toBeGreaterThan(200);
        expect(shot.height).toBeGreaterThan(100);
        expect(shot.native).toBe(true);
        expect(shot.theme).toBe("light");
      }
    }
    expect(report.recordings).toHaveLength(platform === "desktop" ? 2 : 0);
    for (const recording of report.recordings) {
      expect(readPublishedMedia(recording.file, recording.sha256).record.frames).toBeGreaterThan(1);
      expect(recording.native).toBe(true);
      expect(recording.gameInputSent).toBe(false);
      expect(recording.frames).toBe(21);
      expect(recording.playbackFrameMs).toBe(160);
    }
  });
}

test("bilingual feature pages include captured conditional states and a controlled priority animation", () => {
  const required = {
    cafe: ["cafe-named", "cafe-starred", "cafe-student-search"],
    crafting: ["craft-invalid-count", "craft-phase2-materials", "craft-phase3-materials", "craft-node-picker", "craft-recommendation"],
    lesson: ["lesson-students"],
    team: ["team-preset-cell", "team-order"],
    sweeps: ["sweep-invalid-count", "sweep-student-stages", "sweep-legacy-count"],
    stages: ["explore-legacy-plan"],
  };
  for (const locale of ["en", "zh"]) {
    for (const [page, states] of Object.entries(required)) {
      const content = read(`docs/content/docs/${locale}/features/${page}.mdx`).toString("utf8");
      for (const state of states) expect(content).toContain(`/media/desktop/${locale}/conditional-${state}.webp`);
    }
    expect(read(`docs/content/docs/${locale}/features/crafting.mdx`).toString("utf8"))
      .toContain(`<MotionDemo locale="${locale}" variant="priority" />`);
  }
  const motion = read("docs/components/MotionDemo.tsx").toString("utf8");
  expect(motion).toContain('useState(false)');
  expect(motion).toContain('"configuration-undo.animated.webp"');
  expect(motion).toContain('"conditional-priority-reorder.animated.webp"');
});

test("conditional-page layout results bind both capture manifests and all presentation combinations", () => {
  const report = json("docs/evidence/conditional-layout-validation.json");
  expect(report.cases).toBe(56);
  expect(report.failed).toBe(0);
  expect(report.pageErrors).toEqual([]);
  expect(report.results).toHaveLength(56);
  expect(report.results.filter((result: any) => result.animation)).toHaveLength(8);
  for (const platform of ["desktop", "android"])
    expect(report.captureManifestSha256[platform]).toBe(digest(read(`docs/public/media/${platform}/conditional-manifest.json`)));
  const cases = new Set<string>();
  for (const result of report.results) {
    expect(result.passed).toBe(true);
    expect(result.images).toBeGreaterThan(0);
    cases.add([result.locale, result.theme, result.mobile, result.page].join("/"));
  }
  expect(cases.size).toBe(56);
});
