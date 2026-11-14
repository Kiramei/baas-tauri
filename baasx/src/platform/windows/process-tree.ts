import { spawn, type ChildProcess } from "node:child_process";

export async function stopWindowsProcessTree(child: ChildProcess, pid: number): Promise<void> {
  await new Promise<void>((done) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
      child.kill();
      done();
    }, 2000);
    killer.once("error", () => {
      clearTimeout(timer);
      child.kill();
      done();
    });
    killer.once("close", () => {
      clearTimeout(timer);
      done();
    });
  });
}
