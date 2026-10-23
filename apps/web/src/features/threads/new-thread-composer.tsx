import type {
  ChoicesData,
  GraphData,
  OrbResolvedProvider,
  ProjectData,
} from "@dx/api";
import type {
  ClaudeCodeEffort,
  ModeId,
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
  RunnerProviderPresentation,
} from "@dx/domain";
import type * as React from "react";
import { useComposerEnterKey } from "./composer-enter-key.js";
import { type PendingAttachment, pastedFiles } from "./image-attachments.js";
import {
  AttachmentMenu,
  ImagePreviews,
  useAttachmentsUploading,
} from "./image-attachments-ui.js";
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
  runnerProviders,
  runnerOrbs,
  runnerProfileId,
  runnerProfileLoading,
  allowedRunnerProfileIds,
  onRunnerProfileChange,
  onRunnerProfileRetry,
  onConnectOrbProvider,
  profile,
  onProfileChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  choices,
  routingGraph,
  dictationControls,
  dictationActive,
  dictationHideSubmit,
  footer,
}: {
  readonly prompt: string;
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly submitting: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onRemoveImage: (image: PendingAttachment) => void;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly onScreenshot: () => void;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly projectId: ProjectId | "";
  readonly onProjectChange: (projectId: ProjectId | "") => void;
  readonly hasMoreProjects?: boolean;
  readonly loadingMoreProjects?: boolean;
  readonly onLoadMoreProjects: () => void;
  readonly runnerProfiles?: ReadonlyArray<RunnerProfile>;
  readonly runnerProviders?: ReadonlyArray<RunnerProviderPresentation>;
  readonly runnerOrbs?: ReadonlyArray<OrbResolvedProvider>;
  readonly runnerProfileId?: RunnerProfileId;
  readonly runnerProfileLoading: boolean;
  readonly allowedRunnerProfileIds?: ReadonlyArray<RunnerProfileId> | null;
  readonly onRunnerProfileChange: (runnerProfileId: RunnerProfileId) => void;
  readonly onRunnerProfileRetry?: () => void;
  readonly onConnectOrbProvider?: () => void;
  readonly profile: ModeId;
  readonly onProfileChange: (profile: ModeId) => void;
  readonly model?: string;
  readonly onModelChange: (model: string | undefined) => void;
  readonly effort?: ClaudeCodeEffort;
  readonly onEffortChange?: (effort: ClaudeCodeEffort) => void;
  readonly choices?: ChoicesData;
  readonly routingGraph?: GraphData;
  readonly dictationControls?: React.ReactNode;
  readonly dictationActive: boolean;
  readonly dictationHideSubmit: boolean;
  readonly footer: React.ReactNode;
}) {
  const uploading = useAttachmentsUploading(images);
  const enterKey = useComposerEnterKey();
  const dropTarget = useImageDropTarget({
    disabled: submitting || uploading,
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
          onPaste={(event) => {
            const files = pastedFiles(event);
            if (files.length === 0 || submitting || uploading) return;
            event.preventDefault();
            onFiles(files);
          }}
          onKeyDown={(event) => {
            if (enterKey.sends(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Write prompt…"
          aria-label="Prompt"
          enterKeyHint={enterKey.enterKeyHint}
        />
        <div className="new-thread-attachment-row">
          <AttachmentMenu
            disabled={submitting || uploading}
            onFiles={onFiles}
            onScreenshot={onScreenshot}
          />
          <ImagePreviews
            images={images}
            onRemove={onRemoveImage}
            disabled={submitting}
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
        effort={effort}
        choices={choices}
        routingGraph={routingGraph}
        locked={submitting}
        submitting={submitting}
        ready={!uploading && Boolean(prompt.trim() || images.length > 0)}
        retrying={false}
        onProjectChange={onProjectChange}
        runnerProfiles={runnerProfiles}
        runnerProviders={runnerProviders}
        runnerOrbs={runnerOrbs}
        runnerProfileId={runnerProfileId}
        runnerProfileLoading={runnerProfileLoading}
        allowedRunnerProfileIds={allowedRunnerProfileIds}
        onRunnerProfileChange={onRunnerProfileChange}
        onRunnerProfileRetry={onRunnerProfileRetry}
        onConnectOrbProvider={onConnectOrbProvider}
        onProfileChange={onProfileChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        dictationControls={dictationControls}
        dictationActive={dictationActive}
        dictationHideSubmit={dictationHideSubmit}
      />
      {footer}
    </form>
  );
}
