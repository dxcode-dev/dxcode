import * as React from "react";
import { MarkdownImageSourceContext } from "./markdown-file-link-context.js";
import { storedMediaSource } from "./media-kind.js";

/**
 * How a Markdown image names a player source: a file in Thread storage
 * wherever the Markdown renders, else whatever the surrounding workspace or
 * document resolves (a sandbox path, a document-relative file).
 */
export const useMarkdownMediaSource = () => {
  const resolve = React.useContext(MarkdownImageSourceContext);
  return (src: string) => storedMediaSource(src) ?? resolve?.(src);
};
