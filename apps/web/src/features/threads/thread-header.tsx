import type { ProjectData, ThreadDetailData } from "@dx/api";
import { FolderGit2, LockKeyhole, PanelRight, Users } from "lucide-react";
import { EXECUTION_ENVIRONMENT_DISPLAY_NAME } from "../../shared/execution-environment-copy.js";
import { Button } from "../../shared/ui/button.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import {
  PendingThreadTitle,
  ThreadTitleText,
} from "../../shared/ui/thread-title.js";
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
      <strong className="thread-title">
        <PendingThreadTitle />
      </strong>
      <span className="thread-header-metadata">
        <span title={creation.project?.name ?? "No project"}>
          <FolderGit2 /> {creation.project?.name ?? "No project"}
        </span>
        <span title={`Thinking level: ${creation.profile}`}>
          {creation.profile}
        </span>
        <span title="Privacy: private">
          <LockKeyhole /> private
        </span>
      </span>
      <Button
        aria-label="Multiplayer is unavailable in this version"
        aria-disabled="true"
        title="Multiplayer is unavailable in this version"
        variant="ghost"
        size="icon-xs"
      >
        <Users />
      </Button>
    </header>
  );
}

export function ThreadHeader({
  thread,
  project,
  rightPaneCollapsed = false,
  onToggleRightPane,
  model,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly rightPaneCollapsed?: boolean;
  readonly onToggleRightPane?: () => void;
  readonly model?: TranscriptViewModel;
}) {
  const archived = thread.lifecycleState === "archived";
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
  return (
    <header className="thread-title-bar">
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
      <strong
        className="thread-title"
        title={thread.titlePending === true ? undefined : thread.title}
      >
        <ThreadTitleText thread={thread} />
      </strong>
      {archived ? (
        <span className="thread-archived-badge">Archived thread</span>
      ) : null}
      <span className="thread-header-metadata">
        <span title={project?.name ?? "No project"}>
          <FolderGit2 /> {project?.name ?? "No project"}
        </span>
        <span title={selectionTitle}>{selectionLabel}</span>
        <span title={`Privacy: ${thread.visibility}`}>
          <LockKeyhole /> {thread.visibility}
        </span>
      </span>
      <Button
        aria-label="Multiplayer is unavailable in this version"
        aria-disabled="true"
        title="Multiplayer is unavailable in this version"
        variant="ghost"
        size="icon-xs"
      >
        <Users />
      </Button>
      {model ? (
        <ThreadMenu thread={thread} project={project} model={model} />
      ) : null}
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
    </header>
  );
}
