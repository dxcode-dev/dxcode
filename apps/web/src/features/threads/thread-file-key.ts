import type { ThreadFilesPath, ThreadFilesWorktreeId } from "@dx/api";

export const centerFileKey = (file: {
  readonly worktree?: ThreadFilesWorktreeId;
  readonly path: ThreadFilesPath;
}) => `${file.worktree ?? "primary"}:${file.path}`;
