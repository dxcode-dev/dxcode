import type { Sandbox } from "@flue/runtime";
import {
  IMAGE_MAX_EDGE,
  type ImageFormat,
  ImageRefused,
  imageInfo,
  MAX_UNDECODED_BYTES,
  type PreparedImage,
} from "./image.js";

/**
 * Downsizes an image the isolate refuses, in the Thread's Orb with ffmpeg,
 * so the isolate only ever holds the small result. The image is untrusted
 * in the Orb too: the input is copied with a size bound, ffmpeg gets one
 * demuxer for the format, no protocol but local files, a pixel cap, an
 * address-space and CPU limit, and a wall-clock timeout, and the working
 * directory is removed afterwards.
 */

/** Largest file the Orb downsizes. */
export const ORB_IMAGE_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Most pixels the Orb decodes, from the header; about 10000×10000. */
export const ORB_IMAGE_MAX_PIXELS = 100_000_000;
/** Wall-clock limit on the ffmpeg run. */
export const ORB_IMAGE_TIMEOUT_SECONDS = 20;
/** Bytes read from the start of a file too large for the isolate. */
export const ORB_IMAGE_HEAD_BYTES = 512 * 1024;
/**
 * ffmpeg's address space. A 100-megapixel 4:4:4 JPEG peaks at about
 * 450 MB resident with two malloc arenas.
 */
const ADDRESS_SPACE_BYTES = 1024 * 1024 * 1024;
/** ffmpeg pads frames to its alignment, so its own cap sits a little above. */
const FFMPEG_MAX_PIXELS = Math.ceil(ORB_IMAGE_MAX_PIXELS * 1.1);
const DEMUXERS: Record<ImageFormat, string> = {
  png: "png_pipe",
  jpeg: "jpeg_pipe",
  gif: "gif",
  webp: "webp_pipe",
};
/**
 * Fit within the edge limit, keeping the aspect ratio (after any EXIF
 * rotation ffmpeg applies), and composite transparency onto white as the
 * isolate does.
 */
const FILTER = `[0:v]scale=w=${IMAGE_MAX_EDGE}:h=${IMAGE_MAX_EDGE}:force_original_aspect_ratio=decrease:flags=area,format=rgba,split[a][b];[a]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:replace=1[bg];[bg][b]overlay=format=auto,format=yuvj420p`;
/** The Orb cannot downsize: no ffmpeg, timeout, or prlimit, or no /tmp. */
const UNAVAILABLE = 90;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export interface OrbImageSource {
  /** A file in the Orb, or bytes to write there first. */
  readonly input: { readonly path: string } | { readonly bytes: Uint8Array };
  readonly image: PreparedImage["source"];
}

/**
 * A workspace file's size, for an Orb whose `stat` does not report one
 * (a Cloudflare container's), or undefined.
 */
export const readOrbFileSize = async (
  sandbox: Sandbox,
  path: string,
): Promise<number | undefined> => {
  try {
    const result = await sandbox.exec(`wc -c < ${quote(path)}`, {
      timeoutMs: 30_000,
    });
    const size = Number(result.stdout.trim());
    return result.exitCode === 0 &&
      result.stdout.trim() !== "" &&
      Number.isSafeInteger(size)
      ? size
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The first bytes of a workspace file, enough for its image header, without
 * reading the rest into the isolate.
 */
export const readOrbFileHead = async (
  sandbox: Sandbox,
  path: string,
): Promise<Uint8Array | undefined> => {
  const target = `/tmp/dx-view-media-head-${crypto.randomUUID()}`;
  try {
    const result = await sandbox.exec(
      `umask 077 && head -c ${ORB_IMAGE_HEAD_BYTES} -- ${quote(path)} > ${quote(target)}`,
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) return undefined;
    return await sandbox.readFileBuffer(target);
  } catch {
    return undefined;
  } finally {
    await sandbox.exec(`rm -f -- ${quote(target)}`).catch(() => undefined);
  }
};

/**
 * The image downsized in the Orb, or undefined when the Orb cannot do it
 * (none is running, or it lacks ffmpeg), so the caller keeps its refusal.
 * Throws `ImageRefused` when the image fails there: too many pixels, too
 * large, a decode error, or a decode that ran out of time or memory.
 */
export const downscaleInOrb = async (
  sandbox: Sandbox,
  source: OrbImageSource,
  signal?: AbortSignal,
): Promise<PreparedImage | undefined> => {
  const { image } = source;
  if (image.width * image.height > ORB_IMAGE_MAX_PIXELS)
    throw new ImageRefused(
      `The image is ${image.width}×${image.height}, more than the ${ORB_IMAGE_MAX_PIXELS / 1_000_000} megapixels dx downsizes. Crop it or save a smaller copy, and view that.`,
    );
  if (image.bytes > ORB_IMAGE_MAX_SOURCE_BYTES)
    throw new ImageRefused(
      `The file is ${megabytes(image.bytes)}; dx downsizes images up to ${megabytes(ORB_IMAGE_MAX_SOURCE_BYTES)}. Save a smaller copy and view that.`,
    );
  const dir = `/tmp/dx-view-media-${crypto.randomUUID()}`;
  const options = (timeoutMs: number) =>
    signal === undefined ? { timeoutMs } : { timeoutMs, signal };
  let created = false;
  try {
    try {
      const prepared = await sandbox.exec(
        `command -v ffmpeg >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 && command -v prlimit >/dev/null 2>&1 || exit ${UNAVAILABLE}; mkdir -m 700 -- ${quote(dir)} || exit ${UNAVAILABLE}`,
        options(30_000),
      );
      created = prepared.exitCode === 0;
      if (!created) return undefined;
    } catch {
      return undefined;
    }
    let from: string;
    if ("path" in source.input) from = source.input.path;
    else {
      from = `${dir}/source`;
      try {
        await sandbox.writeFile(from, source.input.bytes);
      } catch {
        return undefined;
      }
    }
    const input = `${dir}/in`;
    const output = `${dir}/out.jpg`;
    const log = `${dir}/log`;
    const ffmpeg = [
      "MALLOC_ARENA_MAX=2",
      `timeout -k 2 ${ORB_IMAGE_TIMEOUT_SECONDS}`,
      `prlimit --as=${ADDRESS_SPACE_BYTES} --cpu=${ORB_IMAGE_TIMEOUT_SECONDS * 2} --fsize=${2 * MAX_UNDECODED_BYTES} --core=0`,
      "nice -n 10 ffmpeg -nostdin -hide_banner -loglevel error",
      "-threads 1 -filter_threads 1 -protocol_whitelist file",
      `-max_pixels ${FFMPEG_MAX_PIXELS} -f ${DEMUXERS[image.format]}`,
      `-i ${quote(`file:${input}`)} -frames:v 1 -filter_complex ${quote(FILTER)}`,
      `-c:v mjpeg -q:v 3 -f image2 -update 1 ${quote(`file:${output}`)}`,
      `2> ${quote(log)}`,
    ].join(" ");
    const started = Date.now();
    const run = await sandbox.exec(
      [
        `head -c ${ORB_IMAGE_MAX_SOURCE_BYTES + 1} -- ${quote(from)} > ${quote(input)} || exit 91`,
        `[ "$(wc -c < ${quote(input)})" -le ${ORB_IMAGE_MAX_SOURCE_BYTES} ] || exit 92`,
        ffmpeg,
        `status=$?; [ "$status" -eq 0 ] || tail -c 300 ${quote(log)}; exit "$status"`,
      ].join("\n"),
      options((ORB_IMAGE_TIMEOUT_SECONDS + 30) * 1000),
    );
    const elapsed = Date.now() - started;
    if (run.exitCode === 91)
      throw new ImageRefused("The image could not be read in the workspace.");
    if (run.exitCode === 92)
      throw new ImageRefused(
        `The file grew past ${megabytes(ORB_IMAGE_MAX_SOURCE_BYTES)} while it was read.`,
      );
    if (
      run.exitCode === 124 ||
      run.exitCode === 137 ||
      elapsed >= ORB_IMAGE_TIMEOUT_SECONDS * 1000
    )
      throw new ImageRefused(
        `Decoding the ${image.width}×${image.height} ${image.format.toUpperCase()} in the workspace took over ${ORB_IMAGE_TIMEOUT_SECONDS} seconds, so it was stopped. The file is damaged or built to exhaust the decoder.`,
      );
    if (run.exitCode !== 0)
      throw new ImageRefused(
        `The ${image.format.toUpperCase()} could not be decoded in the workspace: ${(run.stdout || run.stderr).trim().split("\n").at(-1)?.slice(0, 200) || `ffmpeg exited with ${run.exitCode}`}.`,
      );
    const tooLarge = (bytes: number) =>
      new ImageRefused(
        `The downsized image is ${megabytes(bytes)}, still too large to send.`,
      );
    // ffmpeg's file size limit bounds it too.
    const { size = 0 } = await sandbox.stat(output);
    if (size > MAX_UNDECODED_BYTES) throw tooLarge(size);
    const data = await sandbox.readFileBuffer(output);
    if (data.length > MAX_UNDECODED_BYTES) throw tooLarge(data.length);
    const info = imageInfo(data);
    if (
      info?.format !== "jpeg" ||
      info.width === 0 ||
      info.height === 0 ||
      Math.max(info.width, info.height) > IMAGE_MAX_EDGE
    )
      throw new ImageRefused(
        "The image downsized in the workspace is not a valid JPEG.",
      );
    return {
      data,
      mimeType: "image/jpeg",
      width: info.width,
      height: info.height,
      source: image,
    };
  } finally {
    if (created)
      await sandbox
        .exec(`rm -rf -- ${quote(dir)}`, { timeoutMs: 30_000 })
        .catch(() => undefined);
  }
};
