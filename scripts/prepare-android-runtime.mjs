import path from "node:path";
import {
  removeInside,
  repoRoot,
} from "./android-script-utils.mjs";

const pythonRoot = path.join(repoRoot, "src-tauri", "gen", "android", "app", "src", "main", "python");
// Older Android builds copied an entire baas-dev checkout into the APK. The current bootstrap
// installs the backend into app-managed storage on first run, so keeping either legacy bundle
// here would silently increase the APK and could start stale Python code instead of the version
// selected by the updater. Remove both directory and zip forms before every Android web build.
const artifacts = [
  path.join(pythonRoot, "baas_backend_bundle"),
  path.join(pythonRoot, "android_backend", "baas_backend_bundle.zip"),
  path.join(pythonRoot, "android_backend", "__pycache__"),
];

for (const artifact of artifacts) {
  removeInside(repoRoot, artifact, "Android runtime artifact");
}

console.log("Prepared lightweight Android runtime. Backend repository will be installed at first run.");
