import type {
  ChoicesData,
  GraphData,
  OrbResolvedProvider,
  PluginAgentModeData,
  PluginThreadTypeOption,
  ProjectData,
  ThreadMemberData,
} from "@dx/api";
import type {
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
  RunnerProviderPresentation,
  ThinkingLevel,
  ThreadVisibility,
} from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { newThreadOrbProvidersQueryOptions } from "../settings/orb-providers/orb-providers-queries.js";
import { useComposerEnterKey } from "./composer-enter-key.js";
import { newThreadSetupGaps } from "./composer-readiness.js";
import { NewThreadSetupNotice } from "./composer-setup-notice.js";
import { type PendingAttachment, pastedFiles } from "./image-attachments.js";
import {
  AttachmentMenu,
  ImagePreviews,
  useAttachmentsUploading,
} from "./image-attachments-ui.js";
import { useImageDropTarget } from "./image-drop-target.js";
import { RECOMMENDED_MODE } from "./model-picker-options.js";
import { NewThreadConfigurationStrip } from "./new-thread-configuration-strip.js";
import { useNewThreadMentions } from "./new-thread-mentions.js";

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
  model,
  onModelChange,
  effort,
  onEffortChange,
  claudePlan,
  onClaudePlanChange,
  pluginAgentModes,
  pluginAgentMode,
  onPluginAgentModeChange,
  pluginThreadTypes,
  pluginThreadType,
  onPluginThreadTypeChange,
  choices,
  routingGraph,
  dictationControls,
  dictationActive,
  dictationHideSubmit,
  visibility,
  onVisibilityChange,
  mentionMembers,
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
  /** The picked model; undefined is Recommended. */
  readonly model?: string;
  readonly onModelChange: (model: string | undefined) => void;
  /** The picked effort; undefined is the model's own default. */
  readonly effort?: ThinkingLevel;
  readonly onEffortChange?: (effort: ThinkingLevel) => void;
  readonly claudePlan?: string;
  readonly onClaudePlanChange?: (connectionId: string | undefined) => void;
  readonly pluginAgentModes?: ReadonlyArray<PluginAgentModeData>;
  readonly pluginAgentMode?: string;
  readonly onPluginAgentModeChange?: (mode: string | undefined) => void;
  readonly pluginThreadTypes?: ReadonlyArray<PluginThreadTypeOption>;
  readonly pluginThreadType?: string;
  readonly onPluginThreadTypeChange?: (type: string | undefined) => void;
  readonly choices?: ChoicesData;
  readonly routingGraph?: GraphData;
  readonly dictationControls?: React.ReactNode;
  readonly dictationActive: boolean;
  readonly dictationHideSubmit: boolean;
  readonly visibility?: ThreadVisibility;
  /** Absent outside a workspace, where a Thread is always private. */
  readonly onVisibilityChange?: (visibility: ThreadVisibility) => void;
  /**
   * The workspace's members `@` can tag. Tagging one shares the Thread with
   * the workspace, so they can open it; outside a workspace `@` is text.
   */
  readonly mentionMembers?: ReadonlyArray<ThreadMemberData>;
}) {
  const uploading = useAttachmentsUploading(images);
  // The provider list the page reads runnerOrbs from (the same query), for
  // whether it failed and to retry it.
  const { identity } = useAuthenticatedIdentity();
  const orbProvidersQuery = useQuery(
    newThreadOrbProvidersQueryOptions(identity.id, projectId),
  );
  const runnerOrbsFailed =
    orbProvidersQuery.isError && !orbProvidersQuery.isFetching;
  // A send waits for the provider list. Until it loads, the starting size
  // (say, a remembered one) may be on a provider the person cannot use; the
  // list moves it to one they can. A failed list lets the send through.
  const runnerOrbsPending = runnerOrbs === undefined && !runnerOrbsFailed;
  const enterKey = useComposerEnterKey();
  const mentions = useNewThreadMentions({
    members: onVisibilityChange === undefined ? undefined : mentionMembers,
    viewerId: identity.id,
    prompt,
    setPrompt: onPromptChange,
    textareaRef,
    onMention: () => onVisibilityChange?.("workspace"),
  });
  const dropTarget = useImageDropTarget({
    disabled: submitting || uploading,
    onFiles,
  });
  // Core refuses a Thread with no Orb that can start or no served model;
  // Send stays off until both are set up.
  const setupGaps = newThreadSetupGaps({
    runnerOrbs,
    localRuntime: orbProvidersQuery.data?.localRuntime,
    runnerProfiles,
    runnerProfileId,
    choices,
    // Recommended is the mode slot Settings → Models edits.
    profile: RECOMMENDED_MODE,
    model,
  });
  return (
    <form
      className="new-thread-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!runnerOrbsPending && setupGaps.length === 0) onSubmit();
      }}
      {...dropTarget}
    >
      <div className="new-thread-composer-body">
        <Textarea
          variant="bare"
          ref={textareaRef}
          value={prompt}
          readOnly={submitting}
          {...mentions.textareaProps}
          onChange={(event) => {
            onPromptChange(event.target.value);
            mentions.onInput(event);
          }}
          onSelect={mentions.trackCaret}
          onPaste={(event) => {
            const files = pastedFiles(event);
            if (files.length === 0 || submitting || uploading) return;
            event.preventDefault();
            onFiles(files);
          }}
          onKeyDown={(event) => {
            // A key the @ list used is not the dialog's: Escape closes
            // the list, not the composer.
            if (mentions.onKeyDown(event)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            if (enterKey.sends(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Write prompt…"
          aria-label="Prompt"
          enterKeyHint={enterKey.enterKeyHint}
        />
        {mentions.list}
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
      <NewThreadSetupNotice gaps={setupGaps} />
      <NewThreadConfigurationStrip
        projects={projects}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        onLoadMoreProjects={onLoadMoreProjects}
        projectId={projectId}
        model={model}
        effort={effort}
        choices={choices}
        routingGraph={routingGraph}
        locked={submitting}
        submitting={submitting}
        ready={
          !uploading &&
          !runnerOrbsPending &&
          setupGaps.length === 0 &&
          Boolean(prompt.trim() || images.length > 0)
        }
        retrying={false}
        onProjectChange={onProjectChange}
        runnerProfiles={runnerProfiles}
        runnerProviders={runnerProviders}
        runnerOrbs={runnerOrbs}
        runnerOrbsFailed={runnerOrbsFailed}
        onRunnerOrbsRetry={() => void orbProvidersQuery.refetch()}
        runnerProfileId={runnerProfileId}
        runnerProfileLoading={runnerProfileLoading}
        allowedRunnerProfileIds={allowedRunnerProfileIds}
        onRunnerProfileChange={onRunnerProfileChange}
        onRunnerProfileRetry={onRunnerProfileRetry}
        onConnectOrbProvider={onConnectOrbProvider}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        claudePlan={claudePlan}
        onClaudePlanChange={onClaudePlanChange}
        pluginAgentModes={pluginAgentModes}
        pluginAgentMode={pluginAgentMode}
        onPluginAgentModeChange={onPluginAgentModeChange}
        {...(pluginThreadTypes === undefined ? {} : { pluginThreadTypes })}
        {...(pluginThreadType === undefined ? {} : { pluginThreadType })}
        {...(onPluginThreadTypeChange === undefined
          ? {}
          : { onPluginThreadTypeChange })}
        dictationControls={dictationControls}
        dictationActive={dictationActive}
        dictationHideSubmit={dictationHideSubmit}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
      />
    </form>
  );
}
