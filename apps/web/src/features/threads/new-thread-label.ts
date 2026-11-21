import type { ComposerEmail } from "../../shared/new-thread-surface.js";

/** The New Thread dialog's name, or its name when it starts from an email. */
export const newThreadLabel = (email: ComposerEmail | undefined) =>
  email === undefined ? "New thread" : "New thread from email";
