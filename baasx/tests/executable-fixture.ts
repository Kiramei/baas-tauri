import { execFile } from "node:child_process";
import { link, mkdtemp, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let launcher: Promise<string> | undefined;

/** A real executable keeps fixtures on RuntimeManager's normal spawn path on Windows. */
export function prepareExecutableFixtures(): Promise<string> {
  return (launcher ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-fixture-launcher-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const entry = join(directory, "launcher.ts");
    const executable = join(directory, process.platform === "win32" ? "launcher.exe" : "launcher");
    await writeFile(
      entry,
      `import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(process.execPath)}, [process.execPath + ".mjs", ...process.argv.slice(2)], {
  stdio: "inherit", windowsHide: true,
});
child.once("error", error => { console.error(error); process.exit(1); });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`
    );
    await execute(process.execPath, ["build", entry, "--compile", "--outfile", executable], {
      timeout: 30_000,
      windowsHide: true,
    });
    return executable;
  })());
}

export async function writeExecutableFixture(
  directory: string,
  name: string,
  source: string
): Promise<string> {
  const executable = join(directory, process.platform === "win32" ? `${name}.exe` : name);
  await writeFile(`${executable}.mjs`, source);
  // Every fixture has its own entry point without copying Bun's runtime for each test.
  await link(await prepareExecutableFixtures(), executable);
  return executable;
}
