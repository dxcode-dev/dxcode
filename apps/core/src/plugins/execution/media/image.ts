import { decode as decodePng, encode as encodePng } from "fast-png";
import { Unzlib } from "fflate";
import jpeg from "jpeg-js";
import { GifReader } from "omggif";

/**
 * Prepares image bytes for a model: checks the format and size from the
 * header, passes a small image through untouched, and otherwise decodes,
 * downsizes, and re-encodes it. Decoding happens in the agent's isolate, so
 * a decoded image's size is bounded from its header before any decode runs.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** Longest edge sent to the model; larger images are downsized to it. */
export const IMAGE_MAX_EDGE = 2000;
/** Largest file read at all. */
export const IMAGE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** An image within the edge limit and this size is sent unchanged. */
const PASS_THROUGH_BYTES = 1024 * 1024;
/**
 * Most pixels decoded in the Durable Object's isolate, which every Thread on
 * it shares. WebP is never decoded here.
 */
const MAX_DECODE_PIXELS: Record<ImageFormat, number> = {
  png: 6_300_000,
  gif: 6_300_000,
  jpeg: 4_200_000,
  webp: 0,
};
/**
 * Most bytes one decode may hold in that isolate, whose limit is 128 MB. An
 * 8-bit RGBA 3024×1964 Retina screenshot needs about 50 MB.
 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
/**
 * Compressed bytes inflated before the output is counted. Deflate expands
 * at most 1032:1, so a slice yields about 4 MB at most.
 */
const INFLATE_SLICE_BYTES = 4096;
/** Largest image sent unchanged when it cannot be decoded here. */
const MAX_UNDECODED_BYTES = 3.75 * 1024 * 1024;
/** Largest edge model providers accept. */
const MAX_UNDECODED_EDGE = 8000;
/** A re-encoded PNG above this size is sent as JPEG instead. */
const MAX_PNG_OUTPUT_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 85;

const MIME_TYPES: Record<ImageFormat, PreparedImage["mimeType"]> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface PreparedImage {
  readonly data: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly source: {
    readonly format: ImageFormat;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
}

/** The image cannot be shown; the message says why and what to do. */
export class ImageRefused extends Error {
  override readonly name = "ImageRefused";
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const readU16BE = (bytes: Uint8Array, at: number) =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const readU16LE = (bytes: Uint8Array, at: number) =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const readU24LE = (bytes: Uint8Array, at: number) =>
  readU16LE(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const readU32BE = (bytes: Uint8Array, at: number) =>
  readU16BE(bytes, at) * 65536 + readU16BE(bytes, at + 2);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** The first frame header (SOF) of a JPEG, or undefined. */
const jpegFrame = (bytes: Uint8Array) => {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    const length = readU16BE(bytes, at + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return {
        height: readU16BE(bytes, at + 5),
        width: readU16BE(bytes, at + 7),
        // Horizontal and vertical sampling factor of each component.
        sampling: Array.from({ length: bytes[at + 9] ?? 0 }, (_, index) => {
          const factors = bytes[at + 11 + index * 3] ?? 0;
          return [Math.max(1, factors >> 4), Math.max(1, factors & 15)];
        }),
      };
    if (length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
};

/** The format and size an image's header declares, or undefined. */
export const imageInfo = (
  bytes: Uint8Array,
):
  | {
      readonly format: ImageFormat;
      readonly width: number;
      readonly height: number;
    }
  | undefined => {
  if (
    bytes.length >= 24 &&
    readU32BE(bytes, 0) === 0x89504e47 &&
    readU32BE(bytes, 4) === 0x0d0a1a0a &&
    ascii(bytes, 12, 4) === "IHDR"
  )
    return {
      format: "png",
      width: readU32BE(bytes, 16),
      height: readU32BE(bytes, 20),
    };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6)))
    return {
      format: "gif",
      width: readU16LE(bytes, 6),
      height: readU16LE(bytes, 8),
    };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const frame = jpegFrame(bytes);
    return frame === undefined
      ? undefined
      : { format: "jpeg", width: frame.width, height: frame.height };
  }
  if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8 ")
      return {
        format: "webp",
        width: readU16LE(bytes, 26) & 0x3fff,
        height: readU16LE(bytes, 28) & 0x3fff,
      };
    if (chunk === "VP8L") {
      const bits =
        (bytes[21] ?? 0) |
        ((bytes[22] ?? 0) << 8) |
        ((bytes[23] ?? 0) << 16) |
        ((bytes[24] ?? 0) << 24);
      return {
        format: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8X")
      return {
        format: "webp",
        width: readU24LE(bytes, 24) + 1,
        height: readU24LE(bytes, 27) + 1,
      };
  }
  return undefined;
};

export type MediaKind =
  | { readonly kind: "image"; readonly format: ImageFormat }
  | { readonly kind: "pdf" }
  | { readonly kind: "audio" | "video"; readonly format: string };

/** What a file is, from its first bytes, or undefined for anything else. */
export const sniffMedia = (bytes: Uint8Array): MediaKind | undefined => {
  const image = imageInfo(bytes);
  if (image !== undefined) return { kind: "image", format: image.format };
  const head = ascii(bytes, 0, 12);
  if (head.startsWith("%PDF-")) return { kind: "pdf" };
  if (
    head.startsWith("ID3") ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
  )
    return { kind: "audio", format: "mp3" };
  if (head.startsWith("RIFF") && ascii(bytes, 8, 4) === "WAVE")
    return { kind: "audio", format: "wav" };
  if (head.startsWith("fLaC")) return { kind: "audio", format: "flac" };
  if (head.startsWith("OggS")) return { kind: "audio", format: "ogg" };
  if (ascii(bytes, 4, 4) === "ftyp") return { kind: "video", format: "mp4" };
  if (readU32BE(bytes, 0) === 0x1a45dfa3)
    return { kind: "video", format: "webm" };
  return undefined;
};

/**
 * Writes one source row as RGB into `out`, alpha composited onto white:
 * a transparent screenshot area reads as the page it was taken from.
 */
type RowReader = (y: number, out: Uint8Array) => void;

interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly readRow: RowReader;
}

const onWhite = (value: number, alpha: number) =>
  (value * alpha + 255 * (255 - alpha) + 127) / 255;

const pngRows = (image: ReturnType<typeof decodePng>): Decoded => {
  const { width, height, depth, channels, data, palette } = image;
  const rowSamples = width * channels;
  const packedRowBytes = Math.ceil((rowSamples * depth) / 8);
  const sample = (y: number, index: number): number => {
    if (depth === 16) return (data[y * rowSamples + index] ?? 0) >> 8;
    if (depth === 8) return data[y * rowSamples + index] ?? 0;
    const bit = index * depth;
    const byte = data[y * packedRowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && palette === undefined ? 255 / (2 ** depth - 1) : 1;
  return {
    width,
    height,
    readRow: (y, out) => {
      for (let x = 0; x < width; x++) {
        let r: number;
        let g: number;
        let b: number;
        let a = 255;
        if (palette !== undefined) {
          const color = palette[sample(y, x)] ?? [0, 0, 0];
          r = color[0] ?? 0;
          g = color[1] ?? 0;
          b = color[2] ?? 0;
          a = color[3] ?? 255;
        } else if (channels <= 2) {
          r = g = b = sample(y, x * channels) * scale;
          if (channels === 2) a = sample(y, x * 2 + 1);
        } else {
          r = sample(y, x * channels);
          g = sample(y, x * channels + 1);
          b = sample(y, x * channels + 2);
          if (channels === 4) a = sample(y, x * 4 + 3);
        }
        out[x * 3] = onWhite(r, a);
        out[x * 3 + 1] = onWhite(g, a);
        out[x * 3 + 2] = onWhite(b, a);
      }
    },
  };
};

const rgbaRows = (
  width: number,
  height: number,
  data: Uint8Array,
): Decoded => ({
  width,
  height,
  readRow: (y, out) => {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = row + x * 4;
      const a = data[at + 3] ?? 255;
      out[x * 3] = onWhite(data[at] ?? 0, a);
      out[x * 3 + 1] = onWhite(data[at + 1] ?? 0, a);
      out[x * 3 + 2] = onWhite(data[at + 2] ?? 0, a);
    }
  },
});

/**
 * A decode that has not run yet, and the most bytes it will hold, estimated
 * from the headers. `decode` throws `ImageRefused` when the data turns out
 * larger than the headers declare.
 */
interface DecodePlan {
  readonly bytes: number;
  readonly decode: () => Decoded;
}

const notDecoded: DecodePlan = {
  bytes: Number.POSITIVE_INFINITY,
  decode: () => {
    throw new ImageRefused("This image format is not decoded here.");
  },
};

const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};
/** Each Adam7 pass's first column and row, and its column and row step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/**
 * Plans a PNG decode from its IHDR: the image data must inflate to exactly
 * the filtered rows the header declares. Only the chunks fast-png needs for
 * the pixels are kept, so it never inflates an ICC profile and never reads a
 * second IHDR.
 */
const planPng = (bytes: Uint8Array, width: number, height: number) => {
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  const imageData: Uint8Array[] = [];
  let header: Uint8Array | undefined;
  let keptBytes = 8;
  let compressed = 0;
  for (let at = 8; ; ) {
    const length = readU32BE(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    const end = at + 12 + length;
    if (end > bytes.length)
      throw new ImageRefused(
        "The PNG ends in the middle of a chunk; the file is truncated.",
      );
    const chunk = bytes.subarray(at, end);
    if (type === "IHDR") {
      if (at !== 8 || length !== 13)
        throw new ImageRefused("The PNG has a damaged or repeated header.");
      header = chunk.subarray(8, 21);
    } else if (type === "IDAT") {
      imageData.push(chunk.subarray(8, 8 + length));
      compressed += length;
    }
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)) {
      kept.push(chunk);
      keptBytes += chunk.length;
    }
    if (type === "IEND") break;
    at = end;
  }
  const depth = header?.[8] ?? 0;
  const channels = PNG_CHANNELS[header?.[9] ?? -1];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth))
    throw new ImageRefused(
      "The PNG header declares an unknown color type or bit depth.",
    );
  const bitsPerPixel = channels * depth;
  const interlaced = header?.[12] === 1;
  const rowsBytes = (columns: number, rows: number) =>
    columns > 0 && rows > 0
      ? rows * (1 + Math.ceil((columns * bitsPerPixel) / 8))
      : 0;
  const inflated = interlaced
    ? ADAM7.reduce(
        (sum, [x, y, dx, dy]) =>
          sum +
          rowsBytes(Math.ceil((width - x) / dx), Math.ceil((height - y) / dy)),
        0,
      )
    : rowsBytes(width, height);
  // fast-png unfilters interlaced images to a byte or two per sample.
  const pixels = interlaced
    ? width * height * channels * Math.ceil(depth / 8)
    : height * Math.ceil((width * bitsPerPixel) / 8);
  const tooLarge = () =>
    new ImageRefused(
      `The PNG's image data is larger than its ${width}×${height} header allows, so it was not decoded. The file is damaged or built to exhaust memory.`,
    );
  return {
    // The copy below, then fast-png's inflated chunks with their
    // concatenation, or that concatenation with the unfiltered pixels.
    bytes: keptBytes + Math.max(2 * inflated, inflated + pixels),
    decode: () => {
      // No sensible encoder grows data by more than an eighth (fixed-code
      // literals), so longer image data is not believed.
      if (compressed > inflated + Math.ceil(inflated / 8) + 1024)
        throw tooLarge();
      let total = 0;
      const inflater = new Unzlib((chunk) => {
        total += chunk.length;
      });
      for (const data of imageData)
        for (let at = 0; at < data.length; at += INFLATE_SLICE_BYTES) {
          inflater.push(data.subarray(at, at + INFLATE_SLICE_BYTES));
          if (total > inflated) throw tooLarge();
        }
      inflater.push(new Uint8Array(0), true);
      if (total > inflated) throw tooLarge();
      const copy = new Uint8Array(keptBytes);
      let offset = 0;
      for (const chunk of kept) {
        copy.set(chunk, offset);
        offset += chunk.length;
      }
      return pngRows(decodePng(copy));
    },
  };
};

/**
 * Plans a GIF decode from its first frame, which must lie inside the
 * logical screen. Parsing stops after that frame: omggif keeps an object for
 * every frame in a file.
 */
const planGif = (bytes: Uint8Array, width: number, height: number) => {
  const truncated = () =>
    new ImageRefused("The GIF ends before its first frame does.");
  const flags = bytes[10] ?? 0;
  let at = 13 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  const skipSubBlocks = () => {
    for (;;) {
      if (at >= bytes.length) throw truncated();
      const size = bytes[at++] ?? 0;
      if (size === 0) return;
      at += size;
    }
  };
  for (;;) {
    if (at >= bytes.length) throw truncated();
    const block = bytes[at++];
    if (block === 0x21) {
      at++;
      skipSubBlocks();
      continue;
    }
    if (block !== 0x2c) throw new ImageRefused("The GIF has no image.");
    const x = readU16LE(bytes, at);
    const y = readU16LE(bytes, at + 2);
    const frameWidth = readU16LE(bytes, at + 4);
    const frameHeight = readU16LE(bytes, at + 6);
    const local = bytes[at + 8] ?? 0;
    at += 9 + (local & 0x80 ? 3 << ((local & 7) + 1) : 0) + 1;
    skipSubBlocks();
    if (x + frameWidth > width || y + frameHeight > height)
      throw new ImageRefused(
        `The GIF's first frame (${frameWidth}×${frameHeight} at ${x},${y}) extends past its ${width}×${height} screen.`,
      );
    const end = at;
    return {
      // RGBA for the screen, and one palette index for each frame pixel.
      bytes: width * height * 4 + frameWidth * frameHeight,
      decode: () => {
        const reader = new GifReader(bytes.subarray(0, end));
        const data = new Uint8Array(width * height * 4);
        reader.decodeAndBlitFrameRGBA(0, data);
        return rgbaRows(width, height, data);
      },
    };
  }
};

/**
 * Plans a JPEG decode from its first frame header. jpeg-js counts what it
 * allocates and gets exactly the allowance that frame needs, so a second
 * frame or anything else undeclared fails before it is allocated.
 */
const planJpeg = (bytes: Uint8Array) => {
  const frame = jpegFrame(bytes);
  if (frame === undefined) return notDecoded;
  const { width, height, sampling } = frame;
  const maxH = Math.max(1, ...sampling.map(([h]) => h ?? 1));
  const maxV = Math.max(1, ...sampling.map(([, v]) => v ?? 1));
  const blocks = sampling.reduce(
    (sum, [h = 1, v = 1]) =>
      sum + Math.ceil(width / 8 / maxH) * h * Math.ceil(height / 8 / maxV) * v,
    0,
  );
  // jpeg-js counts each 8×8 block as its 256-byte Int32Array and 64
  // samples, then a byte a pixel for each component and four for RGBA.
  const counted =
    blocks * 320 + width * height * (sampling.length + 4) + 64 * 1024;
  return {
    // A block's Int32Array holds about 450 bytes with its objects, and
    // jpeg-js copies the file.
    bytes: counted + blocks * 256 + bytes.length,
    decode: () => {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_DECODE_PIXELS.jpeg / 1_000_000 + 1,
        maxMemoryUsageInMB: Math.ceil(counted / 1024 / 1024) + 1,
      });
      return rgbaRows(image.width, image.height, image.data);
    },
  };
};

const planDecode = (
  format: ImageFormat,
  bytes: Uint8Array,
  width: number,
  height: number,
): DecodePlan => {
  if (format === "png") return planPng(bytes, width, height);
  if (format === "gif") return planGif(bytes, width, height);
  if (format === "jpeg") return planJpeg(bytes);
  return notDecoded;
};

/** Source spans and weights for each output index along one axis. */
const spans = (source: number, target: number) => {
  const ratio = source / target;
  return Array.from({ length: target }, (_, index) => {
    const start = index * ratio;
    const end = start + ratio;
    const first = Math.floor(start);
    const weights: number[] = [];
    for (let at = first; at < Math.min(source, Math.ceil(end)); at++)
      weights.push((Math.min(end, at + 1) - Math.max(start, at)) / ratio);
    return { first, weights };
  });
};

/**
 * Area-average downsizing to RGB. Source rows are read once, in order, so
 * only one source row is held beyond the decoded image.
 */
const resize = (image: Decoded, width: number, height: number) => {
  const output = new Uint8Array(width * height * 3);
  const columns = spans(image.width, width);
  const rows = spans(image.height, height);
  const sourceRow = new Uint8Array(image.width * 3);
  const accumulated = new Float32Array(image.width * 3);
  let lastRead = -1;
  for (let y = 0; y < height; y++) {
    const { first, weights } = rows[y] ?? { first: 0, weights: [] };
    accumulated.fill(0);
    for (let index = 0; index < weights.length; index++) {
      const sourceY = first + index;
      // Neighbouring output rows can share an edge source row.
      if (sourceY !== lastRead) {
        image.readRow(sourceY, sourceRow);
        lastRead = sourceY;
      }
      const weight = weights[index] ?? 0;
      for (let i = 0; i < sourceRow.length; i++)
        accumulated[i] = (accumulated[i] ?? 0) + (sourceRow[i] ?? 0) * weight;
    }
    for (let x = 0; x < width; x++) {
      const column = columns[x] ?? { first: 0, weights: [] };
      let r = 0;
      let g = 0;
      let b = 0;
      for (let index = 0; index < column.weights.length; index++) {
        const at = (column.first + index) * 3;
        const weight = column.weights[index] ?? 0;
        r += (accumulated[at] ?? 0) * weight;
        g += (accumulated[at + 1] ?? 0) * weight;
        b += (accumulated[at + 2] ?? 0) * weight;
      }
      const at = (y * width + x) * 3;
      output[at] = Math.round(r);
      output[at + 1] = Math.round(g);
      output[at + 2] = Math.round(b);
    }
  }
  return output;
};

const encodeJpeg = (rgb: Uint8Array, width: number, height: number) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i] ?? 0;
    rgba[j + 1] = rgb[i + 1] ?? 0;
    rgba[j + 2] = rgb[i + 2] ?? 0;
    rgba[j + 3] = 255;
  }
  const encoded = jpeg.encode({ data: rgba, width, height }, JPEG_QUALITY).data;
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
};

/**
 * The image as the model should receive it. Throws `ImageRefused` for a
 * format the models cannot read, a corrupt file, or one too large to send.
 */
export const prepareImage = async (
  bytes: Uint8Array,
  resolution: "high" | "original" = "high",
): Promise<PreparedImage> => {
  if (bytes.length > IMAGE_MAX_SOURCE_BYTES)
    throw new ImageRefused(
      `The file is ${megabytes(bytes.length)}; images over ${megabytes(IMAGE_MAX_SOURCE_BYTES)} are not read. Save a smaller copy and view that.`,
    );
  const info = imageInfo(bytes);
  if (info === undefined)
    throw new ImageRefused(
      "This is not a PNG, JPEG, GIF, or WebP image, or its header is damaged. Convert it to PNG first, for example with ffmpeg.",
    );
  const { format, width, height } = info;
  if (width === 0 || height === 0)
    throw new ImageRefused(`The ${format} header declares an empty image.`);
  const source = { format, width, height, bytes: bytes.length };
  const longest = Math.max(width, height);
  const unchanged = (): PreparedImage => ({
    data: bytes,
    mimeType: MIME_TYPES[format],
    width,
    height,
    source,
  });
  if (resolution === "original") {
    if (longest <= MAX_UNDECODED_EDGE && bytes.length <= MAX_UNDECODED_BYTES)
      return unchanged();
    throw new ImageRefused(
      `The image is ${width}×${height} (${megabytes(bytes.length)}), larger than models accept unchanged (${MAX_UNDECODED_EDGE} pixels, ${megabytes(MAX_UNDECODED_BYTES)}). Use resolution high to downsize it.`,
    );
  }
  if (longest <= IMAGE_MAX_EDGE && bytes.length <= PASS_THROUGH_BYTES)
    return unchanged();
  const plan =
    width * height > MAX_DECODE_PIXELS[format]
      ? notDecoded
      : planDecode(format, bytes, width, height);
  if (plan.bytes > MAX_DECODE_BYTES) {
    // Not decoded here; model providers downsize these themselves.
    if (longest <= MAX_UNDECODED_EDGE && bytes.length <= MAX_UNDECODED_BYTES)
      return unchanged();
    throw new ImageRefused(
      `The image is ${width}×${height} (${megabytes(bytes.length)}), too large to view. Save a copy at most ${IMAGE_MAX_EDGE} pixels on its longest side, for example with ffmpeg -i <in> -vf "scale='min(${IMAGE_MAX_EDGE},iw)':-2" <out>.png, or crop it, and view that.`,
    );
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / longest);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  // The decoded pixels are unreachable once this returns, so encoding does
  // not hold them too.
  const downsized = () => {
    let decoded: Decoded;
    try {
      decoded = plan.decode();
    } catch (cause) {
      if (cause instanceof ImageRefused) throw cause;
      throw new ImageRefused(
        `The ${format} file could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}.`,
        { cause },
      );
    }
    if (decoded.width !== width || decoded.height !== height)
      throw new ImageRefused(
        `The ${format} file decodes to ${decoded.width}×${decoded.height}, not the ${width}×${height} its header declares.`,
      );
    return resize(decoded, targetWidth, targetHeight);
  };
  const rgb = downsized();
  if (format !== "jpeg") {
    const encoded = encodePng({
      width: targetWidth,
      height: targetHeight,
      data: rgb,
      channels: 3,
      depth: 8,
    });
    if (encoded.length <= MAX_PNG_OUTPUT_BYTES)
      return {
        data: encoded,
        mimeType: "image/png",
        width: targetWidth,
        height: targetHeight,
        source,
      };
  }
  return {
    data: encodeJpeg(rgb, targetWidth, targetHeight),
    mimeType: "image/jpeg",
    width: targetWidth,
    height: targetHeight,
    source,
  };
};
