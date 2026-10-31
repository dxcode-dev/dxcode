import { Menu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import { useNavigate } from "@tanstack/react-router";
import { DateTime } from "effect";
import {
  AlarmClock,
  Bookmark,
  CalendarClock,
  CircleCheck,
  CircleDot,
  Eye,
  FolderGit2,
  GitPullRequest,
  LockKeyhole,
  UsersRound,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { useTimeText } from "../../shared/hooks/use-clock.js";
import { threadColorAttributes } from "../../shared/thread-color.js";
import { useOptionalThreadSnooze } from "../../shared/thread-snooze.js";
import { snoozeWakeText } from "../../shared/thread-snooze-presets.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import { ThreadTitleText } from "../../shared/ui/thread-title.js";
import {
  type AutomationView,
  automationViews,
  useThreadAutomations,
} from "./automations/automations-queries.js";
import { ThreadAutomationsButton } from "./automations/thread-automations-button.js";
import { ThreadAutomationsSheet } from "./automations/thread-automations-sheet.js";
import { useThreadLayoutMode } from "./panes/thread-layout-mode.js";
import { ShareDialog } from "./sharing/share-dialog.js";
import { participantsLabel } from "./sharing/sharing-format.js";
import { useSetThreadFollowing } from "./sharing/sharing-mutations.js";
import {
  ThreadParticipants,
  ThreadParticipantsMenuContent,
} from "./sharing/thread-participants.js";
import { ThreadMenu, ThreadMenuSubmenu } from "./thread-menu.js";
import { threadSelectionSummary } from "./thread-selection-summary.js";
import { TitleBarItemSlot } from "./title-bar-item.js";
import { useTitleBarOverflow } from "./title-bar-overflow.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

/** While the Thread sleeps: when it wakes, and Wake to bring it back now. */
function ThreadSnoozeBadge({
  threadId,
  wakeAt,
}: {
  readonly threadId: ThreadDetailData["id"];
  readonly wakeAt: number;
}) {
  const snooze = useOptionalThreadSnooze();
  const until = useTimeText((now) =>
    wakeAt > now ? snoozeWakeText(wakeAt, now) : "",
  );
  if (until === "" || snooze === undefined) return null;
  return (
    <span className="thread-snoozed-badge">
      <AlarmClock aria-hidden="true" />
      <span className="thread-snoozed-label" title={`Snoozed until ${until}`}>
        <span className="thread-snoozed-prefix">Snoozed until </span>
        {until}
      </span>
      <button
        type="button"
        disabled={snooze.pendingThreadId === threadId}
        onClick={() => snooze.wake(threadId)}
      >
        Wake
      </button>
    </span>
  );
}

/** The privacy badge: who can see the Thread; opens Share for the owner. */
function PrivacyBadge({
  thread,
  onOpenShare,
}: {
  readonly thread: ThreadDetailData;
  readonly onOpenShare?: () => void;
}) {
  const shared = thread.sharing !== undefined;
  const label = shared ? "Workspace" : "Private";
  const title = shared
    ? thread.sharing?.workspaceAccess === "contribute"
      ? "Shared with your workspace: members can contribute"
      : "Shared with your workspace: members can view"
    : "Only you can see this thread";
  return onOpenShare === undefined ? (
    <span
      className="thread-privacy-badge"
      title={title}
      data-privacy={thread.visibility}
    >
      {shared ? (
        <UsersRound aria-hidden="true" />
      ) : (
        <LockKeyhole aria-hidden="true" />
      )}
      {label}
    </span>
  ) : (
    <button
      type="button"
      className="thread-privacy-badge thread-privacy-badge-button"
      title={`${title}. Share…`}
      aria-label={`Share: ${label}. ${title}`}
      data-privacy={thread.visibility}
      onClick={onOpenShare}
    >
      {shared ? (
        <UsersRound aria-hidden="true" />
      ) : (
        <LockKeyhole aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

/**
 * The Thread's title bar: the animated Orb and the title, then More Actions
 * on the left; on the right the Project, pull requests, checks and listeners,
 * the agent, who is in a shared Thread, the privacy badge (which opens
 * Share), and Views. Below 1024px the labels go and the controls are icons;
 * the Project and agent move into More Actions, and the controls the bar
 * has no room for (the privacy badge first, then the people, listeners,
 * checks, and pull requests) follow them there, so the bar never widens
 * the page. The title keeps at least its minimum width and elides.
 */
export function ThreadHeader({
  thread,
  project,
  transcript,
  shareOpen: controlledShareOpen,
  onShareOpenChange,
  views,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  /** Reads the shown transcript, for an export. */
  readonly transcript?: () => TranscriptViewModel;
  /** The Share dialog, when the Thread page also opens it (from `@`). */
  readonly shareOpen?: boolean;
  readonly onShareOpenChange?: (open: boolean) => void;
  /** The Views button, when the page lays out in panes. */
  readonly views?: React.ReactNode;
}) {
  const [localShareOpen, setLocalShareOpen] = React.useState(false);
  const shareOpen = controlledShareOpen ?? localShareOpen;
  const setShareOpen = onShareOpenChange ?? setLocalShareOpen;
  const archived = thread.lifecycleState === "archived";
  const own = thread.access === undefined || thread.access === "owner";
  const owner = thread.participants?.find((person) => person.owner);
  const ownerName = owner?.name;
  const projectName = project?.name ?? thread.projectName;
  const activityStatus = archived ? "idle" : thread.activityStatus;
  const environmentState = archived
    ? "paused"
    : activityStatus === "working"
      ? "working"
      : "idle";
  const selection = thread.agentInitialization.selection;
  const summary = threadSelectionSummary(selection);
  const selectionLabel =
    selection.kind === "model" && summary.kind === "model"
      ? selection.model
      : summary.label;
  const openShare = own && !archived ? () => setShareOpen(true) : undefined;
  const { compact } = useThreadLayoutMode();
  const navigate = useNavigate();
  const shared =
    thread.sharing !== undefined || (thread.participants?.length ?? 0) > 1;
  // A compact bar measures its optional controls and lists the ones that
  // do not fit in More Actions, where the automations open as sheets.
  const { barRef, titleGroupRef, actionsRef, itemRef, hidden } =
    useTitleBarOverflow();
  const [sheet, setSheet] = React.useState<AutomationView | undefined>();
  const automations = useThreadAutomations(thread.id, own && compact).data;
  const overflowItems =
    hidden.size === 0
      ? undefined
      : [
          ...automationViews(automations).flatMap(({ view, label }) =>
            hidden.has(view)
              ? [
                  <Menu.Item
                    key={view}
                    className="thread-menu-item"
                    onClick={() => setSheet(view)}
                  >
                    {view === "issues" ? (
                      <CircleDot />
                    ) : view === "pulls" ? (
                      <GitPullRequest />
                    ) : view === "ci" ? (
                      <CircleCheck />
                    ) : (
                      <CalendarClock />
                    )}
                    <span>{label}</span>
                  </Menu.Item>,
                ]
              : [],
          ),
          ...(hidden.has("participants") && shared
            ? [
                <ThreadMenuSubmenu
                  key="participants"
                  icon={<UsersRound />}
                  label={participantsLabel(thread.participants?.length ?? 0, 0)}
                  popupClassName="thread-participants-menu"
                >
                  <ThreadParticipantsMenuContent
                    thread={thread}
                    onOpenShare={openShare}
                    onEnableMultiplayer={openShare}
                  />
                </ThreadMenuSubmenu>,
              ]
            : []),
        ];
  const menu = transcript ? (
    <ThreadMenu
      thread={thread}
      project={project}
      transcript={transcript}
      onOpenShare={compact ? openShare : undefined}
      overflowItems={
        overflowItems === undefined || overflowItems.length === 0
          ? undefined
          : overflowItems
      }
      showDetails={compact}
    />
  ) : null;
  const orbLabel = `${EXECUTION_ENVIRONMENT_DISPLAY_NAME} ${environmentState}`;
  return (
    <header
      className="thread-title-bar"
      data-compact={compact || undefined}
      ref={compact ? barRef : undefined}
    >
      <div
        className="thread-title-group"
        ref={titleGroupRef}
        {...threadColorAttributes(thread)}
      >
        {own ? null : <FollowButton thread={thread} />}
        {own || owner === undefined ? null : (
          <span className="thread-title-owner" title={owner.name}>
            <Avatar name={owner.name} image={owner.image} seed={owner.userId} />
          </span>
        )}
        <span className="thread-title-icon" title={orbLabel}>
          <OrbIcon
            activityStatus={activityStatus}
            aria-hidden="false"
            aria-label={orbLabel}
          />
        </span>
        <strong
          className="thread-title"
          title={thread.titlePending === true ? undefined : thread.title}
        >
          <ThreadTitleText thread={thread} maxCharacters={60} />
        </strong>
        {archived ? (
          <span className="thread-archived-badge">
            {compact ? "Archived" : "Archived thread"}
          </span>
        ) : own && thread.snoozedUntil !== undefined ? (
          <ThreadSnoozeBadge
            threadId={thread.id}
            wakeAt={DateTime.toEpochMillis(thread.snoozedUntil)}
          />
        ) : null}
      </div>
      <div className="thread-title-actions" ref={actionsRef}>
        {compact ? null : <span className="thread-title-menu">{menu}</span>}
        <span className="thread-title-spacer" />
        {compact ? null : own ? (
          <button
            type="button"
            className="thread-title-action thread-title-action-text thread-title-project"
            title={projectName ?? "No project"}
            aria-label={`Project ${projectName ?? "No project"}`}
            onClick={() =>
              void navigate({
                to: "/projects/$projectId",
                params: { projectId: thread.projectId },
              })
            }
          >
            <FolderGit2 aria-hidden="true" />
            <span>{projectName ?? "No project"}</span>
          </button>
        ) : (
          <span
            className="thread-title-action thread-title-action-text thread-title-project"
            title={projectName ?? "No project"}
          >
            <FolderGit2 aria-hidden="true" />
            <span>{projectName ?? "No project"}</span>
          </span>
        )}
        {own ? (
          <ThreadAutomationsButton
            threadId={thread.id}
            itemRef={itemRef}
            hidden={hidden}
          />
        ) : null}
        {compact ? null : (
          <span className="thread-title-meta" title={summary.title}>
            {selectionLabel}
          </span>
        )}
        {shared ? (
          <TitleBarItemSlot id="participants" itemRef={itemRef} hidden={hidden}>
            <ThreadParticipants
              thread={thread}
              onOpenShare={openShare}
              onEnableMultiplayer={openShare}
            />
          </TitleBarItemSlot>
        ) : null}
        {own ? (
          <TitleBarItemSlot id="privacy" itemRef={itemRef} hidden={hidden}>
            <PrivacyBadge thread={thread} onOpenShare={openShare} />
          </TitleBarItemSlot>
        ) : (
          <span
            className="thread-access-chip"
            data-access={thread.access}
            title={
              thread.access === "view"
                ? `Shared by ${ownerName ?? "the owner"} for viewing`
                : `Shared by ${ownerName ?? "the owner"}: messages run as them`
            }
          >
            {thread.access === "view" ? <Eye /> : <UsersRound />}
            {compact
              ? null
              : thread.access === "view"
                ? "View only"
                : "Contributor"}
          </span>
        )}
        {views}
        {compact ? <span className="thread-title-menu">{menu}</span> : null}
      </div>
      {shareOpen && own && !archived ? (
        <ShareDialog
          thread={thread}
          ownerName={ownerName}
          open
          onOpenChange={setShareOpen}
        />
      ) : null}
      {sheet === undefined ? null : (
        <ThreadAutomationsSheet
          threadId={thread.id}
          view={sheet}
          onClose={() => setSheet(undefined)}
        />
      )}
    </header>
  );
}

/**
 * Follow a shared Thread to keep it in the sidebar under its Project. Opening
 * it or being tagged in it follows it.
 */
function FollowButton({ thread }: { readonly thread: ThreadDetailData }) {
  const { identity } = useAuthenticatedIdentity();
  const follow = useSetThreadFollowing(identity.id, thread.id);
  const following = follow.isPending
    ? follow.variables
    : thread.following === true;
  const label = following ? "Unfollow thread" : "Follow thread";
  return (
    <Button
      className="thread-follow-button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={following}
      title={label}
      disabled={follow.isPending}
      onClick={() => follow.mutate(!following)}
    >
      <Bookmark fill={following ? "currentColor" : "none"} />
    </Button>
  );
}
