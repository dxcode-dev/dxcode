import { toast } from "sonner";

/**
 * Copies text and says whether it worked: "Thread URL copied.". Where the
 * clipboard is missing (an insecure origin) or refuses, the toast shows the
 * text so it can be copied by hand. Every plain-text copy button uses it.
 */
export const copyText = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied.`);
  } catch {
    toast(text, { description: "Could not copy. Copy the text above." });
  }
};

/**
 * Copies rendered content (a message, or a selection's fragment) as rich
 * text, with its plain text beside it: "Message copied.".
 */
export const copyWithStyling = async (
  content: Node | null,
  text: string,
  label = "Message",
) => {
  try {
    if (content === null) throw new Error("The message is not on screen.");
    const holder = document.createElement("div");
    holder.append(content.cloneNode(true));
    // Controls inside a reply (copy buttons, toolbars) are not its content.
    for (const control of holder.querySelectorAll(
      "button, [role='toolbar'], [aria-hidden='true']",
    ))
      control.remove();
    if (typeof ClipboardItem === "undefined")
      await navigator.clipboard.writeText(text);
    else
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([holder.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    toast.success(`${label} copied.`);
  } catch {
    toast.error(`Could not copy the ${label.toLowerCase()}.`);
  }
};
