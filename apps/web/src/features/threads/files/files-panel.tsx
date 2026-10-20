import type {
  ThreadChangedFile,
  ThreadChangesWorktree,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  onlineManager,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { lazyRouteComponent } from "@tanstack/react-router";
import { ChevronDown, Files } from "lucide-react";
import * as React from "react";
import {
  type ChangesTransport,
  defaultChangesTransport,
} from "../changes/changes-api.js";
import { changesQueryOptions } from "../changes/changes-queries.js";
import {
  absolutePathFor,
  type FileReveal,
  sandboxFileUrl,
} from "../transcript-file-link.js";
import {
  createThreadFilesApi,
  type ThreadFilesApi,
  ThreadFilesApiError,
} from "./files-api.js";
import {
  saveThreadFileOptions,
  threadFileOptions,
  threadFileTreeOptions,
} from "./files-queries.js";
import "./files.css";

const api = createThreadFilesApi();
// The tree library is the largest dependency of the thread page; the Files
// pane mounts only once opened, so it loads then. `lazyRouteComponent` (not
// React.lazy) reloads the page once if a deploy removed the chunk.
const ThreadFilesTree = lazyRouteComponent(
  () => import("./files-tree.js"),
  "ThreadFilesTree",
);
const ThreadFileViewer = React.lazy(() =>
  import("./file-viewer.js").then((module) => ({
    default: module.ThreadFileViewer,
  })),
);
const loadingFiles = (
  <div className="thread-files-state" role="status">
    <Files className="workspace-loading-glyph" aria-hidden="true" />
    <span className="sr-only">Waking workspace and loading files…</span>
  </div>
);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Files are temporarily unavailable.";
const PRIMARY_WORKTREE = "primary" as ThreadFilesWorktreeId;
const NO_GIT_STATUS: ReadonlyMap<string, ThreadChangedFile["status"]> =
  new Map();
const subscribeToOnlineState = (listener: () => void) =>
  onlineManager.subscribe(listener);
const onlineSnapshot = () => onlineManager.isOnline();
const useOnline = () =>
  React.useSyncExternalStore(
    subscribeToOnlineState,
    onlineSnapshot,
    onlineSnapshot,
  );

const groupGitStatusByWorktree = (
  files: readonly ThreadChangedFile[] | undefined,
) => {
  const byWorktree = new Map<
    string,
    Map<string, ThreadChangedFile["status"]>
  >();
  for (const file of files ?? []) {
    const worktree = file.worktree ?? PRIMARY_WORKTREE;
    const statuses = byWorktree.get(worktree) ?? new Map();
    statuses.set(file.path, file.status);
    byWorktree.set(worktree, statuses);
  }
  return byWorktree;
};

export interface ThreadFileLocation {
  readonly worktree: ThreadFilesWorktreeId;
  readonly worktreeLabel?: string;
  readonly path: ThreadFilesPath;
}

function FilesWorktreeRoot({
  active,
  threadId,
  worktree,
  label,
  grouped,
  gitStatus,
  selectedPath,
  onOpenFile,
  transport,
}: {
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly worktree: Pick<ThreadChangesWorktree, "id" | "branch">;
  readonly label: string;
  readonly grouped: boolean;
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly selectedPath?: ThreadFilesPath;
  readonly onOpenFile: (location: ThreadFileLocation) => void;
  readonly transport: ThreadFilesApi;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const online = useOnline();
  const query = useInfiniteQuery(
    threadFileTreeOptions(transport, threadId, worktree.id, undefined, active),
  );
  const pages = query.data?.pages;
  const entries = pages?.flatMap((page) => page.entries) ?? [];
  const worktreeId = worktree.id;
  const openFile = (path: ThreadFilesPath) =>
    onOpenFile({
      worktree: worktreeId,
      ...(grouped ? { worktreeLabel: label } : {}),
      path,
    });
  const downloadUrlFor = (path: ThreadFilesPath) => {
    const absolute = absolutePathFor({
      kind: "workspace",
      worktree: worktreeId,
      path,
    });
    return absolute === undefined
      ? undefined
      : sandboxFileUrl(threadId, absolute, true);
  };
  // A background refresh keeps the cached tree on screen without a notice;
  // only a lost connection is worth a row.
  const content =
    query.data === undefined && query.isPending ? (
      loadingFiles
    ) : query.data === undefined ? (
      <div className="thread-files-state" role="alert">
        <span>{message(query.error)}</span>
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    ) : (
      <>
        {!online ? (
          <div className="thread-files-recovery" role="status">
            Disconnected
          </div>
        ) : query.isFetching && query.failureCount > 0 ? (
          <div className="thread-files-recovery" role="status">
            Reconnecting…
          </div>
        ) : query.isError ? (
          <div className="thread-files-recovery" role="alert">
            Disconnected. Files will reconnect automatically.
          </div>
        ) : null}
        <React.Suspense fallback={loadingFiles}>
          <ThreadFilesTree
            api={transport}
            active={active}
            entries={entries}
            gitStatus={gitStatus}
            key={worktree.id}
            onOpenFile={openFile}
            downloadUrlFor={downloadUrlFor}
            selectedPath={selectedPath}
            threadId={threadId}
            worktree={worktree.id}
          />
        </React.Suspense>
        {query.hasNextPage ? (
          <button
            className="thread-files-more"
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "More"}
          </button>
        ) : null}
      </>
    );
  if (!grouped) return content;
  return (
    <section className="thread-files-worktree" aria-label={`${label} files`}>
      <button
        className="thread-files-worktree-trigger"
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
      >
        <ChevronDown
          className="thread-files-worktree-chevron"
          data-open={!collapsed || undefined}
          aria-hidden="true"
        />
        <strong className="thread-files-worktree-label">{label}</strong>
        <span className="thread-files-worktree-branch">
          {worktree.branch ?? "detached"}
        </span>
      </button>
      {collapsed ? null : content}
    </section>
  );
}

export const ThreadFilesPanel = ({
  active = true,
  threadId,
  projectName = "Workspace",
  selectedFile,
  onOpenFile,
  transport = api,
  changesTransport = defaultChangesTransport,
}: {
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly projectName?: string;
  readonly selectedFile?: ThreadFileLocation;
  readonly onOpenFile: (location: ThreadFileLocation) => void;
  readonly transport?: ThreadFilesApi;
  readonly changesTransport?: ChangesTransport;
}) => {
  const changes = useQuery({
    ...changesQueryOptions(changesTransport, threadId, { kind: "uncommitted" }),
    enabled: active,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  });
  const captured = changes.data?.kind === "changes" ? changes.data : undefined;
  const worktrees = captured?.worktrees ?? [
    {
      id: PRIMARY_WORKTREE,
      name: projectName,
      head: captured?.head ?? "0000000000000000000000000000000000000000",
      ...(captured?.branch === undefined ? {} : { branch: captured.branch }),
    },
  ];
  const grouped = worktrees.length > 1;
  // The latest capture's statuses stay on screen while the next one is taken;
  // a stale capture is still the best known state of the worktree.
  const files = captured?.files;
  const gitStatusByWorktree = groupGitStatusByWorktree(files);
  return (
    <section className="thread-files-panel">
      <header>
        <strong>Files</strong>
      </header>
      <div className="thread-files-worktrees">
        {worktrees.map((worktree) => (
          <FilesWorktreeRoot
            active={active}
            gitStatus={gitStatusByWorktree.get(worktree.id) ?? NO_GIT_STATUS}
            grouped={grouped}
            key={worktree.id}
            label={
              worktree.id === PRIMARY_WORKTREE ? projectName : worktree.name
            }
            onOpenFile={onOpenFile}
            selectedPath={
              selectedFile?.worktree === worktree.id
                ? selectedFile.path
                : undefined
            }
            threadId={threadId}
            transport={transport}
            worktree={worktree}
          />
        ))}
      </div>
    </section>
  );
};

export const ThreadFilePane = ({
  active = true,
  threadId,
  worktree = PRIMARY_WORKTREE,
  path,
  onDirtyChange,
  reveal,
  revealSequence,
  transport = api,
}: {
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly worktree?: ThreadFilesWorktreeId;
  readonly path: ThreadFilesPath;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly reveal?: FileReveal;
  readonly revealSequence?: number;
  readonly transport?: ThreadFilesApi;
}) => {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [reloadGeneration, setReloadGeneration] = React.useState(0);
  const query = useQuery(
    threadFileOptions(transport, threadId, worktree, path, active),
  );
  const mutation = useMutation(
    saveThreadFileOptions(transport, threadId, worktree, queryClient),
  );
  const references = {
    threadId,
    location: { kind: "workspace" as const, worktree, path },
  };
  if (query.isPending)
    return (
      <div className="thread-files-state" role="status">
        Loading file…
      </div>
    );
  if (query.data === undefined)
    return (
      <div className="thread-files-state" role="alert">
        <span>{message(query.error)}</span>
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  const conflict =
    mutation.error instanceof ThreadFilesApiError &&
    mutation.error.code === "THREAD_FILES_CONFLICT";
  return (
    <React.Suspense
      fallback={
        <div className="thread-files-state" role="status">
          Loading editor…
        </div>
      }
    >
      <ThreadFileViewer
        conflict={conflict}
        connectionError={query.error !== null}
        connectionMessage={
          !online
            ? "Disconnected"
            : query.isFetching && query.failureCount > 0
              ? "Reconnecting…"
              : query.error !== null
                ? "Disconnected. This file will reconnect automatically."
                : undefined
        }
        file={query.data}
        key={`${worktree}:${path}:${reloadGeneration}`}
        onDirtyChange={onDirtyChange}
        onReload={() => {
          void query.refetch().then((result) => {
            if (!result.isSuccess) return;
            mutation.reset();
            onDirtyChange(false);
            setReloadGeneration((current) => current + 1);
          });
        }}
        onPreserveLocal={(onSuccess) => {
          void query.refetch().then((result) => {
            if (!result.isSuccess) return;
            if (onSuccess(result.data)) mutation.reset();
          });
        }}
        onSave={(input, callbacks) => mutation.mutate(input, callbacks)}
        references={references}
        {...(reveal === undefined ? {} : { reveal })}
        {...(revealSequence === undefined ? {} : { revealSequence })}
        saveError={
          mutation.error !== null ? message(mutation.error) : undefined
        }
        saving={mutation.isPending}
      />
    </React.Suspense>
  );
};
