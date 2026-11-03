import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Sandbox, SandboxToolFactory } from "@flue/runtime";
import { encodeBase64 } from "../../../encoding/base64.js";
import { type AnalyzeMedia, DEFAULT_MEDIA_OBJECTIVE } from "./analysis.js";
import {
  IMAGE_MAX_SOURCE_BYTES,
  ImageRefused,
  ImageTooLarge,
  imageInfo,
  type PreparedImage,
  prepareImage,
  sniffMedia,
} from "./image.js";
import {
  downscaleInOrb,
  ORB_IMAGE_MAX_SOURCE_BYTES,
  readOrbFileHead,
  readOrbFileSize,
} from "./orb-image.js";
import { fetchRemoteMedia } from "./remote.js";

type AgentTool = ReturnType<SandboxToolFactory>[number];

export const VIEW_MEDIA_TOOL = "view_media";

/** The `view_media` description the model reads. */
export const VIEW_MEDIA_DESCRIPTION = `View or analyze a media file.

Use this when you need to inspect an image, PDF, audio file, or video. The path may be an absolute local path, a dx image attachment URL, a temporary image URL from thread_file_url, or a public HTTP(S) URL.

When no objective is provided for a PNG/JPEG/GIF/WebP image, this tool returns the image as visual input so you can inspect it directly. When objective is provided, or when viewing a PDF, audio file, or video, use it when you want a textual description or answer about the media; in this mode the tool returns text only and does not return an image block.`;

/** `view_media` parameters; `found_on` is for private GitHub attachments. */
export const VIEW_MEDIA_PARAMETERS = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Absolute path to a local media file, a dx image attachment URL supplied in the conversation, a temporary image URL from thread_file_url, or a public HTTP(S) media URL.",
    },
    objective: {
      type: "string",
      description:
        "Optional objective to answer about the media. If provided, the tool returns a text-only answer instead of returning an image block. When verifying a change, state the expected result so the answer includes a clear verdict (for example \"verify the header shows the new title 'Reports'\").",
    },
    resolution: {
      type: "string",
      enum: ["high", "original"],
      description:
        "Optional image resolution preference. Use high to scale large raster images down when image compression support is available, or original to preserve the original image data.",
    },
    found_on: {
      type: "string",
      description:
        "For a GitHub attachment URL (https://github.com/user-attachments/assets/...) from a private repository: the URL of the issue or pull request that shows it, such as https://github.com/owner/repo/pull/123. GitHub serves such attachments only through that page.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export interface ViewMediaInput {
  readonly path: string;
  readonly objective?: string;
  readonly resolution?: "high" | "original";
  readonly found_on?: string;
}

export interface ViewMediaDeps {
  /** The token the Thread's `gh` would use. */
  readonly githubToken: () => Promise<string | undefined>;
  /** The analysis subagent, for an objective or a PDF. */
  readonly analyze: AnalyzeMedia;
  /** This deployment's origin; its attachment and storage URLs go through dxd. */
  readonly dxOrigin?: string;
}

export interface ViewMediaResult {
  readonly text: string;
  readonly image?: { readonly data: string; readonly mimeType: string };
  readonly details: Readonly<Record<string, string | number>>;
}

/** Largest PDF sent to the analysis subagent. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Largest file a Cloudflare container Orb's file API returns. */
const ORB_FILE_READ_BYTES = 16 * 1024 * 1024;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The file `view_media` reads. A workspace image too large for the isolate
 * has no `bytes`, only its first bytes in `head`. `orbPath` is the same file
 * in the Orb, when it is there.
 */
interface MediaSource {
  readonly label: string;
  bytes?: Uint8Array;
  readonly head?: Uint8Array;
  /** The file's size, with `head`. */
  readonly size?: number;
  /** Today's refusal of a file too large to read, with `head`. */
  readonly refusal?: ImageRefused;
  readonly orbPath?: string;
}

const readWorkspaceFile = async (
  sandbox: Sandbox,
  raw: string,
  label?: string,
): Promise<MediaSource> => {
  const path = posix.resolve(sandbox.cwd, raw);
  let size: number | undefined;
  try {
    const stat = await sandbox.stat(path);
    if (!stat.isFile) throw new ImageRefused(`${path} is not a file.`);
    size = stat.size;
  } catch (error) {
    if (error instanceof ImageRefused) throw error;
    throw new ImageRefused(`${path} does not exist or cannot be read.`, {
      cause: error,
    });
  }
  size ??= await readOrbFileSize(sandbox, path);
  // A large image is downsized in the Orb without reading it here: past
  // 16 MB a Cloudflare container Orb does not hand files to the isolate.
  if (size !== undefined && size > ORB_FILE_READ_BYTES) {
    const head =
      size > ORB_IMAGE_MAX_SOURCE_BYTES
        ? undefined
        : await readOrbFileHead(sandbox, path);
    const info = head === undefined ? undefined : imageInfo(head);
    if (head !== undefined && info !== undefined)
      return {
        label: label ?? path,
        head,
        size,
        // What the isolate answered before the Orb could downsize.
        refusal:
          size > IMAGE_MAX_SOURCE_BYTES
            ? new ImageRefused(
                `${path} is ${megabytes(size)}; files over ${megabytes(IMAGE_MAX_SOURCE_BYTES)} are not read.`,
              )
            : new ImageTooLarge({ ...info, bytes: size }),
        orbPath: path,
      };
  }
  if (size !== undefined && size > IMAGE_MAX_SOURCE_BYTES)
    throw new ImageRefused(
      `${path} is ${megabytes(size)}; files over ${megabytes(IMAGE_MAX_SOURCE_BYTES)} are not read.`,
    );
  return {
    label: label ?? path,
    bytes: await sandbox.readFileBuffer(path),
    orbPath: path,
  };
};

/**
 * A dx attachment or Thread storage URL needs the Thread's own key, which
 * only dxd in the workspace holds; it downloads the file there.
 */
const isDxFileUrl = (url: URL, dxOrigin: string | undefined) =>
  dxOrigin !== undefined &&
  url.origin === dxOrigin &&
  (/^\/v1\/attachments\/[^/]+/.test(url.pathname) ||
    /^\/v1\/threads\/[^/]+\/storage\/[^/]+/.test(url.pathname));

const downloadDxFile = async (sandbox: Sandbox, url: URL, target: string) => {
  const result = await sandbox.exec(
    `dxd files get ${quote(url.toString())} -o ${quote(target)}`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0)
    throw new ImageRefused(
      `dx could not download ${url.toString()}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
  return readWorkspaceFile(sandbox, target, url.toString());
};

/**
 * The image as the model gets it. One the isolate refuses as too large is
 * downsized in the Orb; with no Orb or no ffmpeg there, the refusal stands.
 */
const imageFor = async (
  sandbox: Sandbox,
  source: MediaSource,
  resolution: "high" | "original",
  signal: AbortSignal | undefined,
): Promise<{ readonly image: PreparedImage; readonly inOrb: boolean }> => {
  let refusal: ImageRefused;
  let original: PreparedImage["source"];
  if (source.bytes !== undefined) {
    try {
      return {
        image: await prepareImage(source.bytes, resolution),
        inOrb: false,
      };
    } catch (error) {
      if (!(error instanceof ImageTooLarge)) throw error;
      refusal = error;
      original = error.image;
    }
  } else {
    const info = source.head === undefined ? undefined : imageInfo(source.head);
    refusal =
      source.refusal ?? new ImageRefused(`${source.label} is not an image.`);
    if (
      info === undefined ||
      source.orbPath === undefined ||
      resolution === "original"
    )
      throw refusal;
    original = { ...info, bytes: source.size ?? 0 };
  }
  const input =
    source.orbPath === undefined
      ? { bytes: source.bytes ?? new Uint8Array(0) }
      : { path: source.orbPath };
  // The isolate holds only the downsized image from here on.
  source.bytes = undefined;
  const image = await downscaleInOrb(
    sandbox,
    { input, image: original },
    signal,
  );
  if (image === undefined) throw refusal;
  return { image, inOrb: true };
};

const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : megabytes(bytes);

/**
 * `view_media` for either mode: reads the file, then returns the image
 * itself or, with an objective or for a PDF, the analysis subagent's answer.
 */
export const viewMedia = async (
  sandbox: Sandbox,
  input: ViewMediaInput,
  deps: ViewMediaDeps,
  signal?: AbortSignal,
): Promise<ViewMediaResult> => {
  const path = input.path?.trim();
  if (!path) throw new Error("path is required.");
  const objective = input.objective?.trim() || undefined;
  let url: URL | undefined;
  if (/^https?:\/\//i.test(path)) url = new URL(path);
  if (url === undefined && input.found_on !== undefined)
    throw new Error("found_on is only for a GitHub attachment URL.");
  const downloaded =
    url !== undefined && isDxFileUrl(url, deps.dxOrigin)
      ? `/tmp/dx-view-media-${crypto.randomUUID()}`
      : undefined;
  try {
    const source: MediaSource =
      url === undefined
        ? await readWorkspaceFile(sandbox, path)
        : downloaded !== undefined
          ? await downloadDxFile(sandbox, url, downloaded)
          : {
              label: path,
              bytes: await fetchRemoteMedia(path, {
                githubToken: deps.githubToken,
                ...(input.found_on === undefined
                  ? {}
                  : { foundOn: input.found_on }),
                ...(signal === undefined ? {} : { signal }),
              }),
            };
    signal?.throwIfAborted();
    const { label } = source;
    const kind = sniffMedia(source.bytes ?? source.head ?? new Uint8Array(0));
    if (kind === undefined)
      throw new ImageRefused(
        `${label} is not an image, PDF, audio file, or video that view_media can read.`,
      );
    if (kind.kind === "audio" || kind.kind === "video")
      throw new ImageRefused(
        `${label} is ${kind.kind} (${kind.format}). view_media reads images and PDFs; dx cannot analyze audio or video yet.`,
      );
    if (kind.kind === "pdf") {
      const bytes = source.bytes ?? new Uint8Array(0);
      if (bytes.length > MAX_PDF_BYTES)
        throw new ImageRefused(
          `${label} is a ${megabytes(bytes.length)} PDF; view_media reads PDFs up to ${megabytes(MAX_PDF_BYTES)}. Extract the pages you need first, for example with qpdf or pdftoppm.`,
        );
      const answer = await deps.analyze(objective ?? DEFAULT_MEDIA_OBJECTIVE, {
        data: encodeBase64(bytes),
        mimeType: "application/pdf",
      });
      return {
        text: answer,
        details: { source: label, kind: "pdf", sourceBytes: bytes.length },
      };
    }
    const { image, inOrb } = await imageFor(
      sandbox,
      source,
      input.resolution ?? "high",
      signal,
    );
    const { source: original } = image;
    const details = {
      source: label,
      kind: "image",
      format: original.format,
      width: image.width,
      height: image.height,
      sourceWidth: original.width,
      sourceHeight: original.height,
      sourceBytes: original.bytes,
      ...(inOrb ? { bytes: image.data.length, resizedIn: "workspace" } : {}),
    };
    const data = encodeBase64(image.data);
    if (objective !== undefined)
      return {
        text: await deps.analyze(objective, { data, mimeType: image.mimeType }),
        details,
      };
    const resized = inOrb
      ? `, resized in the workspace from ${original.width}×${original.height} (${size(original.bytes)}) to ${image.width}×${image.height} (${size(image.data.length)} JPEG)`
      : image.width !== original.width || image.height !== original.height
        ? `, downsized from ${original.width}×${original.height}`
        : "";
    return {
      text: `${label}: ${original.format.toUpperCase()}, ${image.width}×${image.height}${resized}.`,
      image: { data, mimeType: image.mimeType },
      details,
    };
  } finally {
    if (downloaded !== undefined)
      await sandbox
        .exec(`rm -f -- ${quote(downloaded)}`)
        .catch(() => undefined);
  }
};

/**
 * `view_media` in dx's own loop: a sandbox tool, because only those can
 * return an image block; Flue's custom tools return text.
 */
export const createViewMediaTool = (
  sandbox: Sandbox,
  deps: ViewMediaDeps,
): AgentTool => ({
  name: VIEW_MEDIA_TOOL,
  label: "View Media",
  description: VIEW_MEDIA_DESCRIPTION,
  parameters: Type.Unsafe<ViewMediaInput>(VIEW_MEDIA_PARAMETERS),
  async execute(_toolCallId, input, signal) {
    signal?.throwIfAborted();
    const result = await viewMedia(
      sandbox,
      input as ViewMediaInput,
      deps,
      signal,
    );
    return {
      content: [
        { type: "text", text: result.text },
        ...(result.image === undefined
          ? []
          : [{ type: "image" as const, ...result.image }]),
      ],
      details: result.details,
    };
  },
});
