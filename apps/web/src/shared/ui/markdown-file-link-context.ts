import { createContext } from "react";

/** A Markdown href that resolved to a file in the current workspace. */
export interface MarkdownFileLink {
  /** Open the file in the workspace, as the Files panel does. */
  readonly open: () => void;
  /** Same-origin download URL, when the file can be downloaded. */
  readonly downloadUrl?: string;
}

/**
 * Workspace-owned resolver for Markdown links. Returns `undefined` for hrefs
 * that are not files, which then render as ordinary external links.
 */
export type MarkdownFileLinkResolver = (
  href: string,
) => MarkdownFileLink | undefined;

export const MarkdownFileLinkContext = createContext<
  MarkdownFileLinkResolver | undefined
>(undefined);

/** A media file a Markdown image names, as a same-origin URL and a player. */
export interface MarkdownMediaSource {
  readonly url: string;
  readonly kind: "image" | "video" | "audio";
  /** Same-origin URL that downloads the file, when it can be downloaded. */
  readonly downloadUrl?: string;
}

/**
 * Resolves the file a Markdown image names (`![alt](path)`) to a same-origin
 * URL: in a document, relative to the document; in a transcript, a path in
 * the Thread's workspace. Video and audio files render as players.
 */
export type MarkdownImageSourceResolver = (
  src: string,
) => MarkdownMediaSource | undefined;

export const MarkdownImageSourceContext = createContext<
  MarkdownImageSourceResolver | undefined
>(undefined);
