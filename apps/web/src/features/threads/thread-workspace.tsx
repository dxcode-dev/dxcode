import {
  type ProjectData,
  type ThreadChangesPath,
  type ThreadDetailData,
  ThreadFilesPath,
} from "@dx/api";
import type { ProjectId, ThreadId } from "@dx/domain";
import {
  type FlueAgentSession,
  type UseFlueAgentResult,
  useFlueAgent,
} from "@flue/react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Schema } from "effect";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { wakingExecutionEnvironmentMessage } from "../../shared/execution-environment-copy.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";
import { Button } from "../../shared/ui/button.js";
import { MarkdownFileLinkContext } from "../../shared/ui/markdown-file-link-context.js";
import { useMobile } from "../../shared/use-mobile.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { AgentPanel, PendingAgentPanel } from "./agent-panel.js";
import { ChangesPane } from "./changes/changes-pane.js";
import { CenterFilePane } from "./files/center-file-pane.js";
import {
  type ThreadFileLocation,
  ThreadFilesPanel,
} from "./files/files-panel.js";
import type { PendingImage } from "./image-attachments.js";
import {
  useThreadPresence,
  useThreadWorkspaceStatus,
} from "./realtime/realtime-provider.js";
import { type CenterFileTab, ThreadCenterTabs } from "./thread-center-tabs.js";
import { ThreadDesktopLayout } from "./thread-desktop-layout.js";
import {
  type ThreadFileNavigation,
  ThreadFileNavigationContext,
} from "./thread-file-navigation.js";
import { PendingThreadHeader, ThreadHeader } from "./thread-header.js";
import { threadQueryOptions } from "./thread-queries.js";
import {
  ThreadPresentationContext,
  ThreadSessionRegistryContext,
} from "./thread-session-context.js";
import {
  createThreadAgentClient,
  isAuthorizationError,
  type OptimisticThreadCreation,
  type PendingSubmissionControl,
  retainSubmissionImages,
  type ThreadSessionRegistry,
} from "./thread-session-registry.js";
import {
  absolutePathFor,
  type FileReveal,
  fileTargetKey,
  resolveTranscriptFileLink,
  sandboxFileUrl,
  type ThreadFileTarget,
} from "./transcript-file-link.js";
import { useFrameCoalescedAgentSession } from "./use-frame-coalesced-agent-session.js";
import {
  useThreadPresentation,
  useThreadPresentationValue,
} from "./use-thread-presentation.js";

const filesPath = (path: ThreadChangesPath) => {
  try {
    return Schema.decodeUnknownSync(ThreadFilesPath)(path);
  } catch {
    return undefined;
  }
};

const useOptimisticThreadCreation = (
  registry: ThreadSessionRegistry | undefined,
  threadId: ThreadId,
) => {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      registry?.subscribeCreations(listener) ?? (() => {}),
    [registry],
  );
  const snapshot = React.useCallback(
    () => registry?.creation(threadId),
    [registry, threadId],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

export function ThreadWorkspace({
  Terminal,
}: {
  readonly Terminal?: React.ComponentType<{
    readonly active?: boolean;
    readonly threadId: ThreadId;
    readonly onWorkspaceStatusChange?: (status?: string) => void;
  }>;
}) {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const navigate = useNavigate();
  const returnTo = useLocation({ select: (location) => location.href });
  const { identity } = useAuthenticatedIdentity();
  const registry = React.useContext(ThreadSessionRegistryContext);
  const id = threadId as ThreadId;
  useThreadPresence(id);
  const workspaceStatus = useThreadWorkspaceStatus(id);
  const optimisticCreation = useOptimisticThreadCreation(registry, id);
  const threadQuery = useQuery({
    ...threadQueryOptions(identity.id, id),
    enabled:
      optimisticCreation === undefined ||
      optimisticCreation.submissionId !== undefined,
  });
  const projectQuery = useQuery({
    ...projectQueryOptions(
      identity.id,
      threadQuery.data?.projectId as ProjectId,
    ),
    enabled: threadQuery.data !== undefined,
  });
  const error =
    [threadQuery.error, projectQuery.error].find(isAuthorizationError) ??
    threadQuery.error ??
    projectQuery.error;
  const retry = () => {
    if (threadQuery.data === undefined || threadQuery.error !== null)
      void threadQuery.refetch();
    if (threadQuery.data !== undefined) void projectQuery.refetch();
  };

  if (
    optimisticCreation !== undefined &&
    optimisticCreation.submissionId === undefined
  ) {
    return (
      <div className="thread-region" data-pending-thread="">
        <section className="thread-main-panel">
          <PendingThreadHeader creation={optimisticCreation} />
          <PendingAgentPanel creation={optimisticCreation} />
        </section>
      </div>
    );
  }

  if (
    threadQuery.data === undefined ||
    projectQuery.data === undefined ||
    isAuthorizationError(error)
  ) {
    if (error)
      return (
        <div className="fatal-state">
          <strong>Thread unavailable</strong>
          <span>
            {error instanceof Error
              ? error.message
              : "The thread could not load."}
          </span>
          <Button size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      );
    return <DxLoading label="Loading thread…" />;
  }
  return (
    <ThreadSession
      key={threadQuery.data.id}
      thread={threadQuery.data}
      project={projectQuery.data}
      refreshError={
        error === null
          ? undefined
          : error instanceof Error
            ? error.message
            : "Thread metadata could not be refreshed."
      }
      onRefreshRetry={retry}
      optimisticCreation={optimisticCreation}
      onInitialSubmissionObserved={(submissionId) =>
        registry?.completeCreation(id, submissionId)
      }
      workspaceStatus={
        workspaceStatus === "waking"
          ? wakingExecutionEnvironmentMessage
          : undefined
      }
      onOpenModelRouting={(destination) =>
        void navigate({
          href: destination,
          state: settingsNavigationState(returnTo),
        })
      }
      Terminal={Terminal}
    />
  );
}

function ThreadRefreshError({
  message,
  onRetry,
}: {
  readonly message?: string;
  readonly onRetry?: () => void;
}) {
  if (message === undefined || onRetry === undefined) return null;
  return (
    <div className="thread-refresh-error" role="alert">
      <span>{message} Showing the last loaded Thread metadata.</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function OpenThreadFilePane({
  active,
  file,
  threadId,
  setFiles,
}: {
  readonly active: boolean;
  readonly file: CenterFileTab;
  readonly threadId: ThreadId;
  readonly setFiles: React.Dispatch<
    React.SetStateAction<readonly CenterFileTab[]>
  >;
}) {
  const onDirtyChange = React.useCallback(
    (dirty: boolean) =>
      setFiles((current) =>
        current.map((item) =>
          fileTargetKey(item) === fileTargetKey(file)
            ? { ...item, dirty }
            : item,
        ),
      ),
    [file, setFiles],
  );
  return (
    <section
      className="thread-file-center-panel"
      hidden={!active}
      aria-label={`File ${file.path}`}
    >
      <CenterFilePane
        active={active}
        file={file}
        threadId={threadId}
        onDirtyChange={onDirtyChange}
      />
    </section>
  );
}

type ThreadSessionProps = {
  readonly thread: ThreadDetailData;
  readonly project: ProjectData;
  readonly refreshError?: string;
  readonly onRefreshRetry?: () => void;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly workspaceStatus?: string;
  readonly onOpenModelRouting?: (destination: string) => void;
  readonly Terminal?: React.ComponentType<{
    readonly active?: boolean;
    readonly threadId: ThreadId;
    readonly onWorkspaceStatusChange?: (status?: string) => void;
  }>;
};

export function ThreadSession(props: ThreadSessionProps) {
  const registry = React.useContext(ThreadSessionRegistryContext);
  if (registry === undefined) return <RouteScopedThreadSession {...props} />;
  return <RetainedThreadSession registry={registry} {...props} />;
}

function RouteScopedThreadSession(props: ThreadSessionProps) {
  const client = React.useMemo(
    () =>
      createThreadAgentClient(
        props.thread.agentUrl,
        props.thread.agentInitialization,
      ),
    [props.thread.agentInitialization, props.thread.agentUrl],
  );
  const agent = useFlueAgent({ client, live: "sse" });
  return <ThreadSessionContent {...props} agentSource={{ agent }} />;
}

function RetainedThreadSession({
  registry,
  ...props
}: ThreadSessionProps & { readonly registry: ThreadSessionRegistry }) {
  const [entry] = React.useState(() =>
    registry.prepare(
      props.thread.id,
      props.thread.projectId,
      props.thread.agentUrl,
      props.thread.agentInitialization,
    ),
  );
  useMountEffect(() => registry.activate(entry));
  const subscribe = React.useCallback(
    (listener: () => void) => {
      entry.presentationListeners.add(listener);
      return () => entry.presentationListeners.delete(listener);
    },
    [entry],
  );
  const disposed = React.useSyncExternalStore(
    subscribe,
    () => entry.disposed,
    () => entry.disposed,
  );
  if (disposed)
    return (
      <div className="fatal-state" role="alert">
        Thread unavailable
      </div>
    );
  return (
    <ThreadPresentationContext value={entry}>
      <RetainedThreadSessionContent {...props} />
    </ThreadPresentationContext>
  );
}

function RetainedThreadSessionContent(props: ThreadSessionProps) {
  const entry = React.useContext(ThreadPresentationContext);
  if (entry === undefined)
    throw new Error("Missing retained Thread capability.");
  return (
    <ThreadSessionContent {...props} agentSource={{ session: entry.session }} />
  );
}

/**
 * The retained session is subscribed here, below the page, so Flue stream
 * chunks re-render only the agent panel, not the layout, Changes, or Files,
 * and at most once per frame however many chunks a network batch delivers.
 */
type ThreadAgentSource =
  | { readonly session: FlueAgentSession }
  | { readonly agent: UseFlueAgentResult };
type ThreadAgentPanelProps = Omit<
  React.ComponentProps<typeof AgentPanel>,
  "agent"
> & { readonly source: ThreadAgentSource };

function ThreadAgentPanel({ source, ...props }: ThreadAgentPanelProps) {
  return "session" in source ? (
    <SessionAgentPanel session={source.session} {...props} />
  ) : (
    <AgentPanel agent={source.agent} {...props} />
  );
}

function SessionAgentPanel({
  session,
  ...props
}: Omit<ThreadAgentPanelProps, "source"> & {
  readonly session: FlueAgentSession;
}) {
  const agent = useFrameCoalescedAgentSession(session);
  return <AgentPanel agent={agent} {...props} />;
}

/** A retained Thread's pending images and submission state, for its panel. */
function useRetainedImageProps() {
  const retainedThread = React.useContext(ThreadPresentationContext);
  const [images, setImages] = useThreadPresentation<
    ReadonlyArray<PendingImage>
  >("pending-images", () => []);
  const [submissionPending, setSubmissionPending] = useThreadPresentation(
    "submission-pending",
    false,
  );
  const [submissionControl] = useThreadPresentation<PendingSubmissionControl>(
    "submission-control",
    () => ({ stopRequested: false }),
  );
  return retainedThread === undefined
    ? {}
    : {
        imageCollection: retainedThread.images,
        images,
        onImagesChange: setImages,
        submissionPending,
        submissionControl,
        onSubmissionPendingChange: setSubmissionPending,
        submissionImageRetention: retainSubmissionImages(
          retainedThread,
          setSubmissionPending,
        ),
      };
}

/**
 * The center pane's open file tabs and the transcript's file links that open
 * them. Context values stay stable: a new value re-renders every transcript
 * Markdown consumer, bypassing their memoization.
 */
function useCenterFileTabs(threadId: ThreadId) {
  const [files, setFiles] = React.useState<readonly CenterFileTab[]>([]);
  const [activeFile, setActiveFile] = React.useState<string>();
  const openTarget = React.useCallback(
    (target: ThreadFileTarget, reveal?: FileReveal) => {
      const key = fileTargetKey(target);
      setFiles((current) => {
        const existing = current.find((file) => fileTargetKey(file) === key);
        if (existing === undefined)
          return [
            ...current,
            {
              ...target,
              dirty: false,
              ...(reveal === undefined ? {} : { reveal, revealSequence: 1 }),
            },
          ];
        // Reopening an open tab keeps its draft and moves the highlight.
        if (reveal === undefined) return current;
        return current.map((file) =>
          fileTargetKey(file) === key
            ? {
                ...file,
                reveal,
                revealSequence: (file.revealSequence ?? 0) + 1,
              }
            : file,
        );
      });
      setActiveFile(key);
    },
    [],
  );
  const openFile = (location: ThreadFileLocation) =>
    openTarget({ kind: "workspace", ...location });
  const closeFile = (file: CenterFileTab) => {
    const key = fileTargetKey(file);
    const index = files.findIndex((item) => fileTargetKey(item) === key);
    const next = files.filter((item) => fileTargetKey(item) !== key);
    setFiles(next);
    if (activeFile === key)
      setActiveFile(
        next[Math.min(index, next.length - 1)] === undefined
          ? undefined
          : fileTargetKey(
              next[Math.min(index, next.length - 1)] as CenterFileTab,
            ),
      );
  };
  const fileDownloadUrl = React.useCallback(
    (target: ThreadFileTarget) => {
      const absolute = absolutePathFor(target);
      return absolute === undefined
        ? undefined
        : sandboxFileUrl(threadId, absolute, true);
    },
    [threadId],
  );
  const fileNavigation = React.useMemo<ThreadFileNavigation>(
    () => ({ open: openTarget, downloadUrl: fileDownloadUrl }),
    [openTarget, fileDownloadUrl],
  );
  const resolveFileLink = React.useCallback(
    (href: string) => {
      const resolved = resolveTranscriptFileLink(href);
      if (resolved === undefined) return undefined;
      const downloadUrl = fileDownloadUrl(resolved.target);
      return {
        open: () =>
          openTarget(
            resolved.target,
            resolved.lines === undefined
              ? undefined
              : { kind: "lines", lines: resolved.lines },
          ),
        ...(downloadUrl === undefined ? {} : { downloadUrl }),
      };
    },
    [openTarget, fileDownloadUrl],
  );
  return {
    files,
    setFiles,
    activeFile,
    setActiveFile,
    openFile,
    closeFile,
    fileNavigation,
    resolveFileLink,
  };
}

function ThreadSessionContent({
  thread,
  project,
  refreshError,
  onRefreshRetry,
  optimisticCreation,
  onInitialSubmissionObserved,
  workspaceStatus: realtimeWorkspaceStatus,
  onOpenModelRouting,
  Terminal,
  agentSource,
}: ThreadSessionProps & {
  readonly agentSource: ThreadAgentSource;
}) {
  const { identity } = useAuthenticatedIdentity();
  const mobile = useMobile();
  const archived = thread.lifecycleState === "archived";
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const dictationAvailable = settingsQuery.data?.dictationAvailable === true;
  const workspace = settingsQuery.data?.workspace;
  const modelRoutingDestination =
    project.workspaceId === undefined
      ? "/settings/model-routing"
      : workspace?.id === project.workspaceId
        ? `/workspaces/${workspace.shortName}/settings/model-routing`
        : undefined;
  const openModelRouting =
    modelRoutingDestination === undefined
      ? undefined
      : () => onOpenModelRouting?.(modelRoutingDestination);
  // Passed down without subscribing: only the composer renders the draft.
  const draft = useThreadPresentationValue("draft", "");
  const retainedImageProps = useRetainedImageProps();
  const [rightPaneCollapsed, setRightPaneCollapsed] = React.useState(true);
  const [liveWorkspaceStatus, setLiveWorkspaceStatus] =
    React.useState<string>();
  const [fileNavigationError, setFileNavigationError] =
    React.useState<string>();
  const workspaceStatus =
    liveWorkspaceStatus ??
    realtimeWorkspaceStatus ??
    thread.executionWorkspace.preparationStatus ??
    undefined;
  const toggleRightPane = React.useCallback(
    () => setRightPaneCollapsed((collapsed) => !collapsed),
    [],
  );
  const {
    files,
    setFiles,
    activeFile,
    setActiveFile,
    openFile,
    closeFile,
    fileNavigation,
    resolveFileLink,
  } = useCenterFileTabs(thread.id);
  if (mobile) {
    return (
      <div className="mobile-thread-region">
        <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
        <main className="mobile-pane-content">
          <ThreadAgentPanel
            {...retainedImageProps}
            source={agentSource}
            agentInitialization={thread.agentInitialization}
            onOpenModelRouting={openModelRouting}
            archived={archived}
            dictationAvailable={dictationAvailable}
            showArchivedNotice={archived}
            draft={draft}
            workspaceReady={thread.executionWorkspace.ready}
            workspaceStatus={workspaceStatus}
            optimisticCreation={optimisticCreation}
            onInitialSubmissionObserved={onInitialSubmissionObserved}
            renderHeader={(model) => (
              <ThreadHeader thread={thread} project={project} model={model} />
            )}
          />
        </main>
      </div>
    );
  }

  if (archived) {
    return (
      <div className="thread-region">
        <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
        <section className="thread-main-panel">
          <ThreadAgentPanel
            {...retainedImageProps}
            source={agentSource}
            agentInitialization={thread.agentInitialization}
            archived
            dictationAvailable={dictationAvailable}
            workspaceReady={thread.executionWorkspace.ready}
            workspaceStatus={workspaceStatus}
            optimisticCreation={optimisticCreation}
            onInitialSubmissionObserved={onInitialSubmissionObserved}
            renderHeader={(model) => (
              <ThreadHeader thread={thread} project={project} model={model} />
            )}
          />
        </section>
      </div>
    );
  }

  if (!thread.executionWorkspace.ready) {
    return (
      <div className="thread-region">
        <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
        <section className="thread-main-panel">
          <ThreadAgentPanel
            {...retainedImageProps}
            source={agentSource}
            agentInitialization={thread.agentInitialization}
            onOpenModelRouting={openModelRouting}
            dictationAvailable={dictationAvailable}
            draft={draft}
            workspaceReady={thread.executionWorkspace.ready}
            workspaceStatus={workspaceStatus}
            optimisticCreation={optimisticCreation}
            onInitialSubmissionObserved={onInitialSubmissionObserved}
            renderHeader={(model) => (
              <ThreadHeader thread={thread} project={project} model={model} />
            )}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="thread-region">
      <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
      <ThreadDesktopLayout
        rightPaneCollapsed={rightPaneCollapsed}
        terminal={
          Terminal === undefined
            ? undefined
            : (active) => (
                <Terminal
                  active={active}
                  threadId={thread.id}
                  onWorkspaceStatusChange={setLiveWorkspaceStatus}
                />
              )
        }
        changes={
          <>
            {fileNavigationError === undefined ? null : (
              <div className="thread-files-state" role="alert">
                {fileNavigationError}
              </div>
            )}
            <ChangesPane
              threadId={thread.id}
              projectName={project.name}
              onReviewPrompt={draft.set}
              onOpenFile={(worktree, path, worktreeLabel) => {
                const validated = filesPath(path);
                if (validated === undefined) {
                  setFileNavigationError("This changed path cannot be opened.");
                  return;
                }
                setFileNavigationError(undefined);
                openFile({
                  worktree,
                  ...(worktreeLabel === undefined ? {} : { worktreeLabel }),
                  path: validated,
                });
              }}
            />
          </>
        }
        files={(active) => (
          <ThreadFilesPanel
            active={active}
            threadId={thread.id}
            projectName={project.name}
            selectedFile={(() => {
              const file = files.find(
                (candidate) => fileTargetKey(candidate) === activeFile,
              );
              return file === undefined || file.kind !== "workspace"
                ? undefined
                : {
                    worktree: file.worktree,
                    path: file.path,
                  };
            })()}
            onOpenFile={openFile}
          />
        )}
        main={
          <ThreadFileNavigationContext value={fileNavigation}>
            <MarkdownFileLinkContext value={resolveFileLink}>
              <ThreadAgentPanel
                {...retainedImageProps}
                source={agentSource}
                agentInitialization={thread.agentInitialization}
                onOpenModelRouting={openModelRouting}
                dictationAvailable={dictationAvailable}
                active={activeFile === undefined}
                additionalPanels={files.map((file) => (
                  <OpenThreadFilePane
                    active={activeFile === fileTargetKey(file)}
                    file={file}
                    key={fileTargetKey(file)}
                    setFiles={setFiles}
                    threadId={thread.id}
                  />
                ))}
                draft={draft}
                workspaceReady={thread.executionWorkspace.ready}
                workspaceStatus={workspaceStatus}
                optimisticCreation={optimisticCreation}
                onInitialSubmissionObserved={onInitialSubmissionObserved}
                renderHeader={(model) => (
                  <>
                    <ThreadHeader
                      thread={thread}
                      project={project}
                      model={model}
                      rightPaneCollapsed={rightPaneCollapsed}
                      onToggleRightPane={toggleRightPane}
                    />
                    <ThreadCenterTabs
                      activeFile={activeFile}
                      files={files}
                      onClose={closeFile}
                      onSelect={setActiveFile}
                    />
                  </>
                )}
              />
            </MarkdownFileLinkContext>
          </ThreadFileNavigationContext>
        }
      />
    </div>
  );
}
