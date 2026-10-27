import { Menu } from "@base-ui/react/menu";
import type { GitHubSubscriptionData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Ellipsis } from "lucide-react";
import { GitHubOutlineIcon } from "../../../shared/ui/github-icon.js";
import { errorText, subscriptionStatus } from "./automation-text.js";
import { useAutomationAction } from "./automations-queries.js";

/** A GitHub subscription: opens on GitHub; the menu disables or deletes. */
export function SubscriptionRow({
  threadId,
  subscription,
}: {
  readonly threadId: ThreadId;
  readonly subscription: GitHubSubscriptionData;
}) {
  const action = useAutomationAction(threadId);
  const status = subscriptionStatus(subscription);
  const listening = subscription.state === "active" && subscription.enabled;
  return (
    <li
      className="automation-subscription"
      data-listening={listening || undefined}
    >
      <a
        href={subscription.url}
        target="_blank"
        rel="noreferrer"
        title={status}
        className="automation-subscription-link"
      >
        <GitHubOutlineIcon />
        <span className="automation-subscription-copy">
          <strong>{subscription.title}</strong>
          <small>
            {`${subscription.lastEvent ?? subscription.target} · ${subscription.repository}`}
          </small>
          <span className="sr-only">{status}</span>
        </span>
      </a>
      <Menu.Root>
        <Menu.Trigger
          className="automation-icon-button"
          aria-label={`Actions for ${subscription.title}`}
          disabled={action.isPending}
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner automation-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup">
              {subscription.state === "active" ? (
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() =>
                    action.mutate({
                      kind: "github",
                      id: subscription.id,
                      enabled: !subscription.enabled,
                    })
                  }
                >
                  <span>{subscription.enabled ? "Disable" : "Enable"}</span>
                </Menu.Item>
              ) : null}
              <Menu.Item
                className="thread-menu-item automation-delete"
                onClick={() =>
                  action.mutate({ kind: "github", id: subscription.id })
                }
              >
                <span>Delete</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {action.error === null ? null : (
        <p className="automation-error" role="alert">
          {errorText(action.error)}
        </p>
      )}
    </li>
  );
}
