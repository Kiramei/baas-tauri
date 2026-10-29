import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { createTwoslasher } from "twoslash";
import layout from "../evidence/client-api-layout.json";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hash = (file: string) => createHash("sha256").update(read(file)).digest("hex");
const pages = ["en", "zh"].map(locale => read(`docs/content/docs/${locale}/reference/client-api.mdx`));
const parse = (value: string) => fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
function* nodes(node: any): Generator<any> {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

test("both native API pages cover the current registered command names", () => {
  const registry = read("src-tauri/src/lib.rs").match(/generate_handler!\[([\s\S]*?)\]\s*\)/)?.[1];
  expect(registry).toBeDefined();
  const commands = registry!.replace(/#\[cfg\([^\]]+\)\]/g, "").split(",").map(value => value.trim()).filter(Boolean);
  expect(commands.length).toBeGreaterThan(40);
  for (const page of pages) {
    const names = [...nodes(parse(page))].filter(node => node.type === "inlineCode").map(node => node.value);
    for (const command of commands) expect(names).toContain(command);
    for (const token of ["onMessage", "connectionId", "batchFrames", "x-baas-connection-id", "BPRQ",
      "restart_deferred", "restarted: false", "macOS", "WebUI", "4000", "250"])
      expect(page).toContain(token);
    expect(page).not.toContain("embedded-python-3.9");
  }
  for (const locale of ["en", "zh"])
    expect(JSON.parse(read(`docs/content/docs/${locale}/reference/meta.json`)).pages).toContain("client-api");
});

test("Twoslash examples resolve the application's real imports and reject invalid transport values", () => {
  const twoslash = createTwoslasher({
    compilerOptions: { baseUrl: root, paths: { "@/*": ["src/*"] } },
  });
  for (const page of pages) {
    const snippets = [...nodes(parse(page))].filter(node => node.type === "code" && node.meta === "twoslash");
    expect(snippets).toHaveLength(2);
    for (const snippet of snippets) {
      const result = twoslash(snippet.value, "ts");
      expect(result.nodes.some(node => node.type === "hover")).toBe(true);
      expect(result.nodes.filter(node => node.type === "error")).toEqual([]);
    }
  }
  expect(() => twoslash('import type { BackendTransportMode } from "@/transport/types";\nconst mode: BackendTransportMode = "invalid-transport";', "ts")).toThrow();
});

test("native API examples retain bilingual browser and popup verification", () => {
  expect(layout.cases).toBe(8);
  expect(layout.failures).toBe(0);
  expect(layout.nativeCommandsExecuted).toBe(false);
  for (const [file, expected] of Object.entries(layout.testedSources)) expect(hash(file)).toBe(expected);
  for (const result of layout.results) {
    expect(result.popupChecks).toBe(4);
    expect(result.searchNavigated).toBe(true);
    expect(result.noOverflow).toBe(true);
    expect(result.pageErrors).toEqual([]);
  }
});
