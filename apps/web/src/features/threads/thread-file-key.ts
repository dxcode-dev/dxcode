import type { ThreadFilesPath, ThreadFilesWorktreeId } from "@dx/api";

/** Identity of a repository file tab; matches `fileTargetKey` for workspace files. */
export const centerFileKey = (file: {
  readonly worktree?: ThreadFilesWorktreeId;
  readonly path: ThreadFilesPath;
}) => `${file.worktree ?? "primary"}:${file.path}`;
