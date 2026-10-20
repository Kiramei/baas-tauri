import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import media from "../evidence/android-native-media.json";
import privacy from "../evidence/privacy-review.json";
import layout from "../evidence/android-native-layout.json";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url));

test("native Android media retains actual APK, source, language and cleanup provenance", () => {
  expect(media.sourceRevision).toBe("e3ed51d7339ea33dc5b6a397e1368b0dfee48e19");
  expect(media.apkSha256).toBe("c345b0368a402947622faa109276b79653c4eeeb84b8c8555042f914b6597511");
  expect(media.publisherSha256).toBe(hash(read("docs/scripts/publish-android-game-media.py").toString().replaceAll("\r\n", "\n")));
  expect(media.nativePhysicalDisplayCapture).toBe(true);
  expect(media.theme).toBe("light");
  expect(media.gameInputSent).toBe(false);
  expect(media.tasksStarted).toBe(false);
  expect(media.languageRestored).toBe(true);
  expect(media.configsAndEventsUnchanged).toBe(true);
  expect(media.sessionRestored).toBe(true);
  expect(media.visualReview.checked).toBe(true);
  expect(read("docs/evidence/android-native-media.json").toString()).not.toContain("\r");
  expect(media.sources).toHaveLength(5);
  for (const source of media.sources) {
    expect(source.gitContentVerified).toBe(true);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(JSON.stringify(media)).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|pngBase64|accessToken|accountId/);
});

test("account blur is baked into both screenshots and every animated frame", async () => {
  expect(media.files).toHaveLength(6);
  expect(media.privacy.method).toContain("Gaussian blur");
  expect(media.privacy.radius).toBeGreaterThanOrEqual(12);
  expect(media.privacy.sourceRegion).toEqual([600, 132, 696, 152]);
  expect(media.privacy.pngOutsideChangedPixels).toBe(0);
  expect(media.privacy.rawSourcesPublished).toBe(false);
  expect(privacy.nativeGameMedia.manifestSha256).toBe(hash(read("docs/evidence/android-native-media.json")));
  expect(privacy.nativeGameMedia.reviewedFiles).toBe(6);
  expect(privacy.nativeGameMedia.reviewedFrames).toBe(124);
  const combinations = new Set<string>();
  for (const file of media.files) {
    const bytes = read("docs/public/" + file.file);
    expect(hash(bytes)).toBe(file.sha256);
    expect(file.sha256).not.toBe(file.sourceSha256);
    combinations.add(file.locale + "/" + file.state);
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(file.width);
    expect(metadata.height).toBe(file.height);
    if (file.state === "game-motion") {
      expect(metadata.pages).toBe(60);
      expect(file.frames).toBe(60);
      expect(file.uniqueFrames).toBeGreaterThanOrEqual(45);
      expect(file.sourcePreviewUniqueFrames).toBeGreaterThanOrEqual(45);
      expect(file.durationMs).toBe(4000);
      expect(file.outputFps).toBe(15);
      expect(file.sourceDecodedFrames).toBeGreaterThanOrEqual(100);
      expect(file.selectedTimestampsSeconds).toHaveLength(60);
    } else {
      expect(file.width).toBe(720);
      expect(file.height).toBe(1280);
      expect(file.outsideChangedPixels).toBe(0);
    }
  }
  expect(combinations.size).toBe(6);
});

test("bilingual Android instructions distinguish frame health, task stopping and old-build failures", () => {
  for (const locale of ["zh", "en"]) {
    const guide = read(`docs/content/docs/${locale}/guide/android.mdx`).toString();
    expect(guide).toContain(`<AndroidGameDemo locale="${locale}" />`);
    expect(guide).toContain(`/media/android/${locale}/game-controls.png`);
    expect(guide).toContain(media.sourceRevision);
    expect(guide).toContain("ELF");
    expect(guide).toContain("dlopen");
    expect(guide).toContain("system_server");
    expect(guide).toContain("DeadSystemException");
    expect(guide).toContain(locale === "zh" ? "预览稳定性尚未确认修复" : "preview stability remains unresolved");
    for (const label of locale === "zh"
      ? ["等待画面", "黑屏", "画面未更新", "实时", "连接异常", "不会等待后端确认", "不会重新启动调度"]
      : ["Waiting for frames", "Black screen", "No frame updates", "Live", "Preview error", "without waiting for backend confirmation", "does not restart the scheduler"])
      expect(guide).toContain(label);
  }
  const component = read("docs/components/AndroidGameDemo.tsx").toString();
  expect(component).toContain("useState(false)");
  expect(component).toContain("NEXT_PUBLIC_BASE_PATH");
  expect(component).toContain("aria-pressed={playing}");
});

test("native media playback, stopping, image zoom and diagnostic navigation pass every locale/theme/viewport", () => {
  expect(layout.cases).toBe(8);
  expect(layout.failures).toBe(0);
  expect(layout.mediaManifestSha256).toBe(hash(read("docs/evidence/android-native-media.json")));
  expect(layout.sourceRevision).toBe(media.sourceRevision);
  for (const [file, expected] of Object.entries(layout.testedSources))
    expect(hash(read(file).toString().replaceAll("\r\n", "\n"))).toBe(expected);
  const combinations = new Set<string>();
  for (const result of layout.results) {
    for (const field of ["nativePosterLoaded", "nativeControlsLoaded", "motionFramesDiffer", "playbackStops", "stableDimensions",
      "roundedAndShadowed", "imageZoomOpenClose", "passed"])
      expect(result[field as keyof typeof result]).toBe(true);
    expect(result.pageErrors).toEqual([]);
    combinations.add([result.locale, result.theme, result.mobile].join("/"));
  }
  expect(combinations.size).toBe(8);
  expect(layout.searches).toHaveLength(2);
  expect(new Set(layout.searches.map(result => result.locale))).toEqual(new Set(["zh", "en"]));
  expect(layout.searches.every(result => result.foundAndroidGuide)).toBe(true);
});
