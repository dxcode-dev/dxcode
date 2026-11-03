import type { ThreadFilesPath } from "@dx/api";
import { ThreadFilesApiError } from "./files-api.js";

/** The last segment of a tree path, without a folder's trailing slash. */
export const baseName = (path: string) =>
  (path.endsWith("/") ? path.slice(0, -1) : path).split("/").at(-1) ?? path;

/** The folder holding `path`, or undefined at the worktree root. */
export const parentOf = (path: string) => {
  const plain = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = plain.lastIndexOf("/");
  return index < 0 ? undefined : plain.slice(0, index);
};

export const childPath = (folder: string | undefined, name: string) =>
  (folder === undefined ? name : `${folder}/${name}`) as ThreadFilesPath;

/**
 * A name in `folder` that no known entry uses: `base`, then `base 2`, … For
 * a copy, `name copy.ext`, then `name copy 2.ext`, as a file manager does.
 */
export const freeName = (
  taken: ReadonlySet<string>,
  name: string,
  variant: "plain" | "copy",
  folder: string | undefined,
) => {
  const dot = name.lastIndexOf(".");
  const [stem, extension] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const candidate = (index: number) => {
    const suffix =
      variant === "copy"
        ? index === 1
          ? " copy"
          : ` copy ${index}`
        : index === 1
          ? ""
          : ` ${index}`;
    return `${stem}${suffix}${extension}`;
  };
  for (let index = 1; index < 10_000; index += 1) {
    const next = candidate(index);
    if (!taken.has(childPath(folder, next))) return next;
  }
  return candidate(Date.now());
};

/** What a failed Files write tells the person, in one sentence. */
export const writeErrorMessage = (error: unknown, name?: string) => {
  if (error instanceof ThreadFilesApiError)
    switch (error.code) {
      case "THREAD_FILES_CONFLICT":
        return name === undefined
          ? "Something with that name already exists."
          : `“${name}” already exists there.`;
      case "THREAD_FILES_INVALID_REQUEST":
        return "That name or location isn't allowed.";
      case "THREAD_FILES_ENTRY_NOT_FOUND":
        return "It no longer exists. The tree has been refreshed.";
      case "THREAD_READ_ONLY":
        return "You can view this Thread. Ask its owner for Contribute access.";
      case "THREAD_ARCHIVED":
        return "This Thread is archived. Unarchive it to change files.";
      default:
        return "Files are temporarily unavailable. Try again.";
    }
  return "Files are temporarily unavailable. Try again.";
};
