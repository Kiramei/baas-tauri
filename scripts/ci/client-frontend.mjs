import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { adapterTypecheckInputs } from "./frontend-adapter-inputs.mjs";

const allowed = new Set(["webui", "tauri", "android", "windows", "macos", "linux"]);
const oses = { windows: "windows-latest", macos: "macos-latest", linux: "ubuntu-24.04" };

export function parseModes(value) {
  const modes = JSON.parse(value);
  if (!Array.isArray(modes) || !modes.length || modes.some(mode => typeof mode !== "string" || !allowed.has(mode)) || new Set(modes).size !== modes.length) {
    throw new Error("modes must be a nonempty JSON array of distinct supported modes");
  }
  return modes;
}

function run(command, ...args) {
  console.log(`+ ${command} ${args.join(" ")}`);
  const executable = command === "bun" || command === "bunx" ? process.execPath : command;
  const result = spawnSync(executable, command === "bunx" ? ["x", ...args] : args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

const modeInput = process.env.MODES;
if (process.argv[2] === "validate") {
  const modes = parseModes(modeInput);
  const bundles = modes.some(mode => ["webui", "tauri", "android"].includes(mode));
  const matrix = JSON.parse(process.env.ADAPTERS);
  const expected = modes.filter(mode => mode in oses).sort();
  if (process.env.BUNDLES !== String(bundles) || !matrix || Array.isArray(matrix) || Object.keys(matrix).join() !== "include" || !Array.isArray(matrix.include) ||
      matrix.include.some(entry => !entry || Object.keys(entry).sort().join() !== "mode,os" || oses[entry.mode] !== entry.os) ||
      JSON.stringify(matrix.include.map(entry => entry.mode).sort()) !== JSON.stringify(expected)) {
    throw new Error("frontend caller's modes, bundles and adapter matrix disagree");
  }
} else if (process.argv[2] === "client") {
  const modes = parseModes(modeInput);
  const desktop = modes.includes("webui") || modes.includes("tauri");
  const android = modes.includes("android");
  if (!desktop && !android) throw new Error("client job needs a client mode");
  const tests = readdirSync("tests/frontend").filter(name => /\.test\.tsx?$/.test(name));
  const androidTest = name => /^(Android|MobileNavigation)/.test(name);
  const nativeTest = name => /^(Tauri|Native|PcProfiles)/.test(name);
  const ciTest = name => /^(CiPolicy|ReleasePublishing|ReleaseWorkflows|Windows|Linux|Mac)/.test(name);
  const selected = tests.filter(name => !ciTest(name) && (androidTest(name) ? android : nativeTest(name) ? modes.includes("tauri") : true)).map(name => `tests/frontend/${name}`);
  if (android && existsSync("tests/frontend/platform/android")) selected.push("tests/frontend/platform/android");
  const lint = desktop ? (android ? ["src"] : ["src", "--ignore-pattern", "src/android/**"]) : ["src/android", ...readdirSync("src/shared").filter(name => /^Android.*\.tsx?$/.test(name)).map(name => `src/shared/${name}`)];
  if (!desktop && android) lint.push(...readdirSync("src/components").filter(name => /^Android.*\.tsx?$/.test(name)).map(name => `src/components/${name}`));
  run("bunx", "eslint", ...lint, ...selected, "--ext", ".ts,.tsx");
  run("bun", "run", "i18n:check");
  run("bun", "test", ...selected);
  if (desktop) run("bunx", "tsc", "-p", "tsconfig.ci.desktop.json");
  if (android) run("bunx", "tsc", "-p", "tsconfig.ci.android.json");
  for (const mode of ["webui", "tauri", "android"]) {
    if (!modes.includes(mode)) continue;
    run("bunx", "vite", "build", "--mode", mode);
    if (mode === "android") {
      run("bun", "scripts/android-css-compat.mjs");
      run("bun", "scripts/prepare-android-runtime.mjs");
    }
  }
} else if (process.argv[2] === "os") {
  const os = process.env.CLIENT_OS;
  if (!(os in oses)) throw new Error("unsupported OS mode");
  const config = `tsconfig.ci.${os}.generated.json`;
  const tests = ["NativeFullscreen", "SettingsShortcut", "ApplicationShortcuts"];
  if (os === "windows") tests.push("PcProfiles");
  if (os === "macos") tests.push("TransportFactory");
  const prefixes = { windows: /^Windows/, macos: /^Mac/, linux: /^Linux/ };
  const platformTests = readdirSync("tests/frontend")
    .filter(name => prefixes[os].test(name) && /\.test\.tsx?$/.test(name))
    .map(name => `tests/frontend/${name}`);
  const platformDir = `tests/frontend/platform/${os}`;
  if (existsSync(platformDir)) platformTests.push(platformDir);
  const testPaths = [...tests.map(name => `tests/frontend/${name}.test.ts`), ...platformTests];
  try {
    writeFileSync(config, JSON.stringify({ extends: "./tsconfig.json", include: adapterTypecheckInputs(os) }));
    run("bunx", "eslint", `src/platform/${os}`, ...testPaths, "--ext", ".ts,.tsx");
    run("bunx", "tsc", "-p", config);
    run("bun", "test", ...testPaths);
    run("bun", "scripts/ci/build-frontend-adapter.mjs", os);
  } finally {
    rmSync(config, { force: true });
  }
} else {
  throw new Error("expected validate, client, or os command");
}
