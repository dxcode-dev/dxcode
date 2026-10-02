import type { ChoicesData, GraphData, ProjectData } from "@dx/api";
import type {
  ModeId,
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
} from "@dx/domain";
import type * as React from "react";
import type { PendingImage } from "./image-attachments.js";
import { AttachmentMenu, ImagePreviews } from "./image-attachments-ui.js";
import { useImageDropTarget } from "./image-drop-target.js";
import { NewThreadConfigurationStrip } from "./new-thread-configuration-strip.js";

export function NewThreadComposer({
  prompt,
  images,
  textareaRef,
  submitting,
  onPromptChange,
  onSubmit,
  onRemoveImage,
  onFiles,
  onScreenshot,
  projects,
  projectId,
  onProjectChange,
  hasMoreProjects,
  loadingMoreProjects,
  onLoadMoreProjects,
  runnerProfiles,
  runnerProfileId,
  runnerProfileLoading,
  allowedRunnerProfileIds,
  onRunnerProfileChange,
  onRunnerProfileRetry,
  profile,
  onProfileChange,
  model,
  onModelChange,
  choices,
  routingGraph,
  dictationControls,
  dictationActive,
  dictationHideSubmit,
  footer,
}: {
  readonly prompt: string;
  readonly images: ReadonlyArray<PendingImage>;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly submitting: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onRemoveImage: (image: PendingImage) => void;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly onScreenshot: () => void;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  readonly onProjectChange: (projectId: ProjectId | "") => void;
  readonly hasMoreProjects?: boolean;
  readonly loadingMoreProjects?: boolean;
  readonly onLoadMoreProjects: () => void;
  readonly runnerProfiles?: ReadonlyArray<RunnerProfile>;
  readonly runnerProfileId?: RunnerProfileId;
  readonly runnerProfileLoading: boolean;
  readonly allowedRunnerProfileIds?: ReadonlyArray<RunnerProfileId> | null;
  readonly onRunnerProfileChange: (runnerProfileId: RunnerProfileId) => void;
  readonly onRunnerProfileRetry?: () => void;
  readonly profile: ModeId;
  readonly onProfileChange: (profile: ModeId) => void;
  readonly model?: string;
  readonly onModelChange: (model: string | undefined) => void;
  readonly choices?: ChoicesData;
  readonly routingGraph?: GraphData;
  readonly dictationControls?: React.ReactNode;
  readonly dictationActive: boolean;
  readonly dictationHideSubmit: boolean;
  readonly footer: React.ReactNode;
}) {
  const dropTarget = useImageDropTarget({
    disabled: submitting,
    onFiles,
  });
  return (
    <form
      className="new-thread-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      {...dropTarget}
    >
      <div className="new-thread-composer-body">
        <textarea
          ref={textareaRef}
          value={prompt}
          readOnly={submitting}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Write prompt…"
          aria-label="Prompt"
        />
        <ImagePreviews
          images={images}
          onRemove={onRemoveImage}
          disabled={submitting}
        />
        <div className="new-thread-attachment-row">
          <AttachmentMenu
            disabled={submitting}
            onFiles={onFiles}
            onScreenshot={onScreenshot}
          />
        </div>
      </div>
      <NewThreadConfigurationStrip
        projects={projects}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        onLoadMoreProjects={onLoadMoreProjects}
        projectId={projectId}
        profile={profile}
        model={model}
        choices={choices}
        routingGraph={routingGraph}
        locked={submitting}
        submitting={submitting}
        ready={Boolean(prompt.trim() || images.length > 0)}
        retrying={false}
        onProjectChange={onProjectChange}
        runnerProfiles={runnerProfiles}
        runnerProfileId={runnerProfileId}
        runnerProfileLoading={runnerProfileLoading}
        allowedRunnerProfileIds={allowedRunnerProfileIds}
        onRunnerProfileChange={onRunnerProfileChange}
        onRunnerProfileRetry={onRunnerProfileRetry}
        onProfileChange={onProfileChange}
        onModelChange={onModelChange}
        dictationControls={dictationControls}
        dictationActive={dictationActive}
        dictationHideSubmit={dictationHideSubmit}
      />
      {footer}
    </form>
  );
}
