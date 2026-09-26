import { ThreadFilesPath } from "@dx/api";
import { Schema } from "effect";

/** Resolve sandbox file URLs to the repository-relative Files API path. */
export const transcriptFilePath = (
  href: string,
): ThreadFilesPath | undefined => {
  if (!href.startsWith("file:///")) return undefined;
  try {
    const url = new URL(href);
    if (url.hostname || url.search) return undefined;
    const path = decodeURIComponent(url.pathname);
    const root = "/home/user/workspace/repo/";
    if (!path.startsWith(root)) return undefined;
    return Schema.decodeUnknownSync(ThreadFilesPath)(path.slice(root.length));
  } catch {
    return undefined;
  }
};
