import { toast } from "sonner";

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
  if (event.key.toLowerCase() !== "c") return;
  if ((window.getSelection()?.toString() ?? "") !== "") return;
  event.preventDefault();
  void copyMessageText(text);
};

/**
 * Copies rendered content (a message, or a selection's fragment) as rich
 * text, with its plain text beside it.
 */
export const copyWithStyling = (
  content: Node | null,
  text: string,
  what = "Message",
) =>
  copied(async () => {
    if (content === null) throw new Error("The message is not on screen.");
    const holder = document.createElement("div");
    holder.append(content.cloneNode(true));
    // Controls inside a reply (copy buttons, toolbars) are not its content.
    for (const control of holder.querySelectorAll(
      "button, [role='toolbar'], [aria-hidden='true']",
    ))
      control.remove();
    if (typeof ClipboardItem === "undefined")
      return navigator.clipboard.writeText(text);
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([holder.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
  }, what);

/** Copies a link that opens the Thread at this message. */
export const copyMessageLink = (url: string) =>
  copied(() => navigator.clipboard.writeText(url), "Link");
