import type { SpaceData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Compass, Plus } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import { ParticipantStack } from "../../shared/ui/avatar.js";
import {
  compactAge,
  epochOf,
  spaceStatusText,
  updatedAgo,
} from "./space-format.js";
import { SpaceIcon } from "./space-icon.js";
import { joinedSpacesQueryOptions } from "./space-queries.js";
import "./spaces.css";

// The dialogs load when one first opens: the sidebar is on the Thread page's
// first load, and its budget.
const CreateSpaceDialog = React.lazy(() =>
  import("./create-space-dialog.js").then((module) => ({
    default: module.CreateSpaceDialog,
  })),
);
const DiscoverSpacesDialog = React.lazy(() =>
  import("./discover-spaces-dialog.js").then((module) => ({
    default: module.DiscoverSpacesDialog,
  })),
);

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

/** One Space: its colored mark, name, who is in it, and when it was active. */
function SidebarSpaceRow({
  space,
  selected,
  onNavigate,
  onHover,
  onLeave,
}: {
  readonly space: SpaceData;
  readonly selected: boolean;
  readonly onNavigate: () => void;
  readonly onHover: (threadId: string, row: HTMLElement) => void;
  readonly onLeave: () => void;
}) {
  return (
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
        onClick={() => {
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
  );
}

/**
 * The sidebar's Spaces section, above the Threads: the Spaces the person
 * created or joined, with Discover Spaces and New Space. `dictation` gives
 * New Space's goal the composer's mic.
 */
export function SidebarSpacesSection({
  onNavigate,
  dictation,
}: {
  readonly onNavigate: () => void;
  readonly dictation?: DictationSlot;
}) {
  const userId = useAuthenticatedIdentity().identity.id;
  const spacesQuery = useQuery(joinedSpacesQueryOptions(userId));
  const pathname = useLocation({ select: (location) => location.pathname });
  const [dialog, setDialog] = React.useState<"create" | "discover">();
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
        <button
          type="button"
          className="thread-group-action"
          aria-label="Discover Spaces"
          title="Discover Spaces"
          onClick={() => setDialog("discover")}
        >
          <Compass aria-hidden="true" />
        </button>
        <button
          type="button"
          className="thread-group-action"
          aria-label="New Space"
          title="New Space"
          onClick={() => setDialog("create")}
        >
          <Plus aria-hidden="true" />
        </button>
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
      </React.Suspense>
    </section>
  );
}
