import path from "node:path";
import {
  removeInside,
  repoRoot,
} from "./android-script-utils.mjs";

const pythonRoot = path.join(repoRoot, "src-tauri", "gen", "android", "app", "src", "main", "python");
const artifacts = [
  path.join(pythonRoot, "baas_backend_bundle"),
  path.join(pythonRoot, "android_backend", "baas_backend_bundle.zip"),
  path.join(pythonRoot, "android_backend", "__pycache__"),
];

for (const artifact of artifacts) {
  removeInside(repoRoot, artifact, "Android runtime artifact");
}

console.log("Prepared lightweight Android runtime. Backend repository will be installed at first run.");
