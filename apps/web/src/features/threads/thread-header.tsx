import type { ProjectData, ThreadDetailData } from "@dx/api";
import {
  Bookmark,
  Eye,
  FolderGit2,
  LockKeyhole,
  PanelRight,
  UsersRound,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { Avatar } from "../../shared/ui/avatar.js";
import { Button } from "../../shared/ui/button.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import {
  PendingThreadTitle,
  ThreadTitleText,
} from "../../shared/ui/thread-title.js";
import { ShareDialog } from "./sharing/share-dialog.js";
import { useSetThreadFollowing } from "./sharing/sharing-mutations.js";
import { ThreadParticipants } from "./sharing/thread-participants.js";
import { ThreadMenu } from "./thread-menu.js";
import type { OptimisticThreadCreation } from "./thread-session-registry.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

export function PendingThreadHeader({
  creation,
}: {
  readonly creation: OptimisticThreadCreation;
}) {
  return (
    <header className="thread-title-bar">
      <div className="thread-title-group">
        <strong className="thread-title">
          <PendingThreadTitle />
        </strong>
      </div>
      <div className="thread-header-actions">
        <span
          className="thread-header-chip"
          title={creation.project?.name ?? "No project"}
        >
          <FolderGit2 /> {creation.project?.name ?? "No project"}
        </span>
        <span
          className="thread-header-chip"
          title={`Thinking level: ${creation.profile}`}
        >
          {creation.profile}
        </span>
        <span className="thread-header-chip" title="Privacy: private">
          <LockKeyhole /> Private
        </span>
      </div>
    </header>
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
      {shared ? <UsersRound /> : <LockKeyhole />} {label}
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
  model,
  shareOpen: controlledShareOpen,
  onShareOpenChange,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly rightPaneCollapsed?: boolean;
  readonly onToggleRightPane?: () => void;
  readonly model?: TranscriptViewModel;
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
  const selectionLabel =
    selection.kind === "mode" ? selection.mode : selection.model;
  const selectionTitle =
    selection.kind === "mode"
      ? `Mode: ${selection.mode}`
      : `Model: ${selection.model}`;
  const openShare = own && !archived ? () => setShareOpen(true) : undefined;
  return (
    <header className="thread-title-bar">
      <div className="thread-title-group">
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
          <ThreadTitleText thread={thread} />
        </strong>
        {own ? null : <FollowButton thread={thread} />}
        {model ? (
          <ThreadMenu
            thread={thread}
            project={project}
            model={model}
            onOpenShare={openShare}
          />
        ) : null}
        {archived ? (
          <span className="thread-archived-badge">Archived thread</span>
        ) : null}
      </div>
      <div className="thread-header-actions">
        {thread.sharing !== undefined ||
        (thread.participants?.length ?? 0) > 1 ? (
          <ThreadParticipants
            thread={thread}
            onOpenShare={openShare}
            onEnableMultiplayer={openShare}
          />
        ) : null}
        {own ? (
          openShare === undefined ? null : (
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
          <FolderGit2 /> {projectName ?? "No project"}
        </span>
        <span className="thread-header-chip" title={selectionTitle}>
          {selectionLabel}
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
      </div>
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
