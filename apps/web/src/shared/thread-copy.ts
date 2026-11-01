import type { ThreadId } from "@dx/domain";
import { toast } from "sonner";
import { absoluteThreadUrl } from "./thread-url.js";

const copy = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied.`);
  } catch {
    toast.error(`Could not copy the ${label}.`);
  }
};

/**
 * Copies a Thread's URL and says whether it worked, the same from the
 * sidebar's menu and the Thread header's.
 */
export const copyThreadUrl = (threadId: ThreadId) =>
  copy(absoluteThreadUrl(threadId, window.location.href), "Thread URL");

/** Copies a Thread's ID, as `copyThreadUrl` copies its URL. */
export const copyThreadId = (threadId: ThreadId) => copy(threadId, "Thread ID");
