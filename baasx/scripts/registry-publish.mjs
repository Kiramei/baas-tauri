import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ensureRegistryPackage } from "./registry-check.mjs";

const { values } = parseArgs({
  options: {
    info: { type: "string" },
    registry: { type: "string" },
    tag: { type: "string", default: "latest" },
  },
});
if (
  !values.info ||
  !["https://registry.npmjs.org/", "https://npm.pkg.github.com/"].includes(values.registry)
) {
  throw new Error("Provide --info <package info JSON> and a supported --registry URL");
}
const info = JSON.parse(readFileSync(values.info, "utf8"));
const status = await ensureRegistryPackage({
  registry: values.registry,
  info,
  token: process.env.NODE_AUTH_TOKEN,
  publish() {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(
      npm,
      [
        "publish",
        info.archive,
        "--ignore-scripts",
        "--registry",
        values.registry,
        "--access",
        "public",
        "--tag",
        values.tag,
      ],
      { stdio: "inherit" }
    );
  },
});
if (status === "matching") {
  console.log(`${info.name}@${info.version} already exists with matching integrity`);
}
