import type { ThreadDetailData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Power } from "lucide-react";
import * as React from "react";
import { useIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { threadQueryOptions } from "../thread-queries.js";
import { RestartOrbDialog } from "./restart-orb-dialog.js";

export type RestartOrbControlProps =
  /**
   * The menu's item, for owners and contributors of an active Thread. The
   * menu passes its `Item` so this chunk shares no module with the Thread
   * page that would otherwise split out of it.
   */
  | {
      readonly part: "menu-item";
      readonly thread: ThreadDetailData;
      readonly Item: MenuItemComponent;
      readonly onSelect: () => void;
    }
  /** The confirmation, opened from the menu. */
  | {
      readonly part: "dialog";
      readonly threadId: ThreadId;
      readonly onClose: () => void;
    }
  /** The Thread page's error card's button and its confirmation. */
  | { readonly part: "card" };

// Loaded only for people who turned the feature on, when the Thread's menu
// opens or an error card offers a restart.
export default function RestartOrbControl(props: RestartOrbControlProps) {
  if (props.part === "dialog") return <RestartOrbDialog {...props} />;
  if (props.part === "menu-item")
    return props.thread.access !== "view" &&
      props.thread.lifecycleState === "active" ? (
      <MenuItem Item={props.Item} onSelect={props.onSelect} />
    ) : null;
  return <CardAction />;
}

type MenuItemComponent = React.ComponentType<{
  readonly className: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}>;

function MenuItem({
  Item,
  onSelect,
}: {
  readonly Item: MenuItemComponent;
  readonly onSelect: () => void;
}) {
  return (
    <Item className="thread-menu-item" onClick={onSelect}>
      <Power />
      <span>Restart Orb…</span>
    </Item>
  );
}

function CardAction() {
  const [restarting, setRestarting] = React.useState(false);
  const threadId = useCardThread();
  if (threadId === undefined) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setRestarting(true)}
      >
        <Power /> Restart Orb
      </Button>
      {restarting ? (
        <RestartOrbDialog
          threadId={threadId}
          onClose={() => setRestarting(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The Thread on the page, when the person may restart its Orb: owners and
 * contributors of an active Thread; viewers never.
 */
const useCardThread = () => {
  const queryClient = useQueryClient();
  const identity = useIdentity()?.identity;
  const threadId = (useParams({ strict: false }) as { threadId?: ThreadId })
    .threadId;
  const thread =
    identity === undefined || threadId === undefined
      ? undefined
      : queryClient.getQueryData(
          threadQueryOptions(identity.id, threadId).queryKey,
        );
  return thread !== undefined &&
    thread.access !== "view" &&
    thread.lifecycleState === "active"
    ? thread.id
    : undefined;
};
