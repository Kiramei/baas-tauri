import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBenchmark } from "./validate-native-benchmark.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const report = JSON.parse(
  readFileSync(
    path.resolve(root, process.argv[2] || ".cache/docs-benchmarks/native-transport.json"),
    "utf8"
  )
);
const currentHarnessFiles = Object.fromEntries(
  ["docs/scripts/measure-native-transport.mjs", "docs/scripts/benchmark-statistics.mjs"].map(
    (file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]
  )
);
validateNativeBenchmark(report, currentHarnessFiles);
report.method.outputEquivalence =
  "Every production callback is exactly 44 UTF-8 JSON bytes after the store removes the transport envelope/timestamp: command=status, status=ok, data={}. This is not encrypted wire size or a large-payload throughput workload.";
report.method.network =
  "Frontend and backend on the same host; WebSocket uses loopback. No LAN/WAN network path.";
writeFileSync(
  path.join(root, "docs/public/benchmarks/native-transport-current.json"),
  JSON.stringify(report, null, 2) + "\n"
);
console.log(
  JSON.stringify({
    modes: report.results.map((result) => result.mode),
    measuredCalls: report.results.reduce((sum, result) => sum + result.count, 0),
    failures: report.results.reduce((sum, result) => sum + result.failedAttempts, 0),
  })
);
