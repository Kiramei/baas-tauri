import { expect, test } from "bun:test";
import sharp from "sharp";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { losslessWebp, visibleRgba, webpName } from "../scripts/convert-public-media.mjs";
import publication from "../evidence/webp-publication.json";

test("WebP names distinguish static posters and animations", () => {
  expect(webpName("preview.png")).toBe("preview.webp");
  expect(webpName("preview.gif")).toBe("preview.animated.webp");
});

test("lossless WebP retains visible alpha pixels and animation timing", async () => {
  const width = 16, height = 16;
  const pixels = Buffer.alloc(width * height * 2 * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = offset % 251;
    pixels[offset + 1] = Math.floor(offset / 1024) ? 200 : 50;
    pixels[offset + 2] = 90;
    pixels[offset + 3] = offset % 12 ? 255 : 0;
  }
  const input = await sharp(pixels, { raw: { width, height: height * 2, channels: 4, pageHeight: height } })
    .gif({ delay: [120, 300], loop: 2 }).toBuffer();
  const result = await losslessWebp(input);
  expect(result.frames).toBe(2);
  expect(result.delay).toEqual([120, 300]);
  expect(result.loop).toBe(2);
  expect(result.changedVisiblePixels).toBe(0);
  expect(visibleRgba(await sharp(result.output, { animated: true }).ensureAlpha().raw().toBuffer()))
    .toEqual(visibleRgba(await sharp(input, { animated: true }).ensureAlpha().raw().toBuffer()));
});

test("every published raster is hash-bound WebP with unchanged visible content", async () => {
  const directory = new URL("../public/", import.meta.url);
  const hash = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
  const inventory = readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(file => /\.(png|jpe?g|gif|webp)$/i.test(file)).map(file => file.replaceAll("\\", "/")).sort();
  expect(inventory.every(file => file.endsWith(".webp"))).toBe(true);
  expect(inventory).toEqual(publication.files.map(file => file.file).sort());
  expect(publication.converterSha256).toBe(hash(readFileSync(new URL("../scripts/convert-public-media.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n")));
  for (const file of publication.files) {
    const bytes = readFileSync(new URL(file.file, directory));
    expect(hash(bytes)).toBe(file.sha256);
    const metadata = await sharp(bytes, { animated: true }).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.pages ?? 1).toBe(file.frames);
    expect(metadata.delay ?? []).toEqual(file.delay);
    expect(metadata.loop ?? 0).toBe(file.loop);
    expect(metadata.width).toBe(file.width);
    expect(metadata.pageHeight ?? metadata.height).toBe(file.height);
    expect(hash(visibleRgba(await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer()))).toBe(file.visibleRgbaSha256);
    expect(file.changedVisiblePixels).toBe(0);
  }
}, 30000);

test("reader pages no longer reference legacy client images or old raster encodings", () => {
  const directory = new URL("../content/docs/", import.meta.url);
  for (const file of readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".mdx"))) {
    const content = readFileSync(new URL(file.replaceAll("\\", "/"), directory), "utf8");
    expect(content).not.toMatch(/src=["']\/(?:cn|en)\//);
    expect(content).not.toMatch(/src=["'][^"']*\.(?:png|jpe?g|gif)["']/i);
  }
});
