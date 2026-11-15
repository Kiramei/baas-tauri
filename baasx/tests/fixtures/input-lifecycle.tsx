import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";

// Run in a child process so the controlled React scheduler cannot affect other tests.
const inkRequire = createRequire(import.meta.resolve("ink"));
const reconcilerRequire = createRequire(inkRequire.resolve("react-reconciler"));
const scheduler = reconcilerRequire("scheduler");
const schedule = scheduler.unstable_scheduleCallback;
let holdPassive = false;
const pending: Array<() => void> = [];
scheduler.unstable_scheduleCallback = (
  priority: number,
  callback: () => unknown,
  options: unknown
) => {
  if (holdPassive && callback.toString().includes("flushPassiveEffects")) {
    pending.push(() => schedule(priority, callback, options));
    return schedule(priority, () => null, options);
  }
  return schedule(priority, callback, options);
};

const React = await import("react");
const { useEffect, useLayoutEffect, useState } = React;
const { Box, Text, render, useInput, useStdin } = await import("ink");
const { FieldEditor } = await import("../../src/field-editor");
const priority = process.argv[2] === "priority";

function latch() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
const rootReady = latch();
let layout = latch();
let passive = latch();
let passiveRan = false;
let transition!: (next: { visible: boolean; active: boolean; phase: number }) => void;
let emitter!: { listenerCount(name: string): number };
let frame = "";
const values: unknown[] = [];
const modes: boolean[] = [];
const source = Object.assign(new PassThrough({ objectMode: true }), {
  isTTY: true,
  setRawMode(value: boolean) {
    modes.push(value);
  },
  ref() {},
  unref() {},
});
const target = Object.assign(
  new Writable({
    write(chunk, _encoding, done) {
      frame = String(chunk);
      done();
    },
  }),
  { isTTY: true, columns: 90, rows: 30 }
);

function Marker({ phase }: { phase: number }) {
  useLayoutEffect(() => {
    layout.resolve();
  }, [phase]);
  useEffect(() => {
    passiveRan = true;
    passive.resolve();
  }, [phase]);
  return null;
}
function Root() {
  const [state, setState] = useState({ visible: false, active: true, phase: 0 });
  const { internal_eventEmitter } = useStdin();
  // Keep the stream reader alive while the conditional editor mounts and unmounts.
  useInput(() => {});
  useLayoutEffect(() => {
    transition = setState;
    emitter = internal_eventEmitter;
  }, [internal_eventEmitter]);
  useEffect(() => {
    rootReady.resolve();
  }, []);
  return (
    <Box flexDirection="column">
      {state.visible ? (
        <FieldEditor
          field={{
            label: priority ? "Priority" : "Enum",
            type: priority ? "multiselect" : "select",
            ordered: priority,
            value: priority ? ["adb", "scrcpy"] : "adb",
            options: [
              { label: "ADB", value: "adb" },
              { label: "scrcpy", value: "scrcpy" },
            ],
          }}
          width={88}
          height={20}
          language="zh"
          active={state.active}
          onSave={(value) => {
            values.push(value);
          }}
          onCancel={() => {}}
        />
      ) : (
        <Text>Parent</Text>
      )}
      <Marker phase={state.phase} />
    </Box>
  );
}

const app = render(<Root />, {
  stdin: source as unknown as NodeJS.ReadStream,
  stdout: target as unknown as NodeJS.WriteStream,
  debug: true,
  patchConsole: false,
  exitOnCtrlC: false,
  maxFps: 1000,
});
const key = (text: string) => {
  source.write(text);
  source.emit("readable");
};
const release = async () => {
  holdPassive = false;
  for (const run of pending.splice(0)) run();
  await passive.promise;
};
const move = async (visible: boolean, active: boolean, phase: number) => {
  layout = latch();
  passive = latch();
  passiveRan = false;
  holdPassive = true;
  transition({ visible, active, phase });
  await layout.promise;
  if (passiveRan || pending.length === 0) throw new Error("Passive-effect gate did not hold");
  return emitter.listenerCount("input");
};
try {
  await rootReady.promise;
  const initial = emitter.listenerCount("input");
  const mounted = await move(true, true, 1);
  if (!frame.includes("保存") || !frame.includes("ADB")) throw new Error("Editor frame missing");
  key(priority ? "\x1b[C" : "\x1b[B");
  await release();
  key(priority ? "\x13" : "\r");
  await Promise.resolve();
  const inactive = await move(true, false, 2);
  key("\x1b[B");
  await release();
  const reactivated = await move(true, true, 3);
  key(priority ? "\x1b[D" : "\x1b[A");
  await release();
  key(priority ? "\x13" : "\r");
  await Promise.resolve();
  const unmounted = await move(false, true, 4);
  key("\x1b[B");
  await release();
  app.unmount();
  app.cleanup();
  await Promise.resolve();
  process.stdout.write(
    JSON.stringify({
      initial,
      mounted,
      inactive,
      reactivated,
      unmounted,
      finished: emitter.listenerCount("input"),
      readers: source.listenerCount("readable"),
      values,
      modes,
    }) + "\n"
  );
} finally {
  holdPassive = false;
  for (const run of pending.splice(0)) run();
  source.destroy();
  target.destroy();
  scheduler.unstable_scheduleCallback = schedule;
}
