import type { ThreadId } from "@dx/domain";
import { copyText } from "./copy-text.js";
import { absoluteThreadUrl } from "./thread-url.js";

/**
 * Copies a Thread's URL and says whether it worked, the same from the
 * sidebar's menu and the Thread header's. A Space's says `Space URL`.
 */
export const copyThreadUrl = (threadId: ThreadId, label = "Thread URL") =>
  copyText(absoluteThreadUrl(threadId, window.location.href), label);

/** Copies a Thread's ID, as `copyThreadUrl` copies its URL. */
export const copyThreadId = (threadId: ThreadId, label = "Thread ID") =>
  copyText(threadId, label);
