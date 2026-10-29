import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { normalizeReleaseVersion } from "../src/shared/ReleaseVersion.mjs";

const UpdateLog = "UPDATE.md";

export function parseUpdateLog(data) {
  const sections = new Map();
  let current;
  for (const line of data.split("\n")) {
    const heading = /^##\s+(\S+)/.exec(line);
    const version = heading && normalizeReleaseVersion(heading[1]);
    if (version) {
      current = version;
      if (sections.has(current)) throw new Error(`Duplicate release notes for ${current}`);
      sections.set(current, []);
    } else if (/^---/.test(line)) current = null;
    else if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([tag, lines]) => [tag, lines.join("\n").trim()]));
}

async function readSections() {
  const file = path.join(process.cwd(), UpdateLog);
  if (!fs.existsSync(file)) throw new Error("could not find UPDATE.md");
  return parseUpdateLog(await fsp.readFile(file, "utf-8"));
}

export async function resolveUpdateLog(tag) {
  const canonical = normalizeReleaseVersion(tag);
  const sections = await readSections();
  if (!canonical || !sections.has(canonical))
    throw new Error(`could not find "${tag}" in UPDATE.md`);
  return sections.get(canonical);
}

export async function resolveUpdateLogDefault() {
  const sections = await readSections();
  if (!sections.size) throw new Error("could not find any version tag in UPDATE.md");
  return sections.values().next().value;
}
