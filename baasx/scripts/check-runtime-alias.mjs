// Run on extracted native distributions. The helper's lease command keeps
// stdin open; forced launcher termination must also dispose of the child.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const legacy = process.argv[2];
const primary = process.argv[3];
const root = mkdtempSync(path.join(tmpdir(), "baasx alias 测试 "));
try {
  for (const args of [["inspect", "--root", root], ["invalid-command"]]) {
    const run = (exe) => spawnSync(exe, args, { encoding: "utf8" });
    const current = run(primary);
    const old = run(legacy);
    assert.ifError(current.error);
    assert.ifError(old.error);
    assert.equal(old.status, current.status);
    assert.deepEqual(JSON.parse(old.stdout), JSON.parse(current.stdout));
    assert.equal(old.stderr, current.stderr);
  }
  if (process.platform === "win32") {
    // Use a harmless long-lived copy of Node in place of the helper to exercise
    // the shim with a child that cannot accidentally exit when its pipes close.
    const primaryCopy = path.join(root, "baasx-runtime.exe");
    const legacyCopy = path.join(root, "baas-cli-runtime.exe");
    copyFileSync(process.execPath, primaryCopy);
    copyFileSync(legacy, legacyCopy);
    const child = spawn(legacyCopy, ["-e", "console.log(process.pid); setInterval(()=>{},60000)"], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    try {
      const first = await Promise.race([
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error("launcher exited before child started: " + code))
          );
          child.stdout.once("data", resolve);
        }),
        delay(10000, null, { ref: false }),
      ]);
      assert.ok(first, "timed out waiting for forwarded child stdout");
      const pid = Number(first.toString().trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      child.kill();
      const deadline = Date.now() + 10000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        assert.ok(Date.now() < deadline, "terminated launcher left native helper running");
        await delay(50);
      }
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
