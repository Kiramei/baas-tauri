import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface InstructionSource {
  path: string;
  text: string;
}
/** BAAS.md is an explicit CLI convention; unrelated repository documentation is not ingested. */
export async function loadInstructions(
  configurationDirectory: string,
  cwd = process.cwd(),
  explicit?: string
): Promise<InstructionSource[]> {
  if (explicit !== undefined && !explicit.trim()) throw new Error("补充指令文件路径不能为空");
  const paths = [
    ...new Set(
      [
        join(configurationDirectory, "BAAS.md"),
        join(cwd, "BAAS.md"),
        ...(explicit ? [resolve(cwd, explicit)] : []),
      ].map((path) => resolve(path))
    ),
  ];
  const sources: InstructionSource[] = [];
  const loaded = new Set<string>();
  let total = 0;
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`指令路径必须是普通文件：${path}`);
      if (info.size > 32768) throw new Error(`指令文件超过 32 KiB：${path}`);
      const canonical = await realpath(path);
      if (loaded.has(canonical)) continue;
      const bytes = await readFile(canonical);
      if (bytes.byteLength > 32768) throw new Error(`指令文件超过 32 KiB：${path}`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`指令文件不是有效 UTF-8 文本：${path}`);
      }
      if (text.includes("\0")) throw new Error(`指令文件不是有效文本：${path}`);
      total += bytes.byteLength;
      if (total > 65536) throw new Error("本地指令总量超过 64 KiB");
      loaded.add(canonical);
      if (text.trim()) sources.push({ path: canonical, text });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        path !== (explicit ? resolve(cwd, explicit) : undefined)
      )
        continue;
      throw error;
    }
  }
  return sources;
}
