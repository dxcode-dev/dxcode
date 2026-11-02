import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { GifWriter } from "omggif";
import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_EDGE,
  prepareImage,
} from "../../src/plugins/execution/media/image.js";

/**
 * view_media decodes images in the agent Durable Object's isolate, which
 * every Thread on it shares and which resets past 128 MB (#1473). These run
 * in workerd, which exposes no heap measurement, so each bomb asserts the
 * refusal that comes before the large allocation: the counted inflate, the
 * frame check, or the header estimate. Peak memory per case is measured in
 * Node by internal/security-probes/2026-11-02/view-media-decode-bomb.mjs.
 *
 * Failure modes:
 * - an IDAT that inflates far past the rows its IHDR declares (the probe's
 *   1.3 MB PNG used 433 MB), padded past the pass-through size or behind a
 *   small header past the edge limit;
 * - an ICC profile or a second IHDR, which fast-png inflates or obeys;
 * - a header within the pixel limit whose decode still needs more than the
 *   isolate has (16-bit RGBA, or a 4:4:4 JPEG in jpeg-js);
 * - a GIF frame larger than its screen, sizing omggif's index buffer;
 * - the bounds refusing an ordinary Retina screenshot.
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

const rgbAt = (
  image: { data: Uint8Array; mimeType: string },
  fx: number,
  fy: number,
) => {
  const decoded =
    image.mimeType === "image/jpeg"
      ? { ...jpeg.decode(image.data, { useTArray: true }), channels: 4 }
      : decodePng(image.data);
  const at =
    (Math.floor(fy * decoded.height) * decoded.width +
      Math.floor(fx * decoded.width)) *
    decoded.channels;
  return [...decoded.data.subarray(at, at + 3)];
};

const near = (actual: number[], expected: number[]) =>
  actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 24);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const pngChunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length))
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
};

/** A PNG with this header, the given chunks, and IEND. */
const pngFile = (
  width: number,
  height: number,
  depth: number,
  colorType: number,
  chunks: Uint8Array[],
) => {
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([depth, colorType], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...chunks,
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A tEXt payload of `size` bytes, to push a file past the pass-through size. */
const textPad = (size: number) => {
  const out = new Uint8Array(size).fill(0x61);
  out.set([0x70, 0x61, 0x64, 0]);
  return out;
};

/** A zlib stream of `size` zero bytes, about a thousandth of that long. */
const zlibOfZeros = async (size: number) => {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const zeros = new Uint8Array(1024 * 1024);
  const written = (async () => {
    for (let left = size; left > 0; left -= zeros.length)
      await writer.write(zeros.subarray(0, Math.min(left, zeros.length)));
    await writer.close();
  })();
  const output = new Uint8Array(
    await new Response(stream.readable).arrayBuffer(),
  );
  await written;
  return output;
};

describe("view_media image decoding bounds (#1473)", () => {
  it("refuses the #1473 probe PNGs before their image data inflates", async () => {
    // 1000×1000 RGB declares 3 MB of rows; the IDAT inflates to 50 or 200 MB.
    for (const inflated of [50, 200]) {
      const bytes = pngFile(1000, 1000, 8, 2, [
        pngChunk("tEXt", textPad(1_100_000)),
        pngChunk("IDAT", await zlibOfZeros(inflated * 1024 * 1024)),
      ]);
      expect(bytes.length).toBeGreaterThan(1024 * 1024);
      await expect(prepareImage(bytes)).rejects.toThrow(
        /image data is larger than its 1000×1000 header allows/,
      );
    }
  });

  it("refuses an IDAT bomb behind a small valid header", async () => {
    // 2001×1 is past the edge limit, so it is decoded, not passed through.
    const bytes = pngFile(2001, 1, 8, 6, [
      pngChunk("IDAT", await zlibOfZeros(256 * 1024 * 1024)),
    ]);
    expect(bytes.length).toBeLessThan(1024 * 1024);
    await expect(prepareImage(bytes)).rejects.toThrow(
      /image data is larger than its 2001×1 header allows/,
    );
  });

  it("inflates only the image data of a PNG and reads only its first header", async () => {
    const image = encodePng({
      width: 2400,
      height: 1200,
      data: halves(2400, 1200),
      channels: 3,
    });
    const profile = new Uint8Array([
      ...new TextEncoder().encode("bomb"),
      0,
      0,
      ...(await zlibOfZeros(256 * 1024 * 1024)),
    ]);
    const withProfile = new Uint8Array([
      ...image.subarray(0, 33),
      ...pngChunk("iCCP", profile),
      ...image.subarray(33),
    ]);
    const prepared = await prepareImage(withProfile);
    expect(prepared.width).toBe(IMAGE_MAX_EDGE);
    expect(near(rgbAt(prepared, 0.9, 0.5), [0, 0, 255])).toBe(true);

    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, 60_000);
    new DataView(header.buffer).setUint32(4, 60_000);
    header.set([8, 6], 8);
    const repeated = new Uint8Array([
      ...image.subarray(0, 33),
      ...pngChunk("IHDR", header),
      ...image.subarray(33),
    ]);
    await expect(prepareImage(repeated)).rejects.toThrow(/repeated header/);
  });

  it("does not decode an image whose header needs more memory than the isolate allows", async () => {
    // 16-bit RGBA at 3000×2000 is under the pixel limit but needs 96 MB of
    // rows twice over; it is small, so it goes to the model unchanged.
    const deep = pngFile(3000, 2000, 16, 6, [
      pngChunk("IDAT", await zlibOfZeros(2000 * (1 + 3000 * 8))),
    ]);
    const prepared = await prepareImage(deep);
    expect(prepared.data).toBe(deep);
    expect(prepared).toMatchObject({ width: 3000, height: 2000 });

    // jpeg-js would hold over 100 MB for this 4:4:4 JPEG.
    const photo = new Uint8Array(
      jpeg.encode(
        { width: 1600, height: 2400, data: halves(1600, 2400, 4) },
        90,
      ).data,
    );
    expect((await prepareImage(photo)).data).toBe(photo);
  });

  it("refuses a GIF whose first frame is larger than its screen", async () => {
    const buffer = new Uint8Array(4096);
    const writer = new GifWriter(buffer, 2001, 1, { palette: [0, 0xffffff] });
    writer.addFrame(0, 0, 2001, 1, new Array<number>(2001).fill(0));
    const bytes = buffer.slice(0, writer.end());
    // Frame 0 now declares 65535×65535: a 4 GB index buffer in omggif.
    const descriptor = bytes.indexOf(0x2c, 13);
    bytes.set([0xff, 0xff, 0xff, 0xff], descriptor + 5);
    await expect(prepareImage(bytes)).rejects.toThrow(
      /first frame \(65535×65535 at 0,0\) extends past its 2001×1 screen/,
    );
  });

  it("still decodes a full-size Retina screenshot", async () => {
    // 3024×1964 RGBA with text-like noise on the left and a transparent
    // right half, which reads as white.
    const width = 3024;
    const height = 1964;
    const data = new Uint8Array(width * height * 4);
    let seed = 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width / 2; x++) {
        const at = (y * width + x) * 4;
        seed = (seed * 1_103_515_245 + 12_345) >>> 0;
        const ink = (seed >>> 24) % 4 === 0 ? 0 : 230;
        data[at] = ink;
        data[at + 1] = ink;
        data[at + 2] = 255;
        data[at + 3] = 255;
      }
    const bytes = encodePng({ width, height, data, channels: 4 });
    const prepared = await prepareImage(bytes);
    expect(prepared.source).toMatchObject({ width, height });
    expect(prepared.width).toBe(IMAGE_MAX_EDGE);
    expect(prepared.height).toBe(1299);
    expect(rgbAt(prepared, 0.25, 0.5)[2]).toBeGreaterThan(230);
    expect(near(rgbAt(prepared, 0.9, 0.5), [255, 255, 255])).toBe(true);
  });
});
