import { toast } from "sonner";
import { physicalKeyEvent } from "../../shared/commands/physical-key.js";

/** The rows a message menu acts on: what people and the agent wrote. */
export type MessageMenuKind =
  | "user-prompt"
  | "assistant-prose"
  | "final-answer";

const copied = async (write: () => Promise<void>, what: string) => {
  try {
    await write();
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
};

/** Copies text and says so: "Message copied.", "Selection copied.". */
export const copyText = (text: string, what = "Message") =>
  copied(() => navigator.clipboard.writeText(text), what);

/** Copies a message as written: a prompt's text, or a reply's Markdown. */
export const copyMessageText = (text: string) => copyText(text);

/**
 * Ctrl+C (⌘C) on a focused message copies it, unless text is selected,
 * which the browser copies as usual.
 */
export const copyFocusedMessage = (
  event: React.KeyboardEvent<HTMLElement>,
  text: string,
) => {
  if (event.target !== event.currentTarget) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
    return;
  if (physicalKeyEvent(event.nativeEvent).key.toLowerCase() !== "c") return;
  if ((window.getSelection()?.toString() ?? "") !== "") return;
  event.preventDefault();
  void copyMessageText(text);
};

/** Copies a link that opens the Thread at this message. */
export const copyMessageLink = (url: string) =>
  copied(() => navigator.clipboard.writeText(url), "Link");
