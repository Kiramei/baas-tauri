import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(root, "docs/public");
const reportFile = path.join(root, "docs/evidence/webp-publication.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const raster = /\.(png|jpe?g|gif|webp)$/i;
const sourceRaster = /\.(png|jpe?g|gif)$/i;
const normalized = filename => filename.replaceAll("\\", "/");

export function webpName(filename) {
  return filename.replace(/\.(png|jpe?g|gif)$/i, extension =>
    extension.toLowerCase() === ".gif" ? ".animated.webp" : ".webp");
}

export function visibleRgba(pixels) {
  const normalized = Buffer.from(pixels);
  for (let offset = 0; offset < normalized.length; offset += 4)
    if (normalized[offset + 3] === 0) normalized.fill(0, offset, offset + 3);
  return normalized;
}

export async function losslessWebp(input) {
  const before = await sharp(input, { animated: true }).metadata();
  const output = await sharp(input, { animated: true }).webp({ lossless: true, effort: 4 }).toBuffer();
  const after = await sharp(output, { animated: true }).metadata();
  assert.equal(after.format, "webp");
  for (const field of ["width", "height"]) assert.equal(after[field], before[field], field);
  assert.equal(after.pages ?? 1, before.pages ?? 1, "Animation frame count changed");
  assert.deepEqual(after.delay ?? [], before.delay ?? [], "Animation timing changed");
  assert.equal(after.loop ?? 0, before.loop ?? 0, "Animation loop count changed");
  const originalPixels = await sharp(input, { animated: true }).ensureAlpha().raw().toBuffer();
  const publishedPixels = await sharp(output, { animated: true }).ensureAlpha().raw().toBuffer();
  assert.equal(publishedPixels.length, originalPixels.length);
  assert.ok(visibleRgba(publishedPixels).equals(visibleRgba(originalPixels)), "Lossless publication changed visible RGBA pixels");
  let changedFullyTransparentRgbPixels = 0;
  for (let offset = 0; offset < originalPixels.length; offset += 4)
    if (!publishedPixels.subarray(offset, offset + 4).equals(originalPixels.subarray(offset, offset + 4))) {
      assert.equal(originalPixels[offset + 3], 0);
      assert.equal(publishedPixels[offset + 3], 0);
      changedFullyTransparentRgbPixels++;
    }
  return { output, width: after.width, height: after.pageHeight ?? after.height,
    frames: after.pages ?? 1, delay: after.delay ?? [], loop: after.loop ?? 0,
    visibleRgbaSha256: hash(visibleRgba(publishedPixels)), changedVisiblePixels: 0, changedFullyTransparentRgbPixels };
}

function publicFile(relative) {
  const filename = path.resolve(publicRoot, relative);
  assert.ok(filename.startsWith(publicRoot + path.sep), "Asset escaped public root");
  return filename;
}

async function verify() {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(report.converterSha256, hash(readFileSync(fileURLToPath(import.meta.url), "utf8").replaceAll("\r\n", "\n")));
  const inventory = readdirSync(publicRoot, { recursive: true }).map(normalized).filter(file => raster.test(file)).sort();
  assert.deepEqual(inventory, report.files.map(file => file.file).sort());
  assert.ok(inventory.every(file => file.endsWith(".webp")));
  for (const file of report.files) {
    const bytes = readFileSync(publicFile(file.file));
    assert.equal(hash(bytes), file.sha256, file.file);
    const metadata = await sharp(bytes, { animated: true }).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, file.width);
    assert.equal(metadata.pageHeight ?? metadata.height, file.height);
    assert.equal(metadata.pages ?? 1, file.frames);
    assert.deepEqual(metadata.delay ?? [], file.delay);
    assert.equal(metadata.loop ?? 0, file.loop);
    assert.equal(hash(visibleRgba(await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer())), file.visibleRgbaSha256);
    assert.equal(file.changedVisiblePixels, 0);
    assert.equal(existsSync(publicFile(file.sourceFile)), false, "Original encoding still published");
  }
  console.log(JSON.stringify({ files: report.files.length, frames: report.files.reduce((sum, file) => sum + file.frames, 0), verified: true }));
}

async function convert() {
  assert.equal(existsSync(reportFile), false, "A publication already exists; verify it or review a new migration separately");
  const originals = readdirSync(publicRoot, { recursive: true }).map(normalized).filter(file => sourceRaster.test(file)).sort();
  assert.ok(originals.length > 0);
  const destinations = originals.map(webpName);
  assert.equal(new Set(destinations).size, destinations.length, "WebP filename collision");
  const cache = path.join(root, ".cache/webp-publication");
  mkdirSync(cache, { recursive: true });
  const files = [];
  for (const sourceFile of originals) {
    const filename = publicFile(sourceFile), file = webpName(sourceFile), destination = publicFile(file);
    assert.equal(existsSync(destination), false, "Refusing to overwrite an existing WebP");
    const input = readFileSync(filename), converted = await losslessWebp(input);
    const backup = path.join(cache, sourceFile);
    mkdirSync(path.dirname(backup), { recursive: true });
    copyFileSync(filename, backup);
    writeFileSync(destination, converted.output);
    const { output, ...proof } = converted;
    files.push({ file, sourceFile, sourceSha256: hash(input), sha256: hash(output), sourceBytes: input.length, bytes: output.length, ...proof });
    if (files.length % 25 === 0) console.log(`Converted ${files.length}/${originals.length}`);
  }
  const report = { convertedAt: new Date().toISOString(), sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
    method: "Lossless local WebP encoding of already reviewed/blurred assets; visible decoded RGBA pixels, frame counts, delays and loop counts verified unchanged. Hidden RGB under zero alpha is canonicalized only for comparison and changes are counted separately. This is a publication transform, not a new capture or benchmark run.",
    converterSha256: hash(readFileSync(fileURLToPath(import.meta.url), "utf8").replaceAll("\r\n", "\n")), sharpVersion: sharp.versions.sharp, files };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  for (const file of files) {
    assert.equal(hash(readFileSync(publicFile(file.sourceFile))), file.sourceSha256, "Source changed during conversion");
    unlinkSync(publicFile(file.sourceFile));
  }
  console.log(JSON.stringify({ files: files.length, sourceBytes: files.reduce((sum, file) => sum + file.sourceBytes, 0), bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--convert")) await convert();
  else await verify();
}
