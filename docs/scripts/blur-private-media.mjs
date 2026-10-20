import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(root, "docs/public");
const evidencePath = path.join(root, "docs/evidence/legacy-media-blur.json");
const digest = (input) => createHash("sha256").update(input).digest("hex");

export const plans = [
  {
    file: "backend-assets/pc_platform/setting_screen_windowed_ratio_16_9.png",
    sourceSha256: "63687ea8697e1699c19c8b02c6b095949a0da672f1f292a9193bc2f74bda9757",
    width: 1280,
    height: 720,
    regions: [{ left: 76, top: 25, width: 181, height: 34, sigma: 16, category: "game-nickname" }],
  },
  {
    file: "backend-assets/auto_fight/cvat_ai_guide1.png",
    sourceSha256: "d62368a01839956743bdbd75a3791646396bd2a3779103705ff13bc3b6288f13",
    width: 2072,
    height: 736,
    regions: [
      { left: 486, top: 255, width: 195, height: 77, sigma: 20, category: "job-identifier" },
      { left: 993, top: 255, width: 195, height: 77, sigma: 20, category: "job-identifier" },
      { left: 1484, top: 255, width: 195, height: 77, sigma: 20, category: "job-identifier" },
      { left: 636, top: 535, width: 318, height: 85, sigma: 20, category: "shared-account" },
      { left: 1138, top: 535, width: 302, height: 85, sigma: 20, category: "shared-account" },
      { left: 1628, top: 535, width: 310, height: 85, sigma: 20, category: "shared-account" },
    ],
  },
];

export async function blurRegions(input, plan) {
  const before = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(before.info.width, plan.width, "Unexpected image width");
  assert.equal(before.info.height, plan.height, "Unexpected image height");
  const membership = new Int16Array(plan.width * plan.height).fill(-1);
  for (const [index, region] of plan.regions.entries()) {
    for (const key of ["left", "top", "width", "height"])
      assert.ok(Number.isInteger(region[key]), "Blur coordinates must be integers");
    assert.ok(region.left >= 0 && region.top >= 0 && region.width > 0 && region.height > 0);
    assert.ok(
      region.left + region.width <= plan.width && region.top + region.height <= plan.height
    );
    assert.ok(Number.isFinite(region.sigma) && region.sigma >= 12 && region.sigma <= 1000);
    for (let y = region.top; y < region.top + region.height; y++) {
      for (let x = region.left; x < region.left + region.width; x++) {
        const offset = y * plan.width + x;
        assert.equal(membership[offset], -1, "Blur regions must not overlap");
        membership[offset] = index;
      }
    }
  }

  const pixels = Buffer.from(before.data);
  for (const { left, top, width, height, sigma } of plan.regions) {
    const blurred = await sharp(before.data, {
      raw: { width: plan.width, height: plan.height, channels: 4 },
    })
      .extract({ left, top, width, height })
      .blur(sigma)
      .raw()
      .toBuffer();
    for (let row = 0; row < height; row++)
      blurred.copy(
        pixels,
        ((top + row) * plan.width + left) * 4,
        row * width * 4,
        (row + 1) * width * 4
      );
  }
  const output = await sharp(pixels, {
    raw: { width: plan.width, height: plan.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const after = await sharp(output).ensureAlpha().raw().toBuffer();
  assert.equal(after.length, before.data.length);
  const changedPixelsByRegion = plan.regions.map(() => 0);
  let outsideChangedPixels = 0;
  for (let pixel = 0; pixel < membership.length; pixel++) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel++)
      if (before.data[offset + channel] !== after[offset + channel]) changed = true;
    if (!changed) continue;
    const region = membership[pixel];
    if (region === -1) outsideChangedPixels++;
    else changedPixelsByRegion[region]++;
  }
  assert.equal(outsideChangedPixels, 0, "Pixels outside the blur regions changed");
  assert.ok(
    changedPixelsByRegion.every((count) => count > 0),
    "A blur region did not change"
  );
  return { output, changedPixelsByRegion, outsideChangedPixels };
}

async function main() {
  const previous = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : null;
  const prepared = [];
  for (const plan of plans) {
    const filename = path.join(publicRoot, plan.file);
    const input = readFileSync(filename);
    const current = digest(input);
    const recorded = previous?.files.find((file) => file.file === plan.file);
    if (recorded && current === recorded.sha256) {
      for (const key of ["file", "sourceSha256", "width", "height", "regions"])
        assert.deepEqual(
          recorded[key],
          plan[key],
          "The existing blur plan changed; review required"
        );
      prepared.push({ filename, record: recorded });
      continue;
    }
    assert.equal(current, plan.sourceSha256, "Unreviewed source image: " + plan.file);
    const result = await blurRegions(input, plan);
    prepared.push({
      filename,
      inputHash: current,
      output: result.output,
      record: {
        ...plan,
        sha256: digest(result.output),
        changedPixelsByRegion: result.changedPixelsByRegion,
        outsideChangedPixels: result.outsideChangedPixels,
        visualReview: null,
      },
    });
  }
  for (const item of prepared) {
    if (!item.output) continue;
    assert.equal(digest(readFileSync(item.filename)), item.inputHash, "Image changed during blur");
    writeFileSync(item.filename, item.output);
  }
  if (prepared.some((item) => item.output)) {
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          processedAt: new Date().toISOString(),
          method:
            "Local Gaussian blur of reviewed pixel rectangles; no generated image content, opaque masks or CSS-only redaction. Raw decoded RGBA pixels outside these regions are unchanged.",
          sharpVersion: sharp.versions.sharp,
          files: prepared.map((item) => item.record),
        },
        null,
        2
      ) + "\n"
    );
  }
  console.log(
    JSON.stringify({
      files: prepared.length,
      changed: prepared.filter((item) => item.output).length,
    })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
