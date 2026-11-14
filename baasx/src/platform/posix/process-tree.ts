import { execFile, type ChildProcess } from "node:child_process";

export async function stopPosixProcessTree(child: ChildProcess, pid: number): Promise<void> {
  // PTYs may create a new session/process group. Snapshot descendants before
  // signalling the helper so those processes cannot escape by becoming orphans.
  const descendants = await new Promise<number[]>((done) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid="],
      { timeout: 1500, maxBuffer: 2 * 1024 * 1024 },
      (error, output) => {
        if (error) return done([]);
        const parents = new Map<number, number[]>();
        for (const line of output.split("\n")) {
          const fields = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
          if (!fields) continue;
          const processId = Number(fields[1]),
            parentId = Number(fields[2]);
          if (processId <= 1 || processId === process.pid) continue;
          parents.set(parentId, [...(parents.get(parentId) || []), processId]);
        }
        const result: number[] = [];
        const pending = [...(parents.get(pid) || [])];
        const seen = new Set<number>();
        while (pending.length && result.length < 10_000) {
          const current = pending.pop()!;
          if (seen.has(current)) continue;
          seen.add(current);
          result.push(current);
          pending.push(...(parents.get(current) || []));
        }
        done(result.reverse());
      }
    );
  });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
    }
  };
  killGroup("SIGTERM");
  // A helper can have exited while a compiler/downloader remains in its process group.
  await new Promise((done) => setTimeout(done, 200));
  for (const descendant of descendants) {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      /* The helper may already have reaped the descendant. */
    }
  }
  killGroup("SIGKILL");
}
