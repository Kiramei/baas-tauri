import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(root, "docs/public");
const scan = JSON.parse(
  readFileSync(
    path.resolve(root, process.argv[2] || ".cache/docs-privacy/all-public-ocr.json"),
    "utf8"
  ).replace(/^\uFEFF/, "")
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const patterns = [
  ["local-path", /\b[a-z]\s*:\s*[\\/]+/i],
  ["private-workspace", /WorkSpace|\.codex_tmp|\\Users\\/i],
  [
    "ephemeral-identifier",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|baas-shm-/i,
  ],
  ["long-numeric-identifier", /\b\d{12,}\b/],
  ["email-address", /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i],
  ["credential-assignment", /\b(?:password|token|secret|api_key|cdk)\s*[=:]\s*\S+/i],
];
const genericPathExamples = new Map([
  [
    "media/desktop/en/config-emulator.png",
    "ecfb5c1b1d63fcf650d44aa02a80cfa9f17ca2fa314bb461fadc714055af0855",
  ],
  [
    "media/desktop/zh/config-emulator.png",
    "49d968c9f0a16d0274f3123567d61ebf9e3640feb79d14ae8907f21446af96a9",
  ],
]);
const pendingVisualFindings = [
  {
    file: "backend-assets/pc_platform/setting_screen_windowed_ratio_16_9.png",
    sha256: "63687ea8697e1699c19c8b02c6b095949a0da672f1f292a9193bc2f74bda9757",
    category: "legacy-game-nickname",
  },
  {
    file: "backend-assets/auto_fight/cvat_ai_guide1.png",
    sha256: "d62368a01839956743bdbd75a3791646396bd2a3779103705ff13bc3b6288f13",
    category: "legacy-shared-account-and-job-identifiers",
  },
];
const files = readdirSync(publicRoot, { recursive: true })
  .filter((file) => /\.(png|jpe?g|gif|webp)$/i.test(file))
  .map((file) => file.replaceAll("\\", "/"))
  .sort();
assert.deepEqual(scan.files.map((file) => file.file).sort(), files, "OCR inventory is stale");
const reviewedFindings = [];
const unresolved = [];
const inventory = [];
let frames = 0;
for (const file of scan.files) {
  assert.equal(file.failure, null, "OCR decoding failed: " + file.file);
  const sha256 = digest(readFileSync(path.join(publicRoot, file.file)));
  assert.equal(file.sha256, sha256, "Image changed since OCR: " + file.file);
  inventory.push({ file: file.file, sha256 });
  frames += file.frames.length;
  const detected = patterns
    .filter(([, pattern]) => file.frames.some((frame) => pattern.test(frame.text)))
    .map(([name]) => name);
  if (!detected.length) continue;
  if (
    detected.length === 1 &&
    detected[0] === "local-path" &&
    genericPathExamples.get(file.file) === sha256
  ) {
    reviewedFindings.push({
      file: file.file,
      sha256,
      category: "generic-path-placeholder",
      review:
        "Visually checked: empty emulator-path field with the generic emulator.exe path placeholder.",
    });
  } else unresolved.push({ file: file.file, categories: detected });
}
assert.deepEqual(
  unresolved,
  [],
  "Potential private text requires visual review; raw OCR remains in the ignored cache"
);
inventory.sort((left, right) => left.file.localeCompare(right.file));
const report = {
  checkedAt: scan.checkedAt,
  method:
    "Local Windows OCR (zh-Hans-CN), every decoded image/GIF frame, pattern checks and visual review of flagged generic paths. Input hashes must match the current public assets.",
  imageFiles: files.length,
  decodedFrames: frames,
  decodingFailures: 0,
  unresolvedPatternFindings: 0,
  inventorySha256: digest(JSON.stringify(inventory)),
  reviewedFindings,
  publicationReviewComplete: false,
  pendingVisualFindings: pendingVisualFindings.filter((finding) =>
    inventory.some((file) => file.file === finding.file && file.sha256 === finding.sha256)
  ),
  redaction:
    "New installer captures use local 12px blur before writing PNGs. The capture checks computed blur styles, including low-effects mode and visible node tooltips. Unblurred installer captures and OCR text are excluded from published assets.",
  limits:
    "OCR and pattern checks can miss account names, QR codes, private hosts or illegible text. This report does not certify every asset as free of sensitive information; new or changed media requires another review.",
};
writeFileSync(
  path.join(root, "docs/evidence/privacy-review.json"),
  JSON.stringify(report, null, 2) + "\n"
);
console.log(
  JSON.stringify({
    imageFiles: report.imageFiles,
    decodedFrames: frames,
    reviewedFindings: reviewedFindings.length,
    unresolvedPatternFindings: 0,
  })
);
