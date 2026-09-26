import { Menu } from "@base-ui/react/menu";
import { List } from "lucide-react";
import * as React from "react";
import type {
  TranscriptOutlineAnchor,
  TranscriptRowId,
} from "./transcript-view-model.js";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function TranscriptOutline({
  anchors,
  visibleRowIds,
  onNavigate,
  onOpen,
}: {
  readonly anchors: ReadonlyArray<TranscriptOutlineAnchor>;
  readonly visibleRowIds: ReadonlySet<TranscriptRowId>;
  readonly onNavigate: (rowId: TranscriptRowId) => void;
  readonly onOpen: () => void;
}) {
  const currentRowId = anchors.find((anchor) =>
    visibleRowIds.has(anchor.rowId),
  )?.rowId;
  const currentItemRef = React.useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    requestAnimationFrame(() => element.scrollIntoView?.({ block: "start" }));
  }, []);
  if (anchors.length <= 1) return null;

  return (
    <Menu.Root onOpenChange={(open) => (open ? onOpen() : undefined)}>
      <Menu.Trigger className="transcript-control" aria-label="Prompt outline">
        <List />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="transcript-outline-positioner"
          side="top"
          align="end"
          sideOffset={6}
        >
          <Menu.Popup
            className="transcript-outline-menu"
            aria-label="Prompt outline"
          >
            {anchors.map((anchor) => (
              <Menu.Item
                className="transcript-outline-item"
                data-visible={visibleRowIds.has(anchor.rowId) ? "" : undefined}
                aria-current={
                  anchor.rowId === currentRowId ? "location" : undefined
                }
                ref={anchor.rowId === currentRowId ? currentItemRef : undefined}
                key={anchor.id}
                onClick={() => onNavigate(anchor.rowId)}
              >
                <span>{anchor.label}</span>
                {anchor.timestamp ? (
                  <time dateTime={anchor.timestamp}>
                    {timestampFormatter.format(new Date(anchor.timestamp))}
                  </time>
                ) : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
