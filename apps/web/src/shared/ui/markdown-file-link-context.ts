import { createContext } from "react";

/** Workspace-owned navigation handler for Markdown file links. */
export const MarkdownFileLinkContext = createContext<
  ((href: string) => void) | undefined
>(undefined);
