import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Sandbox, SandboxToolFactory } from "@flue/runtime";
import { encodeBase64 } from "../../../encoding/base64.js";
import { type AnalyzeMedia, DEFAULT_MEDIA_OBJECTIVE } from "./analysis.js";
import {
  IMAGE_MAX_SOURCE_BYTES,
  ImageRefused,
  prepareImage,
  sniffMedia,
} from "./image.js";
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

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const readWorkspaceFile = async (sandbox: Sandbox, raw: string) => {
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
  if (size !== undefined && size > IMAGE_MAX_SOURCE_BYTES)
    throw new ImageRefused(
      `${path} is ${megabytes(size)}; files over ${megabytes(IMAGE_MAX_SOURCE_BYTES)} are not read.`,
    );
  return { label: path, bytes: await sandbox.readFileBuffer(path) };
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

const readDxFile = async (sandbox: Sandbox, url: URL) => {
  const target = `/tmp/dx-view-media-${crypto.randomUUID()}`;
  try {
    const result = await sandbox.exec(
      `dxd files get ${quote(url.toString())} -o ${quote(target)}`,
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0)
      throw new ImageRefused(
        `dx could not download ${url.toString()}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      );
    const { bytes } = await readWorkspaceFile(sandbox, target);
    return { label: url.toString(), bytes };
  } finally {
    await sandbox.exec(`rm -f ${quote(target)}`).catch(() => undefined);
  }
};

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
  const { label, bytes } =
    url === undefined
      ? await readWorkspaceFile(sandbox, path)
      : isDxFileUrl(url, deps.dxOrigin)
        ? await readDxFile(sandbox, url)
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
  const kind = sniffMedia(bytes);
  if (kind === undefined)
    throw new ImageRefused(
      `${label} is not an image, PDF, audio file, or video that view_media can read.`,
    );
  if (kind.kind === "audio" || kind.kind === "video")
    throw new ImageRefused(
      `${label} is ${kind.kind} (${kind.format}). view_media reads images and PDFs; dx cannot analyze audio or video yet.`,
    );
  if (kind.kind === "pdf") {
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
  const image = await prepareImage(bytes, input.resolution ?? "high");
  const { source } = image;
  const details = {
    source: label,
    kind: "image",
    format: source.format,
    width: image.width,
    height: image.height,
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceBytes: source.bytes,
  };
  const data = encodeBase64(image.data);
  if (objective !== undefined)
    return {
      text: await deps.analyze(objective, { data, mimeType: image.mimeType }),
      details,
    };
  const resized =
    image.width !== source.width || image.height !== source.height
      ? `, downsized from ${source.width}×${source.height}`
      : "";
  return {
    text: `${label}: ${source.format.toUpperCase()}, ${image.width}×${image.height}${resized}.`,
    image: { data, mimeType: image.mimeType },
    details,
  };
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
