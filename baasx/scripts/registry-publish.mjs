import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { npmCommand } from "./host-npm.mjs";
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
const packages = JSON.parse(readFileSync(values.info, "utf8"));
for (const info of packages) {
  // The unscoped name is pending approval. Ignore it even in older package lists.
  if (info.name === "baasx") continue;
  const status = await ensureRegistryPackage({
    registry: values.registry,
    info,
    token: process.env.NODE_AUTH_TOKEN,
    tag: values.tag,
    publish(publishTag) {
      const [npm, ...args] = npmCommand([
        "publish",
        info.archive,
        "--ignore-scripts",
        "--registry",
        values.registry,
        "--access",
        "public",
        "--tag",
        publishTag,
      ]);
      execFileSync(npm, args, { stdio: "inherit" });
    },
  });
  if (status === "matching") {
    console.log(`${info.name}@${info.version} already exists with matching integrity`);
  }
}
