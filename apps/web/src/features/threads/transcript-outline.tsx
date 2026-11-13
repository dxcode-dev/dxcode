import { List } from "lucide-react";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import type {
  TranscriptOutlineAnchor,
  TranscriptRowId,
} from "./transcript-view-model.js";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

interface TranscriptOutlineProps {
  readonly anchors: ReadonlyArray<TranscriptOutlineAnchor>;
  readonly visibleRowIds: ReadonlySet<TranscriptRowId>;
  readonly onNavigate: (anchor: TranscriptOutlineAnchor) => void;
  readonly onOpen: () => void;
}

const currentItemRef = (element: HTMLElement | null) => {
  if (element === null) return;
  requestAnimationFrame(() => element.scrollIntoView?.({ block: "start" }));
};

/**
 * The outline changes when a prompt is added or scrolls into view, not when
 * a reply streams: the transcript keeps its anchors and handlers stable.
 */
export function TranscriptOutline({
  anchors,
  visibleRowIds,
  onNavigate,
  onOpen,
}: TranscriptOutlineProps) {
  const currentRowId = anchors.find((anchor) =>
    visibleRowIds.has(anchor.rowId),
  )?.rowId;
  if (anchors.length <= 1) return null;

  return (
    <MenuRoot onOpenChange={(open) => (open ? onOpen() : undefined)}>
      <MenuTrigger
        className={buttonVariants({
          variant: "subtle",
          size: "icon-sm",
          className: "transcript-control",
        })}
        aria-label="Prompt outline"
      >
        <List />
      </MenuTrigger>
      <MenuPopup
        side="top"
        align="end"
        sideOffset={6}
        positionerClassName="transcript-outline-positioner"
        className="transcript-outline-menu"
        aria-label="Prompt outline"
      >
        {anchors.map((anchor) => (
          <MenuItem
            className="transcript-outline-item"
            data-visible={visibleRowIds.has(anchor.rowId) ? "" : undefined}
            aria-current={
              anchor.rowId === currentRowId ? "location" : undefined
            }
            ref={anchor.rowId === currentRowId ? currentItemRef : undefined}
            key={anchor.id}
            onClick={() => onNavigate(anchor)}
          >
            <span>{anchor.label}</span>
            {anchor.timestamp ? (
              <time className="dx-menu-hint" dateTime={anchor.timestamp}>
                {timestampFormatter.format(new Date(anchor.timestamp))}
              </time>
            ) : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </MenuRoot>
  );
}
