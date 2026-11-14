// Modern Node cannot exec a .cmd directly. Resolve npm's public CLI script
// beside the Windows Node installation and pass arguments without a shell.
import { existsSync } from "node:fs";
import path from "node:path";
export function npmCommand(args) {
  if (process.platform !== "win32") return ["npm", ...args];
  const cli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(cli)) throw new Error("npm-cli.js is missing from the active Node installation");
  return [process.execPath, cli, ...args];
}
