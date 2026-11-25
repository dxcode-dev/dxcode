import type { ClaudePlanLimit } from "@dx/domain";
import { ExternalLink, X } from "lucide-react";
import { Button } from "./button.js";
import { buttonVariants } from "./button-variants.js";
import { ClaudeIcon } from "./claude-icon.js";
import { CLAUDE_USAGE_URL, claudePlanLimitCopy } from "./claude-plan-limit.js";

/**
 * The card above a composer while a Claude plan is used up: the Claude
 * mark, when the plan resets, and a link to the account's usage. A Thread's
 * agent panel shows the same card with its own actions; a Space shows this.
 */
export function ClaudePlanLimitCard({
  limit,
  subject = "Thread",
  onDismiss,
}: {
  readonly limit: ClaudePlanLimit;
  readonly subject?: "Thread" | "Space";
  readonly onDismiss: () => void;
}) {
  const { title, message } = claudePlanLimitCopy(limit, subject);
  return (
    <div className="thread-error-row">
      <aside className="thread-error-card" role="alert" data-kind="claude-plan">
        <ClaudeIcon />
        <div className="thread-error-copy">
          <strong>{title}</strong>
          <span>{message}</span>
          <div className="thread-error-actions">
            <a
              className={buttonVariants({ variant: "ghost", size: "xs" })}
              href={CLAUDE_USAGE_URL}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink /> Check usage
            </a>
          </div>
        </div>
        <Button
          type="button"
          variant="subtle"
          size="icon-xs"
          className="thread-error-dismiss"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </aside>
    </div>
  );
}
