import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { terminalText } from "../src/ui";

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function launch(directory: string, flags: string[] = []) {
  const helperCalled = join(directory, "unexpected-helper");
  const networkCalled = join(directory, "unexpected-network");
  const helper = join(directory, "helper-spy");
  const guard = join(directory, "network-guard.ts");
  await writeFile(
    helper,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(helperCalled)},'called');\nprocess.exit(1);\n`,
    { mode: 0o700 }
  );
  await writeFile(
    guard,
    `
    import {writeFileSync} from 'node:fs';
    import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    const refuse = () => { writeFileSync(${JSON.stringify(networkCalled)},'called'); throw new Error('Unexpected onboarding network connection'); };
    net.createConnection = refuse;
    net.connect = refuse;
    syncBuiltinESMExports();
    globalThis.WebSocket = new Proxy(globalThis.WebSocket,{construct:refuse});
    const localFetch = globalThis.fetch;
    // Ink's bundled Yoga WebAssembly uses a data: URL; it performs no network I/O.
    globalThis.fetch = (input, ...options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/^(?:data|file):/.test(url)) return refuse();
      return localFetch(input, ...options);
    };
  `
  );
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 36,
    data(_terminal, bytes) {
      output += decoder.decode(bytes, { stream: true });
    },
  });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("BAAS_")) delete env[name];
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      guard,
      join(import.meta.dir, "../src/index.ts"),
      "--no-color",
      "--config-home",
      directory,
      ...flags,
    ],
    {
      terminal,
      env: {
        ...env,
        BAAS_RUNTIME_HELPER: helper,
        NO_COLOR: "1",
        TERM: "xterm-256color",
        LANG: "fr_FR.UTF-8",
        LC_ALL: undefined,
        LC_MESSAGES: undefined,
      },
    }
  );
  let cursor = 0;
  return {
    helperCalled,
    networkCalled,
    get text() {
      return terminalText(output);
    },
    async until(text: string) {
      const deadline = Date.now() + 7000;
      for (;;) {
        const plain = terminalText(output);
        const index = plain.indexOf(text, cursor);
        if (index >= 0) {
          cursor = index + text.length;
          return;
        }
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(
            `Onboarding did not reach ${JSON.stringify(text)}: ${plain.slice(-8000)}`
          );
        await Bun.sleep(15);
      }
    },
    async key(value: string) {
      terminal.write(value);
      await Bun.sleep(80);
    },
    async quit() {
      terminal.write("\x04");
      expect(await child.exited).toBe(0);
    },
    close() {
      if (child.exitCode === null) child.kill();
      terminal.close();
    },
  };
}

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "first-run installation is opt-in, denial touches no runtime or network, and the chosen language survives restart",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baas-onboarding-"));
    let app: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      app = await launch(directory);
      await app.until("简体中文");
      await app.key("\r");
      await app.until("选择运行方式");
      await app.until("安装本地环境");
      await app.key("\r");
      await app.until("安装目录");
      await app.key("\r");
      await app.until("开始安装");
      await app.key("n");
      await app.key("\r");
      await app.until("选择运行方式");
      expect(await exists(join(directory, "runtime"))).toBe(false);
      expect(await exists(join(directory, "runtime.json"))).toBe(false);
      expect(await exists(app.helperCalled)).toBe(false);
      expect(await exists(app.networkCalled)).toBe(false);
      expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")).language).toBe(
        "zh"
      );
      await app.quit();
      app.close();
      app = await launch(directory);
      await app.until("选择运行方式");
      expect(app.text).not.toContain("简体中文");
      expect(await exists(join(directory, "runtime"))).toBe(false);
      expect(await exists(app.helperCalled)).toBe(false);
      expect(await exists(app.networkCalled)).toBe(false);
      await app.quit();
    } finally {
      app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000
);

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function").each([false, true])(
  "an explicit remote endpoint skips local installation while respecting first-run language choice (explicit language: %s)",
  async (explicitLanguage) => {
    const directory = await mkdtemp(join(tmpdir(), "baas-onboarding-remote-"));
    const endpoint = "ws://127.0.0.1:19876";
    let app: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      app = await launch(directory, [
        "--server",
        endpoint,
        ...(explicitLanguage ? ["--lang", "zh"] : []),
      ]);
      if (!explicitLanguage) {
        await app.until("简体中文");
        await app.key("\r");
      }
      await app.until(endpoint);
      await Bun.sleep(100);
      expect(app.text).not.toContain("选择运行方式");
      expect(app.text).not.toContain("安装目录");
      expect(await exists(join(directory, "runtime"))).toBe(false);
      expect(await exists(app.helperCalled)).toBe(false);
      expect(await exists(app.networkCalled)).toBe(false);
      await app.quit();
    } finally {
      app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000
);
