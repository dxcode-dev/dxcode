import type { ProjectData, ThreadDetailData } from "@dx/api";
import { DateTime } from "effect";
import {
  AlarmClock,
  Bookmark,
  Eye,
  FolderGit2,
  LockKeyhole,
  PanelRight,
  Share,
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
import { useMobile } from "../../shared/use-mobile.js";
import {
  type AutomationView,
  automationViews,
  useThreadAutomations,
} from "./automations/automations-queries.js";
import { ThreadAutomationsButton } from "./automations/thread-automations-button.js";
import { ThreadAutomationsSheet } from "./automations/thread-automations-sheet.js";
import { ShareDialog } from "./sharing/share-dialog.js";
import { useSetThreadFollowing } from "./sharing/sharing-mutations.js";
import { ThreadParticipants } from "./sharing/thread-participants.js";
import { ThreadMenu } from "./thread-menu.js";
import { threadSelectionSummary } from "./thread-selection-summary.js";
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

function PrivacyChip({
  thread,
  onOpenShare,
}: {
  readonly thread: ThreadDetailData;
  readonly onOpenShare?: () => void;
}) {
  const shared = thread.sharing !== undefined;
  const label = shared ? "Workspace" : "Private";
  const content = (
    <>
      {shared ? <UsersRound /> : <LockKeyhole />}
      <span className="thread-header-chip-label">{label}</span>
    </>
  );
  const title = shared
    ? thread.sharing?.workspaceAccess === "contribute"
      ? "Shared with your workspace: members can contribute"
      : "Shared with your workspace: members can view"
    : "Only you can see this thread";
  return onOpenShare === undefined ? (
    <span
      className="thread-header-chip"
      title={title}
      data-privacy={thread.visibility}
    >
      {content}
    </span>
  ) : (
    <button
      type="button"
      className="thread-header-chip thread-header-chip-button"
      title={title}
      aria-label={`Privacy: ${label}. ${title}`}
      data-privacy={thread.visibility}
      onClick={onOpenShare}
    >
      {content}
    </button>
  );
}

export function ThreadHeader({
  thread,
  project,
  rightPaneCollapsed = false,
  onToggleRightPane,
  transcript,
  shareOpen: controlledShareOpen,
  onShareOpenChange,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly rightPaneCollapsed?: boolean;
  readonly onToggleRightPane?: () => void;
  /** Reads the shown transcript, for an export. */
  readonly transcript?: () => TranscriptViewModel;
  /** The Share dialog, when the Thread page also opens it (from `@`). */
  readonly shareOpen?: boolean;
  readonly onShareOpenChange?: (open: boolean) => void;
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
  // A phone has no room for the chips: the Thread menu shows the model and
  // Project instead, and sits at the bar's end after an icon-only Share.
  const mobile = useMobile();
  // Schedules and GitHub listeners are the owner's. A phone reaches them
  // from the Thread menu, which opens them as a sheet.
  const [automationsView, setAutomationsView] = React.useState<
    AutomationView | undefined
  >(undefined);
  const mobileAutomations = automationViews(
    useThreadAutomations(thread.id, own && mobile).data,
  );
  const menu = transcript ? (
    <ThreadMenu
      thread={thread}
      project={project}
      transcript={transcript}
      onOpenShare={openShare}
      automationViews={mobileAutomations}
      onOpenAutomations={own && mobile ? setAutomationsView : undefined}
      showDetails={mobile}
    />
  ) : null;
  return (
    <header className="thread-title-bar">
      <div className="thread-title-group" {...threadColorAttributes(thread)}>
        <span
          className="thread-title-orb"
          title={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} ${environmentState}`}
        >
          <OrbIcon
            activityStatus={activityStatus}
            aria-hidden="false"
            aria-label={`${EXECUTION_ENVIRONMENT_DISPLAY_NAME} ${environmentState}`}
          />
        </span>
        {own || owner === undefined ? null : (
          <span className="thread-title-owner" title={owner.name}>
            <Avatar name={owner.name} image={owner.image} seed={owner.userId} />
          </span>
        )}
        <strong
          className="thread-title"
          title={thread.titlePending === true ? undefined : thread.title}
        >
          <ThreadTitleText thread={thread} maxCharacters={60} />
        </strong>
        {own ? null : <FollowButton thread={thread} />}
        {mobile ? null : menu}
        {archived ? (
          <span className="thread-archived-badge">
            {mobile ? "Archived" : "Archived thread"}
          </span>
        ) : own && thread.snoozedUntil !== undefined ? (
          <ThreadSnoozeBadge
            threadId={thread.id}
            wakeAt={DateTime.toEpochMillis(thread.snoozedUntil)}
          />
        ) : null}
      </div>
      <div className="thread-header-actions">
        {own && !mobile ? (
          <ThreadAutomationsButton threadId={thread.id} />
        ) : null}
        {thread.sharing !== undefined ||
        (thread.participants?.length ?? 0) > 1 ? (
          <ThreadParticipants
            thread={thread}
            onOpenShare={openShare}
            onEnableMultiplayer={openShare}
          />
        ) : null}
        {own ? (
          openShare === undefined ? null : mobile ? (
            <Button
              className="thread-share-button thread-share-icon-button"
              aria-label="Share"
              title="Share"
              variant="ghost"
              size="icon-xs"
              onClick={openShare}
            >
              <Share />
            </Button>
          ) : (
            <Button
              className="thread-share-button"
              variant="ghost"
              size="xs"
              onClick={openShare}
            >
              Share
            </Button>
          )
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
            {thread.access === "view" ? "View only" : "Contributor"}
          </span>
        )}
        <span
          className="thread-header-chip"
          title={projectName ?? "No project"}
        >
          <FolderGit2 />
          <span className="thread-header-chip-label">
            {projectName ?? "No project"}
          </span>
        </span>
        <span className="thread-header-chip" title={summary.title}>
          <span className="thread-header-chip-label">{selectionLabel}</span>
        </span>
        <PrivacyChip thread={thread} onOpenShare={openShare} />
        {onToggleRightPane ? (
          <Button
            className="thread-right-pane-toggle"
            aria-controls="thread-right-pane"
            aria-expanded={!rightPaneCollapsed}
            aria-label={
              rightPaneCollapsed ? "Show Right Pane" : "Hide Right Pane"
            }
            variant="ghost"
            size="icon-xs"
            onClick={onToggleRightPane}
          >
            <PanelRight />
          </Button>
        ) : null}
        {mobile ? menu : null}
      </div>
      {automationsView !== undefined && own && mobile ? (
        <ThreadAutomationsSheet
          threadId={thread.id}
          view={automationsView}
          onClose={() => setAutomationsView(undefined)}
        />
      ) : null}
      {shareOpen && own && !archived ? (
        <ShareDialog
          thread={thread}
          ownerName={ownerName}
          open
          onOpenChange={setShareOpen}
        />
      ) : null}
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
