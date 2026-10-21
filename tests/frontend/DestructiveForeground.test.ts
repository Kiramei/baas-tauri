import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

test("destructive controls generate a white foreground utility", async () => {
  const stylesheet = new URL("../../src/styles/index.css", import.meta.url);
  const compiler = await compile(await readFile(stylesheet, "utf8"), {
    base: fileURLToPath(new URL(".", stylesheet)),
    onDependency() {},
  });
  const css = compiler.build(["bg-destructive", "text-destructive-foreground", "fill-current"]);

  expect(css).toContain(".text-destructive-foreground {");
  expect(css).toContain("color: var(--destructive-foreground);");
  expect(css).toContain("--destructive-foreground: #ffffff;");
});
