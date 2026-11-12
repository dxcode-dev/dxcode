import { Copy } from "lucide-react";
import * as React from "react";
import { settle } from "../../shared/settle.js";
import { Button } from "../../shared/ui/button.js";

/**
 * An example request to dx, copied with one click: the Skills and Plugins
 * pages offer one where a person would otherwise start from a blank form.
 */
export function AskDxPrompt({ text }: { readonly text: string }) {
  const [copied, setCopied] = React.useState<boolean>();
  const copy = async () => {
    const outcome = await settle(() => navigator.clipboard.writeText(text));
    setCopied(outcome.ok);
  };
  return (
    <div className="ask-dx-prompt">
      <code>"{text}"</code>
      <Button size="xs" variant="ghost" onClick={() => void copy()}>
        <Copy aria-hidden="true" />
        Copy prompt
      </Button>
      <span aria-live="polite">
        {copied === undefined ? null : copied ? "Copied" : "Copy failed"}
      </span>
    </div>
  );
}
