import type { SpaceData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useNavigate } from "@tanstack/react-router";
import { Columns2, Maximize2, PanelRightOpen, X } from "lucide-react";
import type * as React from "react";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { SpaceIcon } from "./space-icon.js";
import {
  SpaceAgentChip,
  SpaceAutomationChips,
  SpaceCallAndSharing,
  SpacePanelMenu,
  SpaceProjectChip,
} from "./space-panel.js";
import type { ThreadTabThread } from "./space-tab-threads.js";

/**
 * A pane's tab strip: the Space chat tab, any open thread's tab, and the
 * tools on its right. It stands where a Thread's title bar would.
 */
export function SpaceTabStrip({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-tab-strip" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

/** The Space chat's tab: the Space's colored mark and its name. */
export function SpaceChatTab({
  space,
  active,
  onSelect,
}: {
  readonly space: SpaceData;
  readonly active: boolean;
  /** Shows the chat when a thread's tab shares the strip. */
  readonly onSelect?: () => void;
}) {
  const content = (
    <>
      <SpaceIcon color={space.color} className="space-tab-icon" />
      <span className="space-tab-title">{space.name}</span>
    </>
  );
  return onSelect === undefined || active ? (
    <span
      className="space-tab"
      data-active={active ? "" : undefined}
      data-tab="space"
      aria-current={active ? "page" : undefined}
      title={space.name}
    >
      {content}
    </span>
  ) : (
    <button
      type="button"
      className="space-tab"
      data-tab="space"
      title={space.name}
      onClick={onSelect}
    >
      {content}
    </button>
  );
}

/**
 * An open thread's tab: its status and title, its More Actions while it
 * shows, and Close.
 */
export function ThreadTab({
  thread,
  active,
  menu,
  onSelect,
  onClose,
}: {
  readonly thread: ThreadTabThread;
  readonly active: boolean;
  readonly menu?: React.ReactNode;
  readonly onSelect?: () => void;
  readonly onClose: () => void;
}) {
  const head = (
    <>
      <span className="space-tab-icon space-tab-status">
        <OrbIcon
          staticWhenIdle
          activityStatus={thread.working ? "working" : "idle"}
        />
      </span>
      <span className="space-tab-title">{thread.title}</span>
    </>
  );
  return (
    <span
      className="space-tab space-thread-tab"
      data-active={active ? "" : undefined}
      data-tab="thread"
      title={thread.title}
      {...thread.colors}
    >
      {active || onSelect === undefined ? (
        <span
          className="space-tab-head"
          aria-current={active ? "page" : undefined}
        >
          {head}
        </span>
      ) : (
        <button type="button" className="space-tab-head" onClick={onSelect}>
          {head}
        </button>
      )}
      {active && menu !== undefined ? (
        <span className="space-tab-menu">{menu}</span>
      ) : null}
      <button
        type="button"
        className="space-tab-close"
        aria-label={`Close ${thread.title}`}
        title="Close Tab"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * The open thread's issues, pull requests, CI, and listeners, its Views,
 * what it runs on, Side by Side, and Focus Thread (its own
 * page).
 */
export function ThreadTabTools({
  threadId,
  automations,
  views,
  mode,
  split,
  onToggleSplit,
}: {
  readonly threadId: ThreadId;
  /** Its issues, pull requests, CI, and listeners, as its title bar shows them. */
  readonly automations?: React.ReactNode;
  /** The Thread page's Views button: Terminal, Changes, Artifacts, … */
  readonly views: React.ReactNode;
  /** What the thread runs on, as a Thread's title bar shows it. */
  readonly mode: { readonly label: string; readonly title: string } | undefined;
  readonly split: boolean;
  /** Absent where the page is too narrow for two panes. */
  readonly onToggleSplit?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <span className="space-tab-tools">
      {automations}
      {views}
      {mode === undefined ? null : (
        <span className="space-tab-mode" title={mode.title}>
          {mode.label}
        </span>
      )}
      {onToggleSplit === undefined ? null : (
        <button
          type="button"
          className="space-icon-button"
          aria-label="Side by Side"
          title={split ? "Show as Tabs" : "Show Side by Side"}
          aria-pressed={split}
          onClick={onToggleSplit}
        >
          <Columns2 aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="space-icon-button"
        aria-label="Focus Thread"
        title="Focus Thread"
        onClick={() =>
          void navigate({ to: "/threads/$threadId", params: { threadId } })
        }
      >
        <Maximize2 aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * While Space Details is hidden, its quick parts sit at the strip's end:
 * the Project, the Space's issues, pull requests, CI, and listeners, what
 * its agent runs on, Huddle, sharing, Space Actions, and Show Space Details.
 * A phone's strip lists the issues and the rest in Space Actions instead.
 */
export function SpaceStripTools({
  space,
  userId,
  compact,
  menu = false,
  onEdit,
  onDelete,
  onArchive,
  onShow,
}: {
  readonly space: SpaceData;
  readonly userId: Parameters<typeof SpacePanelMenu>[0]["userId"];
  /**
   * A phone's strip: Space Actions, when `menu` is set, and Show Space
   * Details.
   */
  readonly compact: boolean;
  /** Keeps Space Actions on a phone's strip, as a Thread keeps More Actions. */
  readonly menu?: boolean;
  readonly onEdit?: () => void;
  readonly onDelete?: () => void;
  readonly onArchive?: () => void;
  readonly onShow: () => void;
}) {
  return (
    <span className="space-tab-tools">
      {compact ? null : (
        <>
          <SpaceProjectChip space={space} />
          <SpaceAutomationChips space={space} />
          <SpaceAgentChip space={space} />
          <SpaceCallAndSharing space={space} onShare={onEdit} />
        </>
      )}
      {compact && !menu ? null : (
        <SpacePanelMenu
          space={space}
          userId={userId}
          automations={compact}
          onEdit={onEdit}
          onDelete={onDelete}
          onArchive={onArchive}
        />
      )}
      <button
        type="button"
        className="space-icon-button space-details-toggle"
        aria-label={
          space.waitingOnInput
            ? "Show Space Details, needs input"
            : "Show Space Details"
        }
        title={
          space.waitingOnInput
            ? "Show Space Details: the Space needs input"
            : "Show Space Details"
        }
        data-waiting={space.waitingOnInput ? "" : undefined}
        onClick={onShow}
      >
        <PanelRightOpen aria-hidden="true" />
        {space.waitingOnInput ? (
          <span className="space-needs-input-dot" aria-hidden="true" />
        ) : null}
      </button>
    </span>
  );
}
