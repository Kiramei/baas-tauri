import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { parseArgs } from "node:util";

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
const metadataUrl = new URL(
  `${encodeURIComponent(info.name)}/${encodeURIComponent(info.version)}`,
  values.registry
);
const headers = { accept: "application/json" };
if (process.env.NODE_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.NODE_AUTH_TOKEN}`;
const response = await globalThis.fetch(metadataUrl, { headers });
if (response.ok) {
  const remote = await response.json();
  if (remote.dist?.integrity !== info.integrity)
    throw new Error(`${info.name}@${info.version} already exists with different contents`);
  console.log(`${info.name}@${info.version} already exists with matching integrity`);
} else if (response.status === 404) {
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
} else {
  throw new Error(
    `Cannot inspect ${info.name}@${info.version} on ${values.registry}: HTTP ${response.status}`
  );
}
