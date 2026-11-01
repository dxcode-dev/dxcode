import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { GifWriter } from "omggif";
import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_EDGE,
  IMAGE_MAX_SOURCE_BYTES,
  ImageRefused,
  prepareImage,
} from "./image.js";

/**
 * Failure modes this module guards against:
 * - a format the models cannot read (SVG, BMP, text) reaching the model;
 * - a truncated or corrupt file crashing the tool instead of refusing;
 * - a decompression bomb (tiny file, huge declared size) exhausting memory
 *   before any check runs;
 * - a file larger than the source cap being decoded at all;
 * - palette, 16-bit, grayscale, packed low-depth, and alpha PNGs decoding
 *   to the wrong colors;
 * - transparent pixels turning black instead of the page color;
 * - a large image reaching the model at full size instead of resized;
 * - a small image being re-encoded when it could pass through untouched.
 */

/** Left half red, right half blue. */
const halves = (width: number, height: number, channels: 3 | 4 = 3) => {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      const left = x < width / 2;
      data[at] = left ? 255 : 0;
      data[at + 2] = left ? 0 : 255;
      if (channels === 4) data[at + 3] = 255;
    }
  return data;
};

const png = (width: number, height: number) =>
  encodePng({ width, height, data: halves(width, height), channels: 3 });

const rgbAt = (
  image: { data: Uint8Array; mimeType: string },
  fx: number,
  fy: number,
) => {
  if (image.mimeType === "image/jpeg") {
    const decoded = jpeg.decode(image.data, { useTArray: true });
    const at =
      (Math.floor(fy * decoded.height) * decoded.width +
        Math.floor(fx * decoded.width)) *
      4;
    return [...decoded.data.subarray(at, at + 3)];
  }
  const decoded = decodePng(image.data);
  const at =
    (Math.floor(fy * decoded.height) * decoded.width +
      Math.floor(fx * decoded.width)) *
    decoded.channels;
  return [...decoded.data.subarray(at, at + 3)];
};

const near = (actual: number[], expected: number[]) =>
  actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 24);

describe("prepareImage", () => {
  it("passes a small image through byte for byte", async () => {
    const bytes = png(64, 32);
    const prepared = await prepareImage(bytes);
    expect(prepared.data).toBe(bytes);
    expect(prepared).toMatchObject({
      mimeType: "image/png",
      width: 64,
      height: 32,
      source: { format: "png", width: 64, height: 32 },
    });
  });

  it("resizes a large PNG to the edge limit and keeps its colors", async () => {
    const prepared = await prepareImage(png(3000, 1500));
    expect(prepared.width).toBe(IMAGE_MAX_EDGE);
    expect(prepared.height).toBe(1000);
    expect(prepared.source).toMatchObject({ width: 3000, height: 1500 });
    expect(near(rgbAt(prepared, 0.1, 0.5), [255, 0, 0])).toBe(true);
    expect(near(rgbAt(prepared, 0.9, 0.5), [0, 0, 255])).toBe(true);
  });

  it("resizes a large JPEG and returns a JPEG", async () => {
    const source = jpeg.encode(
      { width: 1600, height: 2400, data: halves(1600, 2400, 4) },
      90,
    ).data;
    const prepared = await prepareImage(new Uint8Array(source));
    expect(prepared.mimeType).toBe("image/jpeg");
    expect(prepared.height).toBe(IMAGE_MAX_EDGE);
    expect(prepared.width).toBe(1333);
    expect(near(rgbAt(prepared, 0.1, 0.5), [255, 0, 0])).toBe(true);
    expect(near(rgbAt(prepared, 0.9, 0.5), [0, 0, 255])).toBe(true);
  });

  it("resizes a large GIF from its first frame", async () => {
    const width = 2600;
    const height = 40;
    const buffer = new Uint8Array(width * height + 1024);
    const writer = new GifWriter(buffer, width, height, {
      palette: [0xff0000, 0x0000ff],
    });
    const indices = new Array<number>(width * height);
    for (let i = 0; i < indices.length; i++)
      indices[i] = i % width < width / 2 ? 0 : 1;
    writer.addFrame(0, 0, width, height, indices);
    const prepared = await prepareImage(buffer.subarray(0, writer.end()));
    expect(prepared.width).toBe(IMAGE_MAX_EDGE);
    expect(near(rgbAt(prepared, 0.1, 0.5), [255, 0, 0])).toBe(true);
    expect(near(rgbAt(prepared, 0.9, 0.5), [0, 0, 255])).toBe(true);
  });

  it("decodes palette, 16-bit, gray with alpha, and 1-bit PNGs", async () => {
    const width = 2200;
    const height = 8;
    const indexed = new Uint8Array(width * height);
    for (let i = 0; i < indexed.length; i++)
      indexed[i] = i % width < width / 2 ? 0 : 1;
    const palette = await prepareImage(
      encodePng({
        width,
        height,
        depth: 8,
        channels: 1,
        data: indexed,
        palette: [
          [255, 0, 0],
          [0, 0, 255],
        ],
      }),
    );
    expect(near(rgbAt(palette, 0.1, 0.5), [255, 0, 0])).toBe(true);
    expect(near(rgbAt(palette, 0.9, 0.5), [0, 0, 255])).toBe(true);

    const wide = new Uint16Array(width * height * 3);
    for (let i = 0; i < width * height; i++)
      wide[i * 3 + (i % width < width / 2 ? 0 : 2)] = 65535;
    const deep = await prepareImage(
      encodePng({ width, height, depth: 16, channels: 3, data: wide }),
    );
    expect(near(rgbAt(deep, 0.1, 0.5), [255, 0, 0])).toBe(true);
    expect(near(rgbAt(deep, 0.9, 0.5), [0, 0, 255])).toBe(true);

    // Gray 0 opaque on the left, fully transparent on the right: the page
    // color (white) shows through.
    const grayAlpha = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i++)
      grayAlpha[i * 2 + 1] = i % width < width / 2 ? 255 : 0;
    const transparent = await prepareImage(
      encodePng({ width, height, depth: 8, channels: 2, data: grayAlpha }),
    );
    expect(near(rgbAt(transparent, 0.1, 0.5), [0, 0, 0])).toBe(true);
    expect(near(rgbAt(transparent, 0.9, 0.5), [255, 255, 255])).toBe(true);

    const rowBytes = Math.ceil(width / 8);
    const bits = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++)
      bits.fill(0xff, y * rowBytes + rowBytes / 2, (y + 1) * rowBytes);
    const mono = await prepareImage(
      encodePng({ width, height, depth: 1, channels: 1, data: bits }),
    );
    expect(near(rgbAt(mono, 0.1, 0.5), [0, 0, 0])).toBe(true);
    expect(near(rgbAt(mono, 0.9, 0.5), [255, 255, 255])).toBe(true);
  });

  it("refuses a decompression bomb from its header, before decoding", async () => {
    const bytes = png(8, 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(16, 100_000);
    view.setUint32(20, 100_000);
    await expect(prepareImage(bytes)).rejects.toThrow(ImageRefused);
    await expect(prepareImage(bytes)).rejects.toThrow(/100000×100000/);
  });

  it("refuses formats the model cannot read and corrupt files", async () => {
    const encoder = new TextEncoder();
    await expect(
      prepareImage(encoder.encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
    ).rejects.toThrow(/PNG, JPEG, GIF, or WebP/);
    await expect(
      prepareImage(encoder.encode("BM not a bitmap")),
    ).rejects.toThrow(ImageRefused);
    const large = png(3000, 1500);
    await expect(prepareImage(large.subarray(0, 4000))).rejects.toThrow(
      ImageRefused,
    );
  });

  it("refuses a file over the source size limit without reading it", async () => {
    const bytes = new Uint8Array(IMAGE_MAX_SOURCE_BYTES + 1);
    bytes.set(png(8, 8));
    await expect(prepareImage(bytes)).rejects.toThrow(/MB/);
  });

  it("passes a small WebP through and refuses an oversized one", async () => {
    // A 1×1 lossless WebP.
    const tiny = Uint8Array.from(
      atob("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="),
      (c) => c.charCodeAt(0),
    );
    const prepared = await prepareImage(tiny);
    expect(prepared).toMatchObject({
      mimeType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(prepared.data).toBe(tiny);

    // VP8X header declaring 9000×9000.
    const huge = new Uint8Array(30);
    huge.set(new TextEncoder().encode("RIFF"), 0);
    huge.set(new TextEncoder().encode("WEBPVP8X"), 8);
    const view = new DataView(huge.buffer);
    view.setUint32(16, 10, true);
    const side = 9000 - 1;
    huge[24] = side & 0xff;
    huge[25] = (side >> 8) & 0xff;
    huge[27] = side & 0xff;
    huge[28] = (side >> 8) & 0xff;
    await expect(prepareImage(huge)).rejects.toThrow(/9000×9000/);
  });
});
