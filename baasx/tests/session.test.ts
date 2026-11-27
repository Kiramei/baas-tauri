import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalText } from "../src/ui";

test.skipIf(process.platform === "win32" || typeof Bun.Terminal !== "function")(
  "only one terminal controls a session and its running scheduler survives detach and takeover",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "baasx-session-"));
    const terminals: Bun.Terminal[] = [];
    function open(args: string[]) {
      let screen = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 110,
        rows: 32,
        data(_, data) {
          screen += decoder.decode(data, { stream: true });
        },
      });
      terminals.push(terminal);
      const child = Bun.spawn(
        [process.execPath, "baasx/src/index.ts", "--config-home", directory, ...args],
        {
          terminal,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            BAAS_LANG: "zh",
            BAAS_REDUCED_MOTION: "1",
          },
        }
      );
      async function waitFor(value: string) {
        const deadline = Date.now() + 6000;
        while (!terminalText(screen).includes(value)) {
          if (Date.now() >= deadline)
            throw new Error(`Missing ${value}: ${terminalText(screen).slice(-2500)}`);
          await Bun.sleep(20);
        }
      }
      async function command(value: string) {
        screen = "";
        terminal.write(value);
        await waitFor(`❯ ${value}`);
        screen = "";
        terminal.write("\r");
      }
      return { child, command, waitFor, terminal };
    }
    let active = open(["--demo"]);
    try {
      await active.waitFor("已连接");
      await active.command("/start");
      await active.waitFor("运行中");
      const duplicate = open([]);
      expect(await duplicate.child.exited).toBe(1);
      await duplicate.waitFor("attach -f");
      const replacement = open(["attach", "-f"]);
      expect(await active.child.exited).toBe(0);
      active = replacement;
      await active.waitFor("运行中");
      await active.command("/detach");
      expect(await active.child.exited).toBe(0);
      active = open([]);
      await active.waitFor("运行中");
      await active.command("/stop");
      await active.waitFor("空闲");
      await active.command("/quit");
      expect(await active.child.exited).toBe(0);
      const ended = open(["attach"]);
      expect(await ended.child.exited).toBe(1);
      await ended.waitFor("No BAASX session");
    } finally {
      if (active.child.exitCode === null) active.terminal.write("\x04");
      for (const terminal of terminals) terminal.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000
);
