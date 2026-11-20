import type { SpaceData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Compass, Plus } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { ClaudePlanPickerSlot } from "../../shared/claude-plan-picker-slot.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import {
  clearSidebarContextPress,
  focusSidebarCommandItem,
  noteSidebarContextPress,
} from "../../shared/sidebar-command-focus.js";
import { lazyComponent } from "../../shared/stale-chunk.js";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { ParticipantStack } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import { RowContextMenu } from "../../shared/ui/row-context-menu.js";
import { SpaceContextMenuItems } from "./space-context-menu.js";
import {
  compactAge,
  epochOf,
  spaceStatusText,
  updatedAgo,
} from "./space-format.js";
import { SpaceIcon } from "./space-icon.js";
import {
  joinedSpacesQueryOptions,
  useSetSpaceJoined,
} from "./space-queries.js";
import "./spaces.css";

// The dialogs load when one first opens: the sidebar is on the Thread page's
// first load, and its budget.
const CreateSpaceDialog = lazyComponent(() =>
  import("./create-space-dialog.js").then((module) => ({
    default: module.CreateSpaceDialog,
  })),
);
const DiscoverSpacesDialog = lazyComponent(() =>
  import("./discover-spaces-dialog.js").then((module) => ({
    default: module.DiscoverSpacesDialog,
  })),
);
const EditSpaceDialog = lazyComponent(() =>
  import("./edit-space-dialog.js").then((module) => ({
    default: module.EditSpaceDialog,
  })),
);
const DeleteSpaceDialog = lazyComponent(() =>
  import("./delete-space-dialog.js").then((module) => ({
    default: module.DeleteSpaceDialog,
  })),
);

/** A row click this soon after its menu opened is the long press lifting. */
const LONG_PRESS_CLICK_MS = 1_000;

/** What a Space row's context menu can do; undefined is not offered. */
interface SpaceRowActions {
  readonly onEdit?: () => void;
  readonly onArchive?: () => void;
  readonly onDelete?: () => void;
  readonly onLeave?: () => void;
}

/** A dialog the section shows: its own, or one for a Space row. */
type SpacesDialog =
  | "create"
  | "discover"
  | { readonly kind: "edit" | "delete"; readonly space: SpaceData };

/** How long ago the Space last saw activity, at the row's end. */
function SpaceRowAge({ space }: { readonly space: SpaceData }) {
  const at = epochOf(space.lastActivityAt);
  const age = useTimeText((now) => compactAge(at, now));
  return <span className="sidebar-space-age">{age}</span>;
}

/**
 * The Space's own status beside its name: amber while it waits on a person,
 * as a thread that needs you reads.
 */
function SpaceStatus({
  space,
  className,
}: {
  readonly space: SpaceData;
  readonly className: string;
}) {
  const status = spaceStatusText(space);
  if (status === undefined) return null;
  return (
    <span
      className={className}
      data-waiting={space.waitingOnInput ? "" : undefined}
      title={status}
    >
      {status}
    </span>
  );
}

/** Where the hover card shows: beside the row it is for. */
interface HoverCardAt {
  readonly threadId: string;
  readonly top: number;
  readonly left: number;
}

/** How long the pointer rests on a row before its card shows. */
const HOVER_CARD_DELAY_MS = 350;

/**
 * The card beside a hovered Space row: its name, when it was last updated,
 * and its colored mark.
 */
function SpaceHoverCard({
  space,
  at,
}: {
  readonly space: SpaceData;
  readonly at: HoverCardAt;
}) {
  const updated = useTimeText((now) =>
    updatedAgo(epochOf(space.lastActivityAt), now),
  );
  return createPortal(
    <div
      className="sidebar-space-card"
      role="tooltip"
      id={`space-card-${space.threadId}`}
      style={{ top: at.top, left: at.left }}
    >
      <span className="sidebar-space-card-text">
        <strong>{space.name}</strong>
        <SpaceStatus space={space} className="sidebar-space-card-status" />
        <small>{updated}</small>
      </span>
      <SpaceIcon color={space.color} className="sidebar-space-card-icon" />
    </div>,
    document.body,
  );
}

/**
 * One Space: its colored mark, name, who is in it, and when it was active.
 * Right-click, a long press, or M on the focused row opens its menu.
 */
function SidebarSpaceRow({
  space,
  selected,
  actions,
  onNavigate,
  onHover,
  onLeave,
}: {
  readonly space: SpaceData;
  readonly selected: boolean;
  readonly actions: SpaceRowActions;
  readonly onNavigate: () => void;
  readonly onHover: (threadId: string, row: HTMLElement) => void;
  readonly onLeave: () => void;
}) {
  const menuOpenedAt = React.useRef(Number.NEGATIVE_INFINITY);
  return (
    <RowContextMenu
      menuKey={space.threadId}
      items={() => <SpaceContextMenuItems space={space} {...actions} />}
      onOpenChange={(open) => {
        if (!open) return;
        menuOpenedAt.current = Date.now();
        // The menu covers the card, so it goes.
        onLeave();
      }}
    >
      <div
        className="thread-row-shell"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse")
            onHover(space.threadId, event.currentTarget);
        }}
        onPointerLeave={onLeave}
      >
        <Link
          className={`thread-row sidebar-space-row ${selected ? "selected" : ""}`}
          aria-current={selected ? "page" : undefined}
          data-command-sidebar-item=""
          to="/threads/$threadId"
          params={{ threadId: space.threadId }}
          onFocus={(event) => focusSidebarCommandItem(event.currentTarget)}
          onPointerDown={noteSidebarContextPress}
          onContextMenu={(event) =>
            clearSidebarContextPress(event.currentTarget)
          }
          onClick={(event) => {
            // Lifting the finger after a long press clicks the row; that
            // press opened the menu, so it must not also open the Space.
            if (Date.now() - menuOpenedAt.current < LONG_PRESS_CLICK_MS) {
              event.preventDefault();
              return;
            }
            onLeave();
            onNavigate();
          }}
        >
          <SpaceIcon color={space.color} className="sidebar-space-icon" />
          <strong title={space.name}>
            <span className="thread-row-title-text">{space.name}</span>
          </strong>
          <SpaceStatus space={space} className="sidebar-space-status" />
          {space.members.length > 1 ? (
            <ParticipantStack
              participants={space.members.map((member) => ({
                userId: member.userId,
                name: member.name,
                ...(member.avatarUrl === undefined
                  ? {}
                  : { image: member.avatarUrl }),
              }))}
            />
          ) : null}
          <SpaceRowAge space={space} />
        </Link>
      </div>
    </RowContextMenu>
  );
}

/**
 * The sidebar's Spaces section, above the Threads: the Spaces the person
 * created or joined, with Discover Spaces and New Space. `dictation` gives
 * New Space's goal the composer's mic, and `PlanPicker` its Agent row the
 * composer's Claude plan list.
 */
export function SidebarSpacesSection({
  onNavigate,
  dictation,
  PlanPicker,
}: {
  readonly onNavigate: () => void;
  readonly dictation?: DictationSlot;
  readonly PlanPicker?: ClaudePlanPickerSlot;
}) {
  const userId = useAuthenticatedIdentity().identity.id;
  const spacesQuery = useQuery(joinedSpacesQueryOptions(userId));
  const pathname = useLocation({ select: (location) => location.pathname });
  const [dialog, setDialog] = React.useState<SpacesDialog>();
  const archive = useOptionalThreadArchive();
  const join = useSetSpaceJoined(userId);
  const navigate = useNavigate();
  /** What the person may do to one of their Spaces from its row. */
  const actionsFor = (space: SpaceData): SpaceRowActions => {
    if (space.access !== "owner")
      return {
        onLeave: () =>
          join.mutate(
            { threadId: space.threadId, joined: false },
            {
              onError: () => toast.error("You could not leave the Space."),
            },
          ),
      };
    const active = space.lifecycleState === "active";
    return {
      ...(active ? { onEdit: () => setDialog({ kind: "edit", space }) } : {}),
      ...(active && archive !== undefined
        ? { onArchive: () => archive.setArchived(space.threadId, true) }
        : {}),
      onDelete: () => setDialog({ kind: "delete", space }),
    };
  };
  const [collapsed, setCollapsed] = React.useState(false);
  const [hover, setHover] = React.useState<HoverCardAt>();
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const showCard = (threadId: string, row: HTMLElement) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const rect = row.getBoundingClientRect();
      setHover({ threadId, top: rect.top, left: rect.right + 6 });
    }, HOVER_CARD_DELAY_MS);
  };
  const hideCard = () => {
    clearTimeout(hoverTimer.current);
    setHover(undefined);
  };
  const spaces = spacesQuery.data ?? [];
  const hovered =
    hover === undefined
      ? undefined
      : spaces.find((space) => space.threadId === hover.threadId);
  const listed = spaces.length > 0;
  return (
    <section
      className="thread-project-group sidebar-spaces"
      aria-label="Spaces"
      data-listed={listed ? "" : undefined}
    >
      <div className="thread-group-heading-row">
        {listed ? (
          <button
            type="button"
            className="thread-group-heading"
            data-collapsed={collapsed || undefined}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span>Spaces</span>
            <i />
            <span className="thread-group-meta">
              <small>{spaces.length}</small>
              {collapsed ? null : <ChevronDown aria-hidden="true" />}
            </span>
          </button>
        ) : (
          <h2 className="thread-group-heading">
            <span>Spaces</span>
            <i />
          </h2>
        )}
        <Button
          variant="subtle"
          size="icon-2xs"
          className="thread-group-action"
          aria-label="Discover Spaces"
          title="Discover Spaces"
          onClick={() => setDialog("discover")}
        >
          <Compass aria-hidden="true" />
        </Button>
        <Button
          variant="subtle"
          size="icon-2xs"
          className="thread-group-action"
          aria-label="New Space"
          title="New Space"
          onClick={() => setDialog("create")}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      {spacesQuery.isError ? (
        <div className="sidebar-empty" role="alert">
          Could not load Spaces.
        </div>
      ) : spacesQuery.isSuccess && !listed ? (
        <div className="sidebar-empty sidebar-spaces-empty">
          Start or join a Space to see it here.
        </div>
      ) : collapsed ? null : (
        spaces.map((space) => (
          <SidebarSpaceRow
            key={space.threadId}
            space={space}
            selected={pathname === `/threads/${space.threadId}`}
            actions={actionsFor(space)}
            onNavigate={onNavigate}
            onHover={showCard}
            onLeave={hideCard}
          />
        ))
      )}
      {hover === undefined || hovered === undefined ? null : (
        <SpaceHoverCard space={hovered} at={hover} />
      )}
      <React.Suspense fallback={null}>
        {dialog === "create" ? (
          <CreateSpaceDialog
            userId={userId}
            dictation={dictation}
            PlanPicker={PlanPicker}
            onClose={() => setDialog(undefined)}
            onCreated={() => {
              setDialog(undefined);
              onNavigate();
            }}
          />
        ) : null}
        {dialog === "discover" ? (
          <DiscoverSpacesDialog
            userId={userId}
            onClose={() => setDialog(undefined)}
            onCreate={() => setDialog("create")}
            onOpened={() => {
              setDialog(undefined);
              onNavigate();
            }}
          />
        ) : null}
        {typeof dialog === "object" && dialog.kind === "edit" ? (
          <EditSpaceDialog
            space={dialog.space}
            userId={userId}
            dictation={dictation}
            onClose={() => setDialog(undefined)}
          />
        ) : null}
        {typeof dialog === "object" && dialog.kind === "delete" ? (
          <DeleteSpaceDialog
            space={dialog.space}
            onClose={() => setDialog(undefined)}
            onDeleted={() => {
              // Its page went with it: open home instead.
              if (pathname === `/threads/${dialog.space.threadId}`)
                void navigate({ to: "/" });
            }}
          />
        ) : null}
      </React.Suspense>
    </section>
  );
}
