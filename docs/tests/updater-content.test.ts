import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import audit from "../evidence/updater-source-audit.json";
import layout from "../evidence/updater-layout.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("updater documentation pins inspected sources without claiming a runtime update", () => {
  expect(audit.verificationKind).toContain("code inspection");
  expect(audit.runtimeUpdateExecuted).toBe(false);
  expect(audit.sources).toHaveLength(22);
  expect(audit.sourceReferences).toHaveLength(66);
  expect(new Set(audit.sources.map(source => source.scope))).toEqual(new Set(["desktop", "android", "android-preview", "backend"]));
  for (const source of audit.sources) {
    expect(source.gitContentVerified).toBe(true);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(source.lines).toBeGreaterThan(0);
  }
  for (const reference of audit.sourceReferences) {
    const url = new URL(reference.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const source = audit.sources.find(source => source.repository === parts.slice(0, 2).join("/") &&
      source.revision === parts[3] && source.file === parts.slice(4).join("/"));
    expect(source).toBeDefined();
    expect(reference.startLine).toBeGreaterThan(0);
    expect(reference.endLine).toBeGreaterThanOrEqual(reference.startLine);
    expect(reference.endLine).toBeLessThanOrEqual(source!.lines);
  }
  for (const [file, expected] of Object.entries(audit.testedPages)) expect(sha(read(file))).toBe(expected);
  expect(JSON.stringify(audit)).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|accessToken|accountId|pngBase64/);
});

test("both updater guides retain activation, cancellation, integrity and installer limitations", () => {
  for (const locale of ["zh", "en"]) {
    const content = read(`docs/content/docs/${locale}/reference/updater-internals.mdx`);
    for (const term of ["stopAllTasks", "UpdaterTermManager", "BackendProcessManager", "SourceSelector", "GitUpdateGuard",
      "sync_android_repository", "sync_git2_worktree", "stoppedTasks", "CertificateOk", "CertificatePassthrough",
      "MirrorLatest.sha256", "Minisign", "FileProvider", "restarted: false", "restart_deferred: true", ".baas-next"])
      expect(content).toContain(term);
    for (const term of ["backend-service-overlay", "BAAS_SERVICE_OVERLAY_ROOT", "SERVICE_TRANSPORT_OVERLAY_FILES", "__file__"])
      expect(content).toContain(term);
    expect((content.match(/```mermaid/g) || []).length).toBe(1);
    const update = read(`docs/content/docs/${locale}/features/update.mdx`);
    const architecture = read(`docs/content/docs/${locale}/reference/client-architecture.mdx`);
    const android = read(`docs/content/docs/${locale}/guide/android.mdx`);
    expect(update).toContain("updater-internals");
    expect(architecture).toContain("updater-internals");
    expect((architecture.match(/```mermaid/g) || []).length).toBe(3);
    expect(android).toContain(locale === "zh" ? "强行停止 BAAS" : "Force stop BAAS");
    expect(android).toContain("API 26");
    expect(android).toContain("8e38508f160a29d784125970c2dad00d3c9e347d");
    expect(JSON.parse(read(`docs/content/docs/${locale}/reference/meta.json`)).pages).toContain("updater-internals");
  }
});

test("updater diagrams, localized framework UI, search and language switching pass all display combinations", () => {
  expect(layout.cases).toBe(8);
  expect(layout.failures).toBe(0);
  expect(layout.results).toHaveLength(8);
  for (const [file, expected] of Object.entries(layout.testedSources)) expect(sha(read(file))).toBe(expected);
  expect(layout.searchIndexPath).toMatch(/^search-index\/[a-f0-9]{64}\.json$/);
  expect(layout.searchIndexSha256).toBe(sha(read("docs/out/" + layout.searchIndexPath)));
  const combinations = new Set<string>();
  for (const result of layout.results) {
    for (const field of ["searchNavigated", "emptySearchTranslated", "frameworkLabelsTranslated", "clientLanguageSwitch",
      "themeSwitch", "diagramZoomAndReset", "noOverflow", "passed"])
      expect(result[field as keyof typeof result]).toBe(true);
    expect(result.pageErrors).toEqual([]);
    combinations.add([result.locale, result.theme, result.mobile].join("/"));
  }
  expect(combinations.size).toBe(8);
});
