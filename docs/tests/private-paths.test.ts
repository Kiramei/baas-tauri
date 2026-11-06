import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("tracked text does not contain personal home-directory paths", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(listing.exitCode).toBe(0);
  const files = new TextDecoder().decode(listing.stdout).split("\0").filter(Boolean);
  const leaked: string[] = [];
  const personalPath = /(?:\/home\/[^/\s"'<>]+\/|\/Users\/[^/\s"'<>]+\/|\/mnt\/[A-Za-z]\/Users\/[^/\s"'<>]+\/|[A-Za-z]:[\\/]+(?:Users|WorkSpace)[\\/]+[^\\/\s"'<>]+[\\/]+)/;
  for (const file of files) {
    let data: Buffer;
    try { data = readFileSync(new URL("../../" + file, import.meta.url)); } catch { continue; }
    if (data.includes(0)) continue;
    if (personalPath.test(data.toString("utf8"))) leaked.push(file);
  }
  expect(leaked).toEqual([]);
});
