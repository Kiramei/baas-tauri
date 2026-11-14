import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";
import { adapterTypecheckInputs } from "../../scripts/ci/frontend-adapter-inputs.mjs";

test("macOS adapter typecheck includes its shared transport consumer", () => {
  const root = resolve(import.meta.dir, "../..");
  const adapter = resolve(root, "src/platform/macos/transport.ts");
  const source = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  expect(source.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(
    { ...source.config, include: adapterTypecheckInputs("macos") },
    ts.sys,
    root,
  );
  expect(config.errors).toEqual([]);
  const host = ts.createCompilerHost(config.options);
  const originalRead = host.readFile.bind(host);
  let changed = false;
  host.readFile = (filename) => {
    const content = originalRead(filename);
    if (resolve(filename) !== adapter || !content) return content;
    const replacement = content
      .replace('import type { BackendTransportMode } from "@/transport/types";\n', "")
      .replace(": BackendTransportMode {", ": unknown {");
    changed = replacement !== content;
    return replacement;
  };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(config.fileNames, config.options, host));
  expect(changed).toBe(true);
  expect(diagnostics.some((diagnostic) => diagnostic.code === 2322 &&
    diagnostic.file?.fileName.replaceAll("\\", "/").endsWith("/src/transport/factory.ts"))).toBe(true);
}, 120_000);
