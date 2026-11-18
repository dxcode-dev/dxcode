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
