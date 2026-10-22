import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [backendSource, destination, binary, python] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
if (![backendSource, destination, binary, python].every(Boolean))
  throw new Error("Expected backend source, NEW destination, binary, Python executable");
if (existsSync(destination)) throw new Error("Capture runtime destination must be new");
if (!existsSync(path.join(backendSource, "main.service.py")))
  throw new Error("Not a BAAS backend source");
mkdirSync(destination, { recursive: true });
for (const name of [
  "core",
  "module",
  "service",
  "deploy",
  "src",
  "main.py",
  "main.service.py",
  "requirements.txt",
  "requirements.service.lock",
  "pyproject.toml",
]) {
  const source = path.join(backendSource, name);
  if (existsSync(source))
    cpSync(source, path.join(destination, name), {
      recursive: true,
      filter: (file) => !file.includes("__pycache__") && !file.endsWith(".pyc"),
    });
}
const config = path.join(destination, "config");
mkdirSync(config);
cpSync(path.join(backendSource, "config/default_config"), path.join(config, "default_config"), {
  recursive: true,
});
cpSync(path.join(backendSource, "config/static.json"), path.join(config, "static.json"));
const profile = path.join(config, "documentation");
mkdirSync(profile);
for (const name of ["config.json", "event.json", "switch.json"]) {
  const value = JSON.parse(readFileSync(path.join(config, "default_config", name), "utf8"));
  if (name === "config.json")
    Object.assign(value, {
      name: "Schale Demo",
      autostart: false,
      open_emulator_stat: false,
      then: "无动作",
      adbIP: "127.0.0.1",
      adbPort: "16384",
      program_address: "",
      push_json: "",
      push_serverchan: "",
    });
  if (name === "event.json") for (const event of value) event.enabled = false;
  writeFileSync(path.join(profile, name), `${JSON.stringify(value, null, 2)}\n`);
}
cpSync(binary, path.join(destination, "baas-tauri.exe"));
writeFileSync(
  path.join(destination, "setup.toml"),
  `[general]\ntransport = "shm"\ntransport_version = 1\nchannel = "dev"\nno_update = true\nlaunch = true\n\n[paths]\nbaas_root_path = "."\n\n[python]\nruntime_path = ${JSON.stringify(python.replaceAll("\\", "/"))}\n`
);
writeFileSync(
  path.join(destination, ".app_storage.json"),
  `${JSON.stringify({ uiSettings: { lang: "en", theme: "light", idleAutoUpdate: false, enableBAComet: false, minimizeToTray: false }, theme: "light" }, null, 2)}\n`
);
console.log(
  JSON.stringify({
    destination,
    copiedUserAuthentication: false,
    profile: "documentation",
    allTasksDisabled: true,
  })
);
