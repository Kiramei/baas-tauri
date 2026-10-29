import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseVersion } from "./release-version-files.mjs";

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    JSON.stringify(checkReleaseVersion(root, process.argv[2] ?? process.env.GITHUB_REF_NAME))
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
