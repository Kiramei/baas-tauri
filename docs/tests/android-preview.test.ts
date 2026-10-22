import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import measurement from "../public/benchmarks/android-local-current.json";
import layout from "../evidence/android-preview-layout.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("both languages describe all three preview stages with the measured source revision", () => {
  const graphs: string[][] = [];
  for (const locale of ["zh", "en"]) {
    const guide = read(`docs/content/docs/${locale}/guide/android.mdx`);
    const architecture = read(`docs/content/docs/${locale}/reference/client-architecture.mdx`);
    expect(guide).toContain("532f785b");
    expect(guide).toContain("128983b8");
    expect(guide).toContain("SurfaceTexture.timestamp");
    expect(guide).toContain(locale === "zh" ? "预览稳定性尚未确认修复" : "preview stability remains unresolved");
    for (const counter of ["capturedFrames", "presentedFrames", "displayedFrames"])
      expect(architecture).toContain(`| \`${counter}\` |`);
    const sourceBase = `https://github.com/Kiramei/baas-tauri/blob/${measurement.sourceRevision}/src-tauri/gen/android/app/src/main/`;
    for (const file of ["cpp/display_capture.cpp", "cpp/frame_content.h", "java/io/github/kiramei/baas_tauri/PreviewFrameProgress.kt",
      "java/io/github/kiramei/baas_tauri/NativeGamePreview.kt", "python/android_backend/native_device.py"])
      expect(architecture).toContain(sourceBase + file);
    const graph = [...architecture.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(match => match[1]).find(text => text.includes("AImageReader"));
    expect(graph).toBeDefined();
    const edges = [...graph!.matchAll(/^\s*(\w+)(?:\[.*?\])? --> (\w+)/gm)].map(match => `${match[1]}->${match[2]}`);
    graphs.push(edges);
    expect(edges).toEqual(["Game->Reader", "Reader->GPU", "GPU->Texture", "Reader->Copy", "Copy->PNG", "PNG->RPC", "RPC->Python", "Python->Script"]);
    expect(architecture).toContain(locale === "zh" ? "不能把整个采集链路称为零复制" : "complete capture pipeline is not zero-copy");
    expect(architecture).toContain(locale === "zh" ? "首次观察到正计数不等于观察到增长" : "An initial positive observation does not count as observed progress");
  }
  expect(graphs[0]).toEqual(graphs[1]);
});

test("preview pipeline navigation and zoom pass both languages, themes and viewport sizes", () => {
  expect(layout.cases).toBe(8);
  expect(layout.failures).toBe(0);
  expect(layout.scope).toContain("no emulator or native preview operated");
  for (const [file, expected] of Object.entries(layout.testedSources)) expect(hash(read(file))).toBe(expected);
  const combinations = new Set<string>();
  for (const result of layout.results) {
    expect(result.nodes).toBe(9);
    for (const key of ["sourceLinkNavigated", "zoomAndReset", "lastNodeReachable", "allCountersPresent", "noPageOverflow", "passed"])
      expect(result[key as keyof typeof result]).toBe(true);
    expect(result.pageErrors).toEqual([]);
    combinations.add([result.locale, result.theme, result.mobile].join("/"));
  }
  expect(combinations.size).toBe(8);
});
