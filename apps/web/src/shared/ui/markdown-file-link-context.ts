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
