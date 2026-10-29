import type { FileReveal, ThreadFileTarget } from "../transcript-file-link.js";

/** An open file tab: a repository or read-only sandbox file. */
export type CenterFileTab = ThreadFileTarget & {
  readonly dirty: boolean;
  /** Lines to highlight; replaced each time the file is opened again. */
  readonly reveal?: FileReveal;
  /** Increments per open so the same reveal can scroll again. */
  readonly revealSequence?: number;
};
