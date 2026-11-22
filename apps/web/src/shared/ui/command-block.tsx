import { Check, Copy } from "lucide-react";
import * as React from "react";
import { settle } from "../settle.js";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import "./command-block.css";

/**
 * A shell command to run as given, such as the one that installs a runner:
 * monospace, wrapping anywhere, with a Copy button. A screen reader hears
 * "Copied" (or "Copy failed") after a copy.
 */
export function CommandBlock({
  command,
  label = "Command",
  disabled = false,
  className,
}: {
  readonly command: string;
  /** What the command is, for screen readers and the Copy button. */
  readonly label?: string;
  /** While the command is not ready yet, such as while it loads. */
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const [copied, setCopied] = React.useState<boolean>();
  const copy = async () => {
    const outcome = await settle(() => navigator.clipboard.writeText(command));
    setCopied(outcome.ok);
  };
  return (
    <div
      className={cn("command-block", className)}
      data-disabled={disabled || undefined}
    >
      <code>{command}</code>
      <Button
        size="xs"
        variant="ghost"
        type="button"
        disabled={disabled}
        onClick={() => void copy()}
      >
        {copied === true ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {copied === true ? "Copied" : "Copy"}
        {/* Named with its visible text first, so the name always contains it. */}
        <span className="visually-hidden"> {label.toLowerCase()}</span>
      </Button>
      <span className="visually-hidden" aria-live="polite">
        {copied === undefined ? null : copied ? "Copied" : "Copy failed"}
      </span>
    </div>
  );
}
