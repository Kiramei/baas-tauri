import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import replay from "../public/developer/recognition-replay.json";
import validation from "../evidence/backend-development-validation.json";
import layout from "../evidence/recognition-layout-validation.json";

const root = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root));
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const scenario = (id: string) => replay.cases.find((item) => item.id === id)!;

test("recognition examples retain production-source and isolated-test provenance", () => {
  expect(replay.backendRevision).toBe("d0a86a089068766ff53682b501b90bee99857a71");
  expect(replay.scriptSha256).toBe(digest(Buffer.from(read("docs/scripts/replay-backend-recognition.py").toString("utf8").replaceAll("\r\n", "\n"))));
  expect(replay.sources).toHaveLength(37);
  for (const source of replay.sources) {
    expect(source.gitContentVerified).toBe(true);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validation.verifiedSnapshotFiles.find((file) => file.file === source.file)?.sha256).toBe(source.sha256);
  }
  expect(replay.method).toContain("No image recognition engine, real device, game, network or timing measurement");
  expect(validation.backendRevision).toBe(replay.backendRevision);
  expect(validation.recognitionReplaySha256).toBe(digest(read("docs/public/developer/recognition-replay.json")));
  expect(validation.collected).toBe(416);
  expect(validation.passed).toBe(415);
  expect(validation.failed).toBe(0);
  expect(validation.skipped).toEqual([{ test: "test_unix_pipe_channel_round_trip", reason: "Unix sockets are unavailable on Windows" }]);
  expect(JSON.stringify([replay, validation])).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|baas-shm-[a-f0-9]/i);
});

test("twelve production replays preserve ordering, suppression, cached frames and failure outcomes", () => {
  expect(replay.cases).toHaveLength(12);
  expect(new Set(replay.cases.map((item) => item.id)).size).toBe(12);
  for (const item of replay.cases) {
    expect(item.verified).toBe(true);
    expect(item.events.filter((event) => event.kind === "click")).toHaveLength(item.clickRequests);
    expect(item.events.filter((event) => event.kind === "capture")).toHaveLength(item.captures);
    const last = item.events.at(-1)!;
    expect(last.kind).toBe(item.outcome.kind);
    expect(last.value).toEqual(item.outcome.value);
  }
  expect(scenario("end-first").clickRequests).toBe(0);
  expect(scenario("rgb-first").events.some((event) => event.name === "go_image")).toBe(false);
  expect(scenario("image-fallback").events.find((event) => event.kind === "click")?.x).toBe(300);
  expect(scenario("repeat-suppressed").captures).toBe(3);
  expect(scenario("repeat-suppressed").clickRequests).toBe(1);
  expect(scenario("popup-fallback").events.some((event) => event.kind === "popup" && event.matched)).toBe(true);
  expect(scenario("tentative-limit").events.find((event) => event.kind === "click")?.frame).toBe(2);
  expect(scenario("tentative-limit").events.find((event) => event.kind === "sleep")?.seconds).toBe(1.5);
  expect(scenario("timeout").outcome.value).toBe("FunctionCallTimeout");
  expect(scenario("stopped").outcome.value).toBe("RequestHumanTakeOver");
  expect(scenario("stopped").captures).toBe(0);
  expect(scenario("template-end").outcome.value).toEqual(["ready", 0.91, 12]);
  expect(scenario("negative-action").clickRequests).toBe(0);
  expect(scenario("wrong-package").outcome.value).toBe("PackageIncorrect");
  expect(scenario("cached-first").captures).toBe(0);
});

test("backend guides share the service, recognition, config and test contracts without legacy setup", () => {
  const tokens = ["main.service.py", "service.app:app", "--host 127.0.0.1", "--no-ocr-update-check",
    "is_all_data_initialized", "BAAS_ALLOW_MISSING_OCR", "ConfigSession", "apply_startup_injections()",
    "apply_service_injections()", "already-running", "next_tick", "FunctionCallTimeout", "PackageIncorrect",
    "skip_first_screenshot", "time_out=600", "check_pkg_interval=20", "max_fail_cnt=10", "1280",
    "screenshot_cut()", "img_cut()", "TM_CCOEFF_NORMED", "filter_score", "generated_user_config.py",
    "new_event_enable_state", "patch_conflict", "tests/service", "tests/core/test_task_retry.py"];
  for (const locale of ["en", "zh"]) {
    const content = read(`docs/content/docs/${locale}/reference/backend-development.mdx`).toString("utf8");
    for (const token of tokens) expect(content).toContain(token);
    expect(content).toContain(`<RecognitionReplay locale="${locale}" />`);
    expect(content).not.toMatch(/conda create|3\.9\.21|pip install -r requirements\.txt/);
    expect((content.match(/```mermaid/g) || []).length).toBe(1);
  }
});

test("recognition controls and every trace step have source-bound bilingual presentation checks", () => {
  expect(layout.recognitionReplaySha256).toBe(digest(read("docs/public/developer/recognition-replay.json")));
  expect(layout.cases).toBe(96);
  expect(layout.stepChecks).toBe(replay.cases.reduce((sum, item) => sum + item.events.length, 0) * 8);
  expect(layout.failures).toBe(0);
  expect(layout.pageErrors).toEqual([]);
  for (const [file, hash] of Object.entries(layout.testedSources)) expect(digest(read(file))).toBe(hash);
  const cases = new Set<string>();
  for (const result of layout.results) {
    expect(result.passed).toBe(true);
    expect(result.steps).toBe(scenario(result.scenario).events.length);
    cases.add([result.locale, result.theme, result.mobile, result.scenario].join("/"));
  }
  expect(cases.size).toBe(96);
});
