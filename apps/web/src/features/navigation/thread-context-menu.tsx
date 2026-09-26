import { ContextMenu } from "@base-ui/react/context-menu";
import { Archive, ArchiveRestore, Copy, Pin } from "lucide-react";
import type { ReactNode } from "react";
import { absoluteThreadUrl } from "../../shared/thread-url.js";

export function ThreadContextMenu({
  thread,
  onSetArchived,
  onSetPinned,
  archiving,
  pinning,
  children,
}: {
  readonly thread: {
    readonly id: string;
    readonly lifecycleState: "active" | "archived";
    readonly pinnedAt?: unknown;
  };
  readonly onSetArchived: (archived: boolean) => void;
  readonly onSetPinned: (pinned: boolean) => void;
  readonly archiving: boolean;
  readonly pinning: boolean;
  readonly children: ReactNode;
}) {
  const copyLink = () => {
    void navigator.clipboard.writeText(
      absoluteThreadUrl(thread.id, window.location.href),
    );
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={<div className="thread-context-trigger" />}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="thread-context-positioner">
          <ContextMenu.Popup className="thread-context-menu">
            {thread.lifecycleState === "active" ? (
              <ContextMenu.Item
                className="thread-context-item"
                disabled={pinning}
                onClick={() => onSetPinned(thread.pinnedAt === undefined)}
              >
                <Pin /> {thread.pinnedAt === undefined ? "Pin" : "Unpin"}
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              className="thread-context-item"
              disabled={archiving}
              onClick={() => onSetArchived(thread.lifecycleState === "active")}
            >
              {thread.lifecycleState === "active" ? (
                <Archive />
              ) : (
                <ArchiveRestore />
              )}
              {thread.lifecycleState === "active" ? "Archive" : "Unarchive"}
            </ContextMenu.Item>
            <ContextMenu.Separator className="thread-context-separator" />
            <ContextMenu.Item
              className="thread-context-item"
              onClick={copyLink}
            >
              <Copy /> Copy Thread URL
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
