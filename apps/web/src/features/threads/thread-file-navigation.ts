import { createContext } from "react";
import type { FileReveal, ThreadFileTarget } from "./transcript-file-link.js";

/**
 * Opens a file in the Thread workspace center pane, optionally highlighting
 * lines. The workspace provides it; the transcript uses it so an "Edited"
 * row opens the file at the chunk the agent wrote.
 */
export interface ThreadFileNavigation {
  readonly open: (target: ThreadFileTarget, reveal?: FileReveal) => void;
  /** Same-origin download URL, when the file's absolute path is known. */
  readonly downloadUrl: (target: ThreadFileTarget) => string | undefined;
}

export const ThreadFileNavigationContext = createContext<
  ThreadFileNavigation | undefined
>(undefined);
