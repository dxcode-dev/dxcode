import {
  type ProjectData,
  type ThreadChangesPath,
  type ThreadDetailData,
  ThreadFilesPath,
  type ThreadPaneFileTarget,
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
import { projectQueryOptions } from "../projects/project-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { AgentPanel, type AgentPanelOptions } from "./agent-panel.js";
import { ThreadScheduleHint } from "./automations/thread-schedule-hint.js";
import { ChangesPane } from "./changes/changes-pane.js";
import { CenterFilePane } from "./files/center-file-pane.js";
import type { CenterFileTab } from "./files/file-tab.js";
import {
  type ThreadFileLocation,
  ThreadFilesPanel,
} from "./files/files-panel.js";
import type { PendingAttachment } from "./image-attachments.js";
import { OrbDiskNotice } from "./orb-disk/orb-disk-notice.js";
import { OrbMemoryNotice } from "./orb-memory/orb-memory-notice.js";
import {
  fileTargetKey,
  focusedTab,
  listPanes,
  locateTab,
  type PaneLayoutAction,
} from "./panes/pane-layout.js";
import {
  threadPaneLayoutQueryOptions,
  usePaneLayout,
  usePaneLayoutDispatch,
  usePaneLayoutReader,
} from "./panes/pane-layout-queries.js";
import type { PaneContents } from "./panes/pane-views.js";
import { ThreadPageLayout } from "./panes/thread-page-layout.js";
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
import {
  type ThreadFileNavigation,
  ThreadFileNavigationContext,
} from "./thread-file-navigation.js";
import { ThreadHeader } from "./thread-header.js";
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
import { createTranscriptAccess } from "./transcript-access.js";
import {
  absolutePathFor,
  type FileReveal,
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
  // A member of a shared Thread cannot read the owner's Project, and nobody
  // reads a deleted one; the Thread detail carries its name instead.
  const sharedWithMe =
    threadQuery.data?.access !== undefined &&
    threadQuery.data.access !== "owner";
  const projectDeleted = threadQuery.data?.projectDeleted === true;
  const projectUnreadable = sharedWithMe || projectDeleted;
  const projectQuery = useQuery({
    ...projectQueryOptions(
      identity.id,
      threadQuery.data?.projectId as ProjectId,
    ),
    enabled: threadQuery.data !== undefined && !projectUnreadable,
  });
  // A Thread created in this browser knows its Project's name and scope, so
  // it opens without waiting for the Project (a hidden one for No Project).
  const project: ThreadProject | undefined = projectUnreadable
    ? {
        name:
          threadQuery.data?.projectName ??
          (projectDeleted ? "Deleted project" : "Shared project"),
      }
    : (projectQuery.data ??
      (optimisticCreation === undefined
        ? undefined
        : {
            name: optimisticCreation.project?.name ?? PROJECTLESS_PROJECT_NAME,
            workspaceId: optimisticCreation.project?.workspaceId,
          }));
  const projectError = projectUnreadable ? null : projectQuery.error;
  const error =
    [threadQuery.error, projectError].find(isAuthorizationError) ??
    threadQuery.error ??
    projectError;
  const retained = useRetainedThread(
    registry,
    id,
    !isAuthorizationError(error),
  );
  // The saved panes load with the Thread, so the page opens in its layout
  // instead of rebuilding from the default one.
  const layoutQuery = useQuery({
    ...threadPaneLayoutQueryOptions(identity.id, id),
    enabled: !isAuthorizationError(error),
  });
  // A Thread created in this browser has no saved layout yet to wait for.
  const layoutSettled =
    layoutQuery.data !== undefined ||
    layoutQuery.isError ||
    optimisticCreation !== undefined;
  const retry = () => {
    if (threadQuery.data === undefined || threadQuery.error !== null)
      void threadQuery.refetch();
    if (threadQuery.data !== undefined && !projectUnreadable)
      void projectQuery.refetch();
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
    !historyReady ||
    !layoutSettled
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
  onDirtyChange,
  onShowInFiles,
}: {
  readonly active: boolean;
  readonly file: CenterFileTab;
  readonly threadId: ThreadId;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onShowInFiles: () => void;
}) {
  return (
    <section
      className="thread-file-center-panel"
      aria-label={`File ${file.path}`}
    >
      <CenterFilePane
        active={active}
        file={file}
        threadId={threadId}
        onDirtyChange={onDirtyChange}
        onShowInFiles={onShowInFiles}
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

/** Lines to highlight in an open file, bumped each time it is opened again. */
interface FileReveals {
  readonly reveal: FileReveal;
  readonly sequence: number;
}

/**
 * The open files' ephemeral state (what to reveal, unsaved edits) and the
 * transcript's file links that open them. The tabs themselves live in the
 * persisted pane layout. Context values stay stable: a new value re-renders
 * every transcript Markdown consumer, bypassing their memoization.
 */
function useFileTabs(
  threadId: ThreadId,
  dispatch: (action: PaneLayoutAction) => void,
) {
  const [reveals, setReveals] = React.useState<
    ReadonlyMap<string, FileReveals>
  >(() => new Map());
  const [dirtyTabs, setDirtyTabs] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const openTarget = (target: ThreadFileTarget, reveal?: FileReveal) => {
    const id = `file:${fileTargetKey(target)}`;
    if (reveal !== undefined)
      setReveals((current) => {
        const next = new Map(current);
        next.set(id, {
          reveal,
          sequence: (current.get(id)?.sequence ?? 0) + 1,
        });
        return next;
      });
    React.startTransition(() => dispatch({ type: "open-file", target }));
  };
  const openFile = (location: ThreadFileLocation) =>
    openTarget({ kind: "workspace", ...location });
  const setDirty = (id: string, dirty: boolean) =>
    setDirtyTabs((current) => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
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
  const renderFile = (target: ThreadPaneFileTarget, active: boolean) => {
    const id = `file:${fileTargetKey(target)}`;
    const revealed = reveals.get(id);
    const file: CenterFileTab = {
      ...target,
      dirty: dirtyTabs.has(id),
      ...(revealed === undefined
        ? {}
        : { reveal: revealed.reveal, revealSequence: revealed.sequence }),
    };
    return (
      <OpenThreadFilePane
        active={active}
        file={file}
        threadId={threadId}
        onDirtyChange={(dirty) => setDirty(id, dirty)}
        onShowInFiles={() => dispatch({ type: "open-view", view: "files" })}
      />
    );
  };
  return {
    openFile,
    dirtyTabs,
    renderFile,
    fileNavigation,
    resolveFileLink,
    resolveMediaSource,
  };
}

/**
 * The Files view. It subscribes to the layout itself, so highlighting the
 * shown file re-renders the tree and not the page.
 */
function FilesView({
  active,
  threadId,
  projectName,
  onOpenFile,
}: {
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly projectName: string;
  readonly onOpenFile: (location: ThreadFileLocation) => void;
}) {
  const { layout } = usePaneLayout(threadId);
  // The shown file: the focused pane's, else the first pane showing one.
  const shown =
    layout === undefined
      ? undefined
      : [
          focusedTab(layout),
          ...listPanes(layout).map((pane) => pane.tabs[pane.active]),
        ].find((tab) => tab?.kind === "file");
  const selectedFile =
    shown?.kind === "file" && shown.target.kind === "workspace"
      ? { worktree: shown.target.worktree, path: shown.target.path }
      : undefined;
  return (
    <ThreadFilesPanel
      active={active}
      threadId={threadId}
      projectName={projectName}
      selectedFile={selectedFile}
      onOpenFile={onOpenFile}
    />
  );
}

/** Each view's content, shared by the stacked and pane layouts. */
function usePaneViewContents({
  thread,
  project,
  Terminal,
  Desktop,
  portalDomain,
  onReviewPrompt,
  onWorkspaceStatusChange,
  openFile,
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
  readonly openFile: (location: ThreadFileLocation) => void;
}): PaneContents["views"] {
  const [fileNavigationError, setFileNavigationError] =
    React.useState<string>();
  const terminal =
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
    );
  const portal = previewTool(thread, portalDomain);
  const desktop = desktopTool(thread, Desktop);
  const changes = (
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
  );
  const files = (active: boolean) => (
    <FilesView
      active={active}
      threadId={thread.id}
      projectName={project.name}
      onOpenFile={openFile}
    />
  );
  return {
    changes,
    files,
    ...(terminal === undefined ? {} : { terminal }),
    ...(portal === undefined ? {} : { portal }),
    ...(desktop === undefined ? {} : { desktop }),
  };
}

function OrbNotices({
  threadId,
  onAskAgent,
  onOpenTerminal,
}: {
  readonly threadId: ThreadId;
  readonly onAskAgent: (message: string) => void;
  readonly onOpenTerminal: (() => void) | undefined;
}) {
  return (
    <>
      <OrbDiskNotice
        threadId={threadId}
        onAskAgent={onAskAgent}
        onOpenTerminal={onOpenTerminal}
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
  onOpenTerminal: (() => void) | undefined,
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
      onOpenTerminal={onOpenTerminal}
    />
  );
}

const NO_VIEWS: PaneContents["views"] = {};

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
  const archived = thread.lifecycleState === "archived";
  const queryClient = useQueryClient();
  const [shareOpen, setShareOpen] = React.useState(false);
  const openShare = () => setShareOpen(true);
  const mentions = useComposerMentions(thread, identity.id, openShare);
  useFollowOnOpen(thread, identity.id);
  const [transcriptAccess] = React.useState(createTranscriptAccess);
  const dispatch = usePaneLayoutDispatch(thread.id);
  const readLayout = usePaneLayoutReader(thread.id);
  const fileTabs = useFileTabs(thread.id, dispatch);
  const {
    dirtyTabs,
    renderFile,
    fileNavigation,
    resolveFileLink,
    resolveMediaSource,
  } = fileTabs;
  // A notification opens the transcript at a message, so it comes forward
  // from an open file tab.
  const onFocusRequested = () => {
    const located = locateTab(readLayout(), "agent");
    if (located !== undefined)
      dispatch({ type: "activate", pane: located.pane.id, tab: "agent" });
  };
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
  const [liveWorkspaceStatus, setLiveWorkspaceStatus] =
    React.useState<string>();
  const workspaceStatus =
    liveWorkspaceStatus ??
    realtimeWorkspaceStatus ??
    thread.executionWorkspace.preparationStatus ??
    undefined;
  const openTerminal =
    Terminal === undefined
      ? undefined
      : () => dispatch({ type: "open-view", view: "terminal" });
  const composerNotice = orbComposerNotice(thread, openTerminal);
  // Archived or still-preparing Threads have no workspace to show.
  const toolsAvailable = !archived && thread.executionWorkspace.ready;
  const views = usePaneViewContents({
    thread,
    project,
    Terminal,
    Desktop,
    portalDomain: settingsQuery.data?.portalDomain,
    onReviewPrompt: draft.set,
    onWorkspaceStatusChange: setLiveWorkspaceStatus,
    openFile: fileTabs.openFile,
  });
  const agent = (active: boolean) => (
    <ThreadAgentPanel
      {...retainedImageProps}
      source={agentSource}
      onOpenModelRouting={archived ? undefined : openModelRouting}
      archived={archived}
      showArchivedNotice={archived}
      projectDeleted={thread.projectDeleted === true}
      dictationAvailable={dictationAvailable}
      active={active}
      transcriptAccess={transcriptAccess}
      {...(archived ? {} : { draft })}
      workspaceReady={thread.executionWorkspace.ready}
      workspaceStatus={workspaceStatus}
      composerNotice={composerNotice}
      optimisticCreation={optimisticCreation}
      onInitialSubmissionObserved={onInitialSubmissionObserved}
      {...sharedPanelProps}
    />
  );
  const contents: PaneContents = {
    agent,
    views: toolsAvailable ? views : NO_VIEWS,
    file: renderFile,
    dirtyTabs,
  };
  const page = (
    <ThreadPageLayout
      threadId={thread.id}
      contents={contents}
      renderTitleBar={({ views: viewsButton }) => (
        <>
          <ThreadRefreshError message={refreshError} onRetry={onRefreshRetry} />
          <ThreadHeader
            thread={thread}
            project={project}
            shareOpen={shareOpen}
            onShareOpenChange={setShareOpen}
            transcript={transcriptAccess.current}
            views={toolsAvailable ? viewsButton : null}
          />
        </>
      )}
    />
  );
  if (!toolsAvailable) return page;
  return (
    <ThreadFileNavigationContext value={fileNavigation}>
      <MarkdownFileLinkContext value={resolveFileLink}>
        <MarkdownImageSourceContext value={resolveMediaSource}>
          {page}
        </MarkdownImageSourceContext>
      </MarkdownFileLinkContext>
    </ThreadFileNavigationContext>
  );
}
