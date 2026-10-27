import {
  type ProjectData,
  type ThreadChangesPath,
  type ThreadDetailData,
  ThreadFilesPath,
} from "@dx/api";
import {
  PROJECTLESS_PROJECT_NAME,
  type ProjectId,
  ThreadId,
  type UserId,
} from "@dx/domain";
import {
  type FlueAgentSession,
  type UseFlueAgentResult,
  useFlueAgent,
} from "@flue/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Schema } from "effect";
import { Eye } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { wakingExecutionEnvironmentMessage } from "../../shared/execution-environment-copy.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";
import { Button } from "../../shared/ui/button.js";
import {
  MarkdownFileLinkContext,
  MarkdownImageSourceContext,
} from "../../shared/ui/markdown-file-link-context.js";
import { useMobile } from "../../shared/use-mobile.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { AgentPanel, type AgentPanelOptions } from "./agent-panel.js";
import { ThreadScheduleHint } from "./automations/thread-schedule-hint.js";
import { ChangesPane } from "./changes/changes-pane.js";
import { CenterFilePane } from "./files/center-file-pane.js";
import {
  type ThreadFileLocation,
  ThreadFilesPanel,
} from "./files/files-panel.js";
import type { PendingAttachment } from "./image-attachments.js";
import { OrbDiskNotice } from "./orb-disk/orb-disk-notice.js";
import { OrbMemoryNotice } from "./orb-memory/orb-memory-notice.js";
import { ThreadPortalsPane } from "./portals/portals-pane.js";
import {
  useThreadPresence,
  useThreadWorkspaceStatus,
} from "./realtime/realtime-provider.js";
import type { ComposerMentions } from "./sharing/chat-composer.js";
import { MessageAuthorsProvider } from "./sharing/message-authors.js";
import {
  setConversationMode,
  useSetThreadFollowing,
} from "./sharing/sharing-mutations.js";
import { threadMembersQueryOptions } from "./sharing/thread-chat-queries.js";
import { type CenterFileTab, ThreadCenterTabs } from "./thread-center-tabs.js";
import { ThreadDesktopLayout } from "./thread-desktop-layout.js";
import {
  type ThreadFileNavigation,
  ThreadFileNavigationContext,
} from "./thread-file-navigation.js";
import { ThreadHeader } from "./thread-header.js";
import {
  MobileThreadTabs,
  MobileToolPanels,
  type MobileWorkspaceTools,
  useMobileThreadTool,
} from "./thread-mobile-layout.js";
import {
  invalidateThreadQueries,
  threadQueryOptions,
} from "./thread-queries.js";
import {
  ThreadPresentationContext,
  ThreadSessionRegistryContext,
} from "./thread-session-context.js";
import {
  createPendingSubmissionControl,
  createThreadAgentClient,
  initializeRetainedThread,
  isAuthorizationError,
  isDeletedThreadError,
  type OptimisticThreadCreation,
  type PendingSubmissionControl,
  type RetainedThread,
  type ThreadSessionRegistry,
} from "./thread-session-registry.js";
import type { TranscriptFocus } from "./thread-transcript.js";
import {
  absolutePathFor,
  type FileReveal,
  fileTargetKey,
  resolveTranscriptFileLink,
  sandboxFileUrl,
  type ThreadFileTarget,
  transcriptMediaSource,
} from "./transcript-file-link.js";
import { useFrameCoalescedAgentSource } from "./use-frame-coalesced-agent-session.js";
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
  const subscribe = (listener: () => void) =>
    registry?.subscribeCreations(listener) ?? (() => {});
  const snapshot = () => registry?.creation(threadId);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

const isThreadId = Schema.is(ThreadId);
const HISTORY_SETTLED = "history-settled";

/** History loaded, or failed: Flue retries a failure while `connecting`. */
const historySettledNow = (session: FlueAgentSession) => {
  const history = session.getSnapshot();
  return (
    history.historyReady ||
    history.status === "error" ||
    history.error !== undefined
  );
};

/**
 * Activates the Thread's retained session from its id alone, so history loads
 * alongside the Thread detail. True once history has loaded or failed, and
 * stays true while a refresh reloads it, so the open page never unmounts.
 * A revoked Thread is not activated; access granted again starts a new entry.
 */
const useRetainedThread = (
  registry: ThreadSessionRegistry | undefined,
  threadId: ThreadId,
  authorized: boolean,
) => {
  const entry =
    authorized && isThreadId(threadId)
      ? registry?.prepare(threadId)
      : undefined;
  const subscribe = (listener: () => void) => {
    if (registry === undefined || entry === undefined) return () => {};
    const deactivate = registry.activate(entry);
    const observe = () => {
      if (historySettledNow(entry.session))
        entry.presentation.set(HISTORY_SETTLED, true);
    };
    observe();
    const unsubscribe = entry.session.subscribe(() => {
      observe();
      listener();
    });
    return () => {
      unsubscribe();
      deactivate();
    };
  };
  const snapshot = () =>
    entry === undefined ||
    entry.presentation.get(HISTORY_SETTLED) === true ||
    historySettledNow(entry.session);
  const historySettled = React.useSyncExternalStore(
    subscribe,
    snapshot,
    snapshot,
  );
  return { entry, historySettled };
};

export function ThreadWorkspace({
  Terminal,
  Desktop,
}: {
  readonly Terminal?: React.ComponentType<{
    readonly active?: boolean;
    readonly threadId: ThreadId;
    readonly onWorkspaceStatusChange?: (status?: string) => void;
  }>;
  readonly Desktop?: ThreadDesktopComponent;
}) {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const navigate = useNavigate();
  const returnTo = useLocation({ select: (location) => location.href });
  // A notification opens the Thread at a message; the URL keeps it only
  // until the transcript has scrolled there.
  const focusMessageId = useLocation({
    select: (location) => {
      const message: unknown = location.search?.message;
      return typeof message === "string" && /^msg_[0-9a-f]{24}$/.test(message)
        ? message
        : undefined;
    },
  });
  // Each navigation is its own request, so opening the same mention again
  // scrolls to it again.
  const focusRequestKey = useLocation({
    select: (location) =>
      location.state?.__TSR_key ?? location.state?.key ?? location.href,
  });
  const focus =
    focusMessageId === undefined
      ? undefined
      : { messageId: focusMessageId, requestKey: String(focusRequestKey) };
  const onFocusHandled = () =>
    void navigate({
      to: "/threads/$threadId",
      params: { threadId },
      search: {},
      replace: true,
    });
  const { identity } = useAuthenticatedIdentity();
  const registry = React.useContext(ThreadSessionRegistryContext);
  const id = threadId as ThreadId;
  useThreadPresence(id);
  const workspaceStatus = useThreadWorkspaceStatus(id);
  // The page opens only once the server admitted the creation.
  const optimisticCreation = useOptimisticThreadCreation(registry, id);
  const threadQuery = useQuery(threadQueryOptions(identity.id, id));
  // A member of a shared Thread cannot read the owner's Project; the Thread
  // detail carries its name instead.
  const sharedWithMe =
    threadQuery.data?.access !== undefined &&
    threadQuery.data.access !== "owner";
  const projectQuery = useQuery({
    ...projectQueryOptions(
      identity.id,
      threadQuery.data?.projectId as ProjectId,
    ),
    enabled: threadQuery.data !== undefined && !sharedWithMe,
  });
  // A Thread created in this browser knows its Project's name and scope, so
  // it opens without waiting for the Project (a hidden one for No Project).
  const project: ThreadProject | undefined = sharedWithMe
    ? { name: threadQuery.data?.projectName ?? "Shared project" }
    : (projectQuery.data ??
      (optimisticCreation === undefined
        ? undefined
        : {
            name: optimisticCreation.project?.name ?? PROJECTLESS_PROJECT_NAME,
            workspaceId: optimisticCreation.project?.workspaceId,
          }));
  const projectError = sharedWithMe ? null : projectQuery.error;
  const error =
    [threadQuery.error, projectError].find(isAuthorizationError) ??
    threadQuery.error ??
    projectError;
  const retained = useRetainedThread(
    registry,
    id,
    !isAuthorizationError(error),
  );
  const retry = () => {
    if (threadQuery.data === undefined || threadQuery.error !== null)
      void threadQuery.refetch();
    if (threadQuery.data !== undefined) void projectQuery.refetch();
  };

  const metadataReady =
    threadQuery.data !== undefined &&
    project !== undefined &&
    !isAuthorizationError(error);
  // A Thread created here shows its first message without waiting for history.
  const historyReady =
    retained.historySettled || optimisticCreation !== undefined;
  if (
    threadQuery.data === undefined ||
    project === undefined ||
    isAuthorizationError(error) ||
    !historyReady
  ) {
    if (isDeletedThreadError(error))
      return (
        <div className="fatal-state">
          <strong>Thread deleted</strong>
          <span>
            This Thread, its conversation, and its sandbox were permanently
            deleted.
          </span>
        </div>
      );
    if (error && !metadataReady)
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
    return <DxLoading label="Loading thread…" variant="pane" />;
  }
  return (
    <ThreadSession
      key={threadQuery.data.id}
      retained={retained.entry}
      thread={threadQuery.data}
      project={project}
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
      {...(focus === undefined ? {} : { focus, onFocusHandled })}
      Terminal={Terminal}
      Desktop={Desktop}
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
  const onDirtyChange = (dirty: boolean) =>
    setFiles((current) =>
      current.map((item) =>
        fileTargetKey(item) === fileTargetKey(file) ? { ...item, dirty } : item,
      ),
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

/** What a Thread page needs of its Project. */
type ThreadProject = Pick<ProjectData, "name"> &
  Partial<Pick<ProjectData, "workspaceId">>;

/** The Thread's remote desktop viewer, composed by the router. */
type ThreadDesktopComponent = React.ComponentType<{
  readonly active?: boolean;
  readonly threadId: ThreadId;
}>;

/**
 * The Preview tool: absent without a Portal domain, a note for a view-only
 * member (Portals and the Desktop take input), otherwise the Portals pane.
 */
const previewTool = (
  thread: ThreadDetailData,
  portalDomain: string | undefined,
) =>
  portalDomain === undefined ? undefined : thread.access === "view" ? (
    <div className="thread-files-state" role="note">
      Only contributors can open Portals in a shared thread.
    </div>
  ) : (
    (active: boolean) => (
      <ThreadPortalsPane active={active} threadId={thread.id} />
    )
  );

/** The Desktop tool, gated like Preview; absent when the router gives none. */
const desktopTool = (
  thread: ThreadDetailData,
  Desktop: ThreadDesktopComponent | undefined,
) =>
  Desktop === undefined ? undefined : thread.access === "view" ? (
    <div className="thread-files-state" role="note">
      Only contributors can use the desktop in a shared thread.
    </div>
  ) : (
    (active: boolean) => <Desktop active={active} threadId={thread.id} />
  );

type ThreadSessionProps = {
  readonly thread: ThreadDetailData;
  /** Already activated by the page that loaded it. */
  readonly retained?: RetainedThread;
  readonly project: ThreadProject;
  readonly refreshError?: string;
  readonly onRefreshRetry?: () => void;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly workspaceStatus?: string;
  readonly onOpenModelRouting?: (destination: string) => void;
  /** Open the transcript at this message (`?message=`), as a notification links. */
  readonly focus?: TranscriptFocus;
  readonly onFocusHandled?: () => void;
  readonly Terminal?: React.ComponentType<{
    readonly active?: boolean;
    readonly threadId: ThreadId;
    readonly onWorkspaceStatusChange?: (status?: string) => void;
  }>;
  readonly Desktop?: ThreadDesktopComponent;
};

export function ThreadSession(props: ThreadSessionProps) {
  const registry = React.useContext(ThreadSessionRegistryContext);
  const { identity } = useAuthenticatedIdentity();
  return (
    <MessageAuthorsProvider thread={props.thread} viewerId={identity.id}>
      {registry === undefined ? (
        <RouteScopedThreadSession {...props} />
      ) : (
        <RetainedThreadSession registry={registry} {...props} />
      )}
    </MessageAuthorsProvider>
  );
}

/**
 * What `@` does in the composer: in a shared Thread it tags members or the
 * agent; in the owner's private Thread it offers Share. Viewers cannot send.
 */
function useComposerMentions(
  thread: ThreadDetailData,
  viewerId: UserId,
  openShare: () => void,
): ComposerMentions | undefined {
  const queryClient = useQueryClient();
  const access = thread.access ?? "owner";
  const shared = thread.sharing !== undefined;
  const membersQuery = useQuery({
    ...threadMembersQueryOptions(viewerId, thread.id),
    enabled: shared,
  });
  const members = membersQuery.data;
  const conversationMode = thread.conversationMode ?? "agent";
  const threadId = thread.id;
  if (access === "view") return undefined;
  if (shared)
    return {
      mode: "members",
      members: members ?? [],
      viewerId,
      conversationMode,
      onSent: (mode) =>
        setConversationMode(queryClient, viewerId, threadId, mode),
    };
  return access === "owner"
    ? { mode: "share", onOpenShare: openShare }
    : undefined;
}

/** Opening another member's shared Thread follows it. */
function useFollowOnOpen(thread: ThreadDetailData, viewerId: UserId) {
  const follow = useSetThreadFollowing(viewerId, thread.id);
  const shouldFollow =
    thread.access !== undefined &&
    thread.access !== "owner" &&
    thread.following === false;
  useMountEffect(() => {
    if (shouldFollow) follow.mutate(true);
  });
}

/** Viewers of a shared Thread get a notice instead of the composer. */
const sharedAgentPanelProps = (thread: ThreadDetailData) => {
  const access = thread.access ?? "owner";
  if (access === "owner") return {};
  const ownerName =
    thread.participants?.find(({ owner }) => owner)?.name ?? "the owner";
  return access === "view"
    ? {
        onOpenModelRouting: undefined,
        readOnlyNotice: (
          <div className="shared-composer-notice" role="note">
            <Eye aria-hidden="true" />
            You can view this thread. Ask {ownerName} for Contribute access to
            send messages.
          </div>
        ),
      }
    : { onOpenModelRouting: undefined };
};

function RouteScopedThreadSession(props: ThreadSessionProps) {
  const client = createThreadAgentClient(
    props.thread.agentUrl,
    () => props.thread.agentInitialization,
  );
  const agent = useFlueAgent({ client, live: "sse" });
  return <ThreadSessionContent {...props} agentSource={{ agent }} />;
}

function RetainedThreadSession({
  registry,
  ...props
}: ThreadSessionProps & { readonly registry: ThreadSessionRegistry }) {
  const [entry] = React.useState(() =>
    initializeRetainedThread(
      props.retained ??
        registry.prepare(props.thread.id, props.thread.agentUrl),
      props.thread.agentInitialization,
    ),
  );
  useMountEffect(() =>
    props.retained === undefined ? registry.activate(entry) : undefined,
  );
  const subscribe = (listener: () => void) => {
    entry.presentationListeners.add(listener);
    return () => entry.presentationListeners.delete(listener);
  };
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
type ThreadAgentPanelProps = AgentPanelOptions & {
  readonly source: ThreadAgentSource;
};

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
  const source = useFrameCoalescedAgentSource(session);
  return <AgentPanel source={source} {...props} />;
}

/** A retained Thread's pending images and submission state, for its panel. */
function useRetainedImageProps() {
  const retainedThread = React.useContext(ThreadPresentationContext);
  const [images, setImages] = useThreadPresentation<
    ReadonlyArray<PendingAttachment>
  >("pending-images", () => []);
  const [submissionPending, setSubmissionPending] = useThreadPresentation(
    "submission-pending",
    false,
  );
  const [submissionControl] = useThreadPresentation<PendingSubmissionControl>(
    "submission-control",
    createPendingSubmissionControl,
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
  const openTarget = (target: ThreadFileTarget, reveal?: FileReveal) => {
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
  };
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
  const fileDownloadUrl = (target: ThreadFileTarget) => {
    const absolute = absolutePathFor(target);
    return absolute === undefined
      ? undefined
      : sandboxFileUrl(threadId, absolute, true);
  };
  const fileNavigation: ThreadFileNavigation = {
    open: openTarget,
    downloadUrl: fileDownloadUrl,
  };
  const resolveFileLink = (href: string) => {
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
  };
  const resolveMediaSource = (src: string) =>
    transcriptMediaSource(threadId, src);
  return {
    files,
    setFiles,
    activeFile,
    setActiveFile,
    openFile,
    closeFile,
    fileNavigation,
    resolveFileLink,
    resolveMediaSource,
  };
}

/** Each workspace tool's content, shared by the phone and desktop layouts. */
function useWorkspaceTools({
  thread,
  project,
  Terminal,
  Desktop,
  portalDomain,
  onReviewPrompt,
  onWorkspaceStatusChange,
  centerFiles: { files, setFiles, activeFile, openFile },
}: {
  readonly thread: ThreadDetailData;
  readonly project: ThreadProject;
  readonly Terminal: ThreadSessionProps["Terminal"];
  readonly Desktop: ThreadDesktopComponent | undefined;
  readonly portalDomain: string | undefined;
  readonly onReviewPrompt: React.ComponentProps<
    typeof ChangesPane
  >["onReviewPrompt"];
  readonly onWorkspaceStatusChange: (status?: string) => void;
  readonly centerFiles: ReturnType<typeof useCenterFileTabs>;
}) {
  const [fileNavigationError, setFileNavigationError] =
    React.useState<string>();
  const workspaceTools: MobileWorkspaceTools = {
    terminal:
      Terminal === undefined ? undefined : thread.access === "view" ? (
        <div className="thread-files-state" role="note">
          Only contributors can use the terminal in a shared thread.
        </div>
      ) : (
        (active: boolean) => (
          <Terminal
            active={active}
            threadId={thread.id}
            onWorkspaceStatusChange={onWorkspaceStatusChange}
          />
        )
      ),
    preview: previewTool(thread, portalDomain),
    desktop: desktopTool(thread, Desktop),
    changes: (
      <>
        {fileNavigationError === undefined ? null : (
          <div className="thread-files-state" role="alert">
            {fileNavigationError}
          </div>
        )}
        <ChangesPane
          threadId={thread.id}
          projectName={project.name}
          onReviewPrompt={onReviewPrompt}
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
    ),
    files: (active: boolean) => (
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
    ),
  };
  const openFilePanes = files.map((file) => (
    <OpenThreadFilePane
      active={activeFile === fileTargetKey(file)}
      file={file}
      key={fileTargetKey(file)}
      setFiles={setFiles}
      threadId={thread.id}
    />
  ));
  return { workspaceTools, openFilePanes };
}

interface TerminalOpener {
  readonly mobile: boolean;
  readonly mobileTool: ReturnType<typeof useMobileThreadTool>;
  readonly setActiveFile: (file: undefined) => void;
  readonly setRightPaneCollapsed: (collapsed: boolean) => void;
}

/** Brings the Terminal forward, as choosing its tab would. */
function openTerminalTool({
  mobile,
  mobileTool,
  setActiveFile,
  setRightPaneCollapsed,
}: TerminalOpener) {
  if (mobile) {
    setActiveFile(undefined);
    mobileTool.select("terminal");
    return;
  }
  setRightPaneCollapsed(false);
  // The tab owns its selection; choose it as a click on it would.
  requestAnimationFrame(() =>
    document.getElementById("thread-workspace-tab-terminal")?.click(),
  );
}

function OrbNotices({
  threadId,
  onAskAgent,
  terminal,
}: {
  readonly threadId: ThreadId;
  readonly onAskAgent: (message: string) => void;
  readonly terminal: TerminalOpener | undefined;
}) {
  return (
    <>
      <OrbDiskNotice
        threadId={threadId}
        onAskAgent={onAskAgent}
        onOpenTerminal={
          terminal === undefined ? undefined : () => openTerminalTool(terminal)
        }
      />
      <OrbMemoryNotice threadId={threadId} />
    </>
  );
}

/**
 * Process names, commands, and folders are Terminal-level detail:
 * contributors only.
 */
function orbComposerNotice(
  thread: ThreadSessionProps["thread"],
  terminal: TerminalOpener | undefined,
) {
  if (
    thread.lifecycleState === "archived" ||
    !thread.executionWorkspace.ready ||
    thread.access === "view"
  )
    return undefined;
  return (send: (message: string) => void) => (
    <OrbNotices
      key={thread.id}
      threadId={thread.id}
      onAskAgent={send}
      terminal={terminal}
    />
  );
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
  focus,
  onFocusHandled,
  Terminal,
  Desktop,
  agentSource,
}: ThreadSessionProps & {
  readonly agentSource: ThreadAgentSource;
}) {
  const { identity } = useAuthenticatedIdentity();
  const mobile = useMobile();
  const archived = thread.lifecycleState === "archived";
  const queryClient = useQueryClient();
  const [shareOpen, setShareOpen] = React.useState(false);
  const openShare = () => setShareOpen(true);
  const mentions = useComposerMentions(thread, identity.id, openShare);
  useFollowOnOpen(thread, identity.id);
  const headerProps = {
    thread,
    project,
    shareOpen,
    onShareOpenChange: setShareOpen,
  };
  const centerFiles = useCenterFileTabs(thread.id);
  const {
    files,
    activeFile,
    setActiveFile,
    closeFile,
    fileNavigation,
    resolveFileLink,
    resolveMediaSource,
  } = centerFiles;
  // A notification opens the transcript at a message, so it comes forward
  // from an open file tab.
  const onFocusRequested = () => setActiveFile(undefined);
  const sharedPanelProps = {
    mentions,
    ...(focus === undefined
      ? {}
      : {
          focus,
          onFocusHandled,
          onFocusRequested,
        }),
    ...sharedAgentPanelProps(thread),
    inboundMessages: thread.inboundMessages,
    // The schedule is the owner's: when it runs next, at the transcript's end.
    ...(thread.access === undefined || thread.access === "owner"
      ? {
          transcriptEnd: (
            <ThreadScheduleHint key={thread.id} threadId={thread.id} />
          ),
        }
      : {}),
    ...(thread.access === "contribute"
      ? {
          onAccessChanged: () =>
            void invalidateThreadQueries(queryClient, identity.id, thread.id),
        }
      : {}),
  };
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
  const workspaceStatus =
    liveWorkspaceStatus ??
    realtimeWorkspaceStatus ??
    thread.executionWorkspace.preparationStatus ??
    undefined;
  const toggleRightPane = () =>
    setRightPaneCollapsed((collapsed) => !collapsed);
  const mobileTool = useMobileThreadTool();
  const composerNotice = orbComposerNotice(
    thread,
    Terminal && { mobile, mobileTool, setActiveFile, setRightPaneCollapsed },
  );

  const { workspaceTools, openFilePanes } = useWorkspaceTools({
    thread,
    project,
    Terminal,
    Desktop,
    portalDomain: settingsQuery.data?.portalDomain,
    onReviewPrompt: draft.set,
    onWorkspaceStatusChange: setLiveWorkspaceStatus,
    centerFiles,
  });

  if (mobile) {
    // Archived or still-preparing Threads have no workspace to show.
    const toolsAvailable = !archived && thread.executionWorkspace.ready;
    // Built here, not in renderHeader, so a streamed frame that renders the
    // header with a new model reuses this element and skips the tabs.
    const tabs = toolsAvailable ? (
      <MobileThreadTabs
        tools={workspaceTools}
        activeTool={mobileTool.tool}
        files={files}
        activeFile={activeFile}
        onSelectTool={(tool) => {
          // Showing a tool can render a whole hidden transcript; a
          // transition lets that render yield to input.
          React.startTransition(() => {
            setActiveFile(undefined);
            mobileTool.select(tool);
          });
        }}
        onSelectFile={setActiveFile}
        onCloseFile={closeFile}
      />
    ) : null;
    const panel = (
      <ThreadAgentPanel
        {...retainedImageProps}
        source={agentSource}
        agentInitialization={thread.agentInitialization}
        onOpenModelRouting={openModelRouting}
        archived={archived}
        dictationAvailable={dictationAvailable}
        showArchivedNotice={archived}
        active={
          !toolsAvailable ||
          (activeFile === undefined && mobileTool.tool === "agent")
        }
        additionalPanels={
          toolsAvailable ? (
            <>
              <MobileToolPanels
                tools={workspaceTools}
                activeTool={mobileTool.tool}
                opened={mobileTool.opened}
                fileActive={activeFile !== undefined}
              />
              {openFilePanes}
            </>
          ) : undefined
        }
        draft={draft}
        workspaceReady={thread.executionWorkspace.ready}
        workspaceStatus={workspaceStatus}
        composerNotice={composerNotice}
        optimisticCreation={optimisticCreation}
        onInitialSubmissionObserved={onInitialSubmissionObserved}
        {...sharedPanelProps}
        renderHeader={(transcript) => (
          <>
            <ThreadHeader {...headerProps} transcript={transcript} />
            {tabs}
          </>
        )}
      />
    );
    return (
      <div className="mobile-thread-region">
        <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
        <main className="mobile-pane-content">
          {toolsAvailable ? (
            <ThreadFileNavigationContext value={fileNavigation}>
              <MarkdownFileLinkContext value={resolveFileLink}>
                <MarkdownImageSourceContext value={resolveMediaSource}>
                  {panel}
                </MarkdownImageSourceContext>
              </MarkdownFileLinkContext>
            </ThreadFileNavigationContext>
          ) : (
            panel
          )}
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
            {...sharedPanelProps}
            renderHeader={(transcript) => (
              <ThreadHeader {...headerProps} transcript={transcript} />
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
            {...sharedPanelProps}
            renderHeader={(transcript) => (
              <ThreadHeader {...headerProps} transcript={transcript} />
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
        {...workspaceTools}
        main={
          <ThreadFileNavigationContext value={fileNavigation}>
            <MarkdownFileLinkContext value={resolveFileLink}>
              <MarkdownImageSourceContext value={resolveMediaSource}>
                <ThreadAgentPanel
                  {...retainedImageProps}
                  source={agentSource}
                  agentInitialization={thread.agentInitialization}
                  onOpenModelRouting={openModelRouting}
                  dictationAvailable={dictationAvailable}
                  active={activeFile === undefined}
                  additionalPanels={openFilePanes}
                  draft={draft}
                  workspaceReady={thread.executionWorkspace.ready}
                  workspaceStatus={workspaceStatus}
                  composerNotice={composerNotice}
                  optimisticCreation={optimisticCreation}
                  onInitialSubmissionObserved={onInitialSubmissionObserved}
                  {...sharedPanelProps}
                  renderHeader={(transcript) => (
                    <>
                      <ThreadHeader
                        {...headerProps}
                        transcript={transcript}
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
              </MarkdownImageSourceContext>
            </MarkdownFileLinkContext>
          </ThreadFileNavigationContext>
        }
      />
    </div>
  );
}
