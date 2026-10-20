import { expect, test } from "bun:test";
import sharp from "sharp";
import { blurRegions } from "../scripts/blur-private-media.mjs";

const width = 96;
const height = 80;
const plan = {
  width,
  height,
  regions: [
    { left: 5, top: 7, width: 30, height: 25, sigma: 12 },
    { left: 56, top: 44, width: 34, height: 28, sigma: 16 },
  ],
};
async function fixture() {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 71) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

test("Gaussian blur changes both regions and preserves every other decoded pixel", async () => {
  const input = await fixture();
  const { output, changedPixelsByRegion, outsideChangedPixels } = await blurRegions(input, plan);
  expect(outsideChangedPixels).toBe(0);
  expect(changedPixelsByRegion.every((count: number) => count > 0)).toBe(true);
  const before = await sharp(input).raw().toBuffer();
  const after = await sharp(output).removeAlpha().raw().toBuffer();
  expect(await sharp(output).metadata()).toMatchObject({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = plan.regions.some(
        (region) =>
          x >= region.left &&
          x < region.left + region.width &&
          y >= region.top &&
          y < region.top + region.height
      );
      if (inside) continue;
      const offset = (y * width + x) * 3;
      expect(after.subarray(offset, offset + 3).equals(before.subarray(offset, offset + 3))).toBe(
        true
      );
    }
  }
});

test("blur rejects changed dimensions, weak filters and invalid or overlapping regions", async () => {
  const input = await fixture();
  await expect(blurRegions(input, { ...plan, width: width + 1 })).rejects.toThrow("width");
  for (const region of [
    { ...plan.regions[0], sigma: 2 },
    { ...plan.regions[0], left: -1 },
    { ...plan.regions[0], width: 100 },
    { ...plan.regions[0], top: 0.5 },
  ])
    await expect(blurRegions(input, { ...plan, regions: [region] })).rejects.toThrow();
  await expect(
    blurRegions(input, { ...plan, regions: [plan.regions[0], plan.regions[0]] })
  ).rejects.toThrow("overlap");
});
