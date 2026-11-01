import { decode as decodePng, encode as encodePng } from "fast-png";
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
 * it shares. A PNG or GIF decode peaks near eight bytes a pixel, so a
 * 3024×1964 Retina screenshot fits; jpeg-js holds about ten.
 */
const MAX_DECODE_PIXELS: Record<ImageFormat, number> = {
  png: 6_300_000,
  gif: 6_300_000,
  jpeg: 4_200_000,
  webp: 0,
};
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

const jpegSize = (bytes: Uint8Array) => {
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
    const size = jpegSize(bytes);
    return size === undefined ? undefined : { format: "jpeg", ...size };
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

const decodePngRows = (bytes: Uint8Array): Decoded => {
  const image = decodePng(bytes);
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

const decodeRows = (format: ImageFormat, bytes: Uint8Array): Decoded => {
  if (format === "png") return decodePngRows(bytes);
  if (format === "jpeg") {
    const image = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_DECODE_PIXELS.jpeg / 1_000_000 + 1,
      maxMemoryUsageInMB: 96,
    });
    return rgbaRows(image.width, image.height, image.data);
  }
  const reader = new GifReader(bytes);
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return rgbaRows(reader.width, reader.height, data);
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
  if (width * height > MAX_DECODE_PIXELS[format]) {
    // Not decoded here; model providers downsize these themselves.
    if (longest <= MAX_UNDECODED_EDGE && bytes.length <= MAX_UNDECODED_BYTES)
      return unchanged();
    throw new ImageRefused(
      `The image is ${width}×${height} (${megabytes(bytes.length)}), too large to view. Save a copy at most ${IMAGE_MAX_EDGE} pixels on its longest side, for example with ffmpeg -i <in> -vf "scale='min(${IMAGE_MAX_EDGE},iw)':-2" <out>.png, or crop it, and view that.`,
    );
  }
  let decoded: Decoded;
  try {
    decoded = decodeRows(format, bytes);
  } catch (cause) {
    throw new ImageRefused(
      `The ${format} file could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}.`,
      { cause },
    );
  }
  const scale = Math.min(1, IMAGE_MAX_EDGE / longest);
  const targetWidth = Math.max(1, Math.round(decoded.width * scale));
  const targetHeight = Math.max(1, Math.round(decoded.height * scale));
  const rgb = resize(decoded, targetWidth, targetHeight);
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
