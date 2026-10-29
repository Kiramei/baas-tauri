import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions } from "../src/instructions";

const temporary: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "baas-instructions-"));
  temporary.push(root);
  const config = join(root, "config"),
    cwd = join(root, "workspace");
  await Promise.all([mkdir(config), mkdir(cwd)]);
  return { root, config, cwd };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bounded BAAS domain instructions", () => {
  test("loads global, cwd and explicit instructions in that order", async () => {
    const { config, cwd } = await workspace();
    await writeFile(join(config, "BAAS.md"), "全局习惯");
    await writeFile(join(cwd, "BAAS.md"), "项目任务");
    await writeFile(join(cwd, "extra.md"), "补充说明");
    await writeFile(join(cwd, "AGENTS.md"), "unrelated repository instructions");
    expect(await loadInstructions(config, cwd, "extra.md")).toEqual([
      { path: join(config, "BAAS.md"), text: "全局习惯" },
      { path: join(cwd, "BAAS.md"), text: "项目任务" },
      { path: join(cwd, "extra.md"), text: "补充说明" },
    ]);
  });

  test("missing conventional files are optional; explicitly requested missing files fail", async () => {
    const { config, cwd } = await workspace();
    expect(await loadInstructions(config, cwd)).toEqual([]);
    await expect(loadInstructions(config, cwd, "missing.md")).rejects.toThrow("ENOENT");
    await expect(loadInstructions(config, cwd, "BAAS.md")).rejects.toThrow("ENOENT");
    await expect(loadInstructions(config, cwd, "")).rejects.toThrow("不能为空");
  });

  test("deduplicates normalized source paths and skips whitespace-only files", async () => {
    const { config, cwd } = await workspace();
    await writeFile(join(config, "BAAS.md"), "only once");
    expect(await loadInstructions(config, config, "./BAAS.md")).toEqual([
      { path: join(config, "BAAS.md"), text: "only once" },
    ]);
    await writeFile(join(cwd, "BAAS.md"), " \n\t ");
    expect((await loadInstructions(config, cwd)).length).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "deduplicates symlink aliases of the same source",
    async () => {
      const { config, cwd } = await workspace();
      await writeFile(join(config, "BAAS.md"), "one source");
      await symlink(join(config, "BAAS.md"), join(cwd, "BAAS.md"));
      await symlink(join(config, "BAAS.md"), join(cwd, "extra.md"));
      expect(await loadInstructions(config, cwd, "extra.md")).toEqual([
        { path: join(config, "BAAS.md"), text: "one source" },
      ]);
    }
  );

  test("per-file 32 KiB and cumulative 64 KiB caps count UTF-8 bytes", async () => {
    const { config, cwd } = await workspace();
    await writeFile(join(config, "BAAS.md"), "x".repeat(32768));
    await writeFile(join(cwd, "BAAS.md"), "y".repeat(32768));
    expect((await loadInstructions(config, cwd)).length).toBe(2);
    await writeFile(join(config, "BAAS.md"), "界".repeat(10923));
    await expect(loadInstructions(config, cwd)).rejects.toThrow("32 KiB");
    await writeFile(join(config, "BAAS.md"), "界".repeat(10922));
    await writeFile(join(cwd, "BAAS.md"), "界".repeat(10922));
    await writeFile(join(cwd, "extra.md"), "界".repeat(10922));
    await expect(loadInstructions(config, cwd, "extra.md")).rejects.toThrow("64 KiB");
  });

  test("rejects binary, malformed UTF-8 and directory sources", async () => {
    const { config, cwd } = await workspace();
    await writeFile(join(cwd, "bad.md"), "before\0after");
    await expect(loadInstructions(config, cwd, "bad.md")).rejects.toThrow("有效文本");
    await writeFile(join(cwd, "bad.md"), new Uint8Array([0xc3, 0x28]));
    await expect(loadInstructions(config, cwd, "bad.md")).rejects.toThrow("UTF-8");
    await mkdir(join(cwd, "folder.md"));
    await expect(loadInstructions(config, cwd, "folder.md")).rejects.toThrow("普通文件");
  });
});
