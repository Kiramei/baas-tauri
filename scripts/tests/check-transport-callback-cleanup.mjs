import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rejectPendingTransportCallbacks } from "../../src/store/transportCallbackCleanup.ts";

const root = process.cwd();
const store = readFileSync(resolve(root, "src/store/WebsocketStore.ts"), "utf8");

const observed = [];
const originalConsoleError = console.error;
console.error = () => undefined;
let reset;
try {
  reset = rejectPendingTransportCallbacks(
    {
      pendingCallbacks: {
        11: (payload) => observed.push(["command", payload]),
        12: () => {
          throw new Error("callback failure must not stop cleanup");
        },
      },
      pendingStreamCallbacks: {
        21: (payload) => observed.push(["stream", payload]),
      },
      pendingBinaryCallbacks: {
        31: () => observed.push(["binary"]),
      },
      pendingBinaryQueue: [31],
    },
    "trigger transport closed"
  );
} finally {
  console.error = originalConsoleError;
}

if (
  observed.length !== 2 ||
  observed[0][0] !== "command" ||
  observed[1][0] !== "stream" ||
  observed[0][1].status !== "error" ||
  observed[0][1].error !== "trigger transport closed" ||
  observed[1][1].error !== "trigger transport closed"
) {
  console.error("transport callback cleanup behavior check failed");
  console.error(JSON.stringify(observed));
  process.exit(1);
}

for (const [key, value] of Object.entries(reset)) {
  if (Array.isArray(value) ? value.length !== 0 : Object.keys(value).length !== 0) {
    console.error(`transport callback cleanup did not clear ${key}`);
    process.exit(1);
  }
}

const requiredSnippets = [
  'import { rejectPendingTransportCallbacks } from "@/store/transportCallbackCleanup"',
  "pendingCallbacks: {}",
  "pendingStreamCallbacks: {}",
  "pendingBinaryCallbacks: {}",
  "pendingBinaryQueue: []",
  'rejectPendingTransportCallbacks(state, "Control connection closed")',
  "rejectPendingTransportCallbacks(state, `${name} transport closed`)",
  "rejectPendingTransportCallbacks(state, `${name} transport error`)",
  "rejectPendingTransportCallbacks(state, `${name} transport disconnected`)",
  'name === "sync" || name === "trigger"',
];

const missing = requiredSnippets.filter((snippet) => !store.includes(snippet));
if (missing.length > 0) {
  console.error("transport callback cleanup check failed; missing snippets:");
  for (const snippet of missing) {
    console.error(`- ${snippet}`);
  }
  process.exit(1);
}

console.log("transport callback cleanup check passed");
