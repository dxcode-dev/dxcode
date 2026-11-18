import type { ThreadId } from "@dx/domain";
import { copyText } from "./copy-text.js";
import { absoluteThreadUrl } from "./thread-url.js";

/**
 * Copies a Thread's URL and says whether it worked, the same from the
 * sidebar's menu and the Thread header's.
 */
export const copyThreadUrl = (threadId: ThreadId) =>
  copyText(absoluteThreadUrl(threadId, window.location.href), "Thread URL");

/** Copies a Thread's ID, as `copyThreadUrl` copies its URL. */
export const copyThreadId = (threadId: ThreadId) =>
  copyText(threadId, "Thread ID");
