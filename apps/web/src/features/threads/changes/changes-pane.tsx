import { Menu } from "@base-ui/react/menu";
import type {
  ThreadChangedFile,
  ThreadChangesData,
  ThreadChangesPath,
  ThreadChangesRange,
  ThreadChangesWorktree,
  ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronsDownUp,
  Columns2,
  Copy,
  FileDiff as FileDiffIcon,
  FileWarning,
  GitCommitHorizontal,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  SquareArrowOutUpRight,
  Upload,
  WrapText,
} from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import {
  type ChangesTransport,
  defaultChangesTransport,
} from "./changes-api.js";
import {
  changesDiffQueryOptions,
  changesHighlightQueryOptions,
  changesQueryOptions,
  invalidateChangesRanges,
  pushChangesMutationOptions,
} from "./changes-queries.js";
import "./changes.css";

export const REVIEW_CHANGES_PROMPT =
  "Review all changes since the Thread's initial source commit, including untracked files.";
const PRIMARY_WORKTREE_ID = "primary" as ThreadChangesWorktreeId;

export function ChangesPane({
  threadId,
  projectName = "Workspace",
  onReviewPrompt,
  onOpenFile,
  transport = defaultChangesTransport,
}: {
  readonly threadId: ThreadId;
  readonly projectName?: string;
  readonly onReviewPrompt: (prompt: string) => void;
  readonly onOpenFile?: (
    worktree: ThreadChangesWorktreeId,
    path: ThreadChangesPath,
    worktreeLabel?: string,
  ) => void;
  readonly transport?: ChangesTransport;
}) {
  const queryClient = useQueryClient();
  const [range, setRange] = React.useState<ThreadChangesRange>({ kind: "all" });
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [rangeMenuOpen, setRangeMenuOpen] = React.useState(false);
  const [diffStyle, setDiffStyle] = React.useState<"unified" | "split">(
    "unified",
  );
  const [overflow, setOverflow] = React.useState<"scroll" | "wrap">("scroll");
  const [sortByName, setSortByName] = React.useState(false);
  const [pushConfirmationOpen, setPushConfirmationOpen] = React.useState(false);
  const changesQuery = useQuery(
    changesQueryOptions(transport, threadId, range),
  );
  useMountEffect(() => {
    if (transport.subscribe === undefined) return;
    let disposed = false;
    let invalidating: Promise<void> | undefined;
    let pending = false;
    const invalidate = () => {
      if (disposed) return;
      pending = true;
      if (invalidating !== undefined) return;
      invalidating = (async () => {
        while (pending && !disposed) {
          pending = false;
          await invalidateChangesRanges(queryClient, threadId);
        }
      })().finally(() => {
        invalidating = undefined;
        if (pending) invalidate();
      });
    };
    const unsubscribe = transport.subscribe(threadId, invalidate);
    return () => {
      disposed = true;
      pending = false;
      unsubscribe();
    };
  });
  const pushMutation = useMutation(
    pushChangesMutationOptions(queryClient, transport, threadId),
  );
  const changes =
    changesQuery.data?.kind === "changes" ? changesQuery.data : undefined;
  const missing = changesQuery.data?.kind === "missing";
  const hasFiles = changes !== undefined && changes.files.length > 0;
  const visibleFiles =
    changes?.files.toSorted((a, b) => {
      const first = sortByName ? (a.path.split("/").at(-1) ?? a.path) : a.path;
      const second = sortByName ? (b.path.split("/").at(-1) ?? b.path) : b.path;
      return first.localeCompare(second) || a.path.localeCompare(b.path);
    }) ?? [];
  const worktrees: ReadonlyArray<ThreadChangesWorktree> =
    changes?.worktrees ??
    (changes === undefined
      ? []
      : [
          {
            id: PRIMARY_WORKTREE_ID,
            name: "Workspace",
            head: changes.head,
            ...(changes.branch === undefined ? {} : { branch: changes.branch }),
          },
        ]);
  const showWorktreeGroups = worktrees.length > 1;
  const showRangeNavigation =
    range.kind !== "all" ||
    hasFiles ||
    (changes?.commits.length ?? 0) > 0 ||
    (changes?.ahead ?? 0) > 0;
  const canPush =
    changes?.freshness === "complete" &&
    changes.branch !== undefined &&
    changes.ahead > 0 &&
    !pushMutation.isPending;

  const selectRange = (next: ThreadChangesRange) => {
    setRange(next);
    setExpanded(new Set());
    setRangeMenuOpen(false);
  };

  const toggleFile = (
    worktree: ThreadChangesWorktreeId,
    path: ThreadChangesPath,
  ) => {
    const identity = `${worktree}:${path}`;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
  };

  const confirmPush = () => {
    if (!canPush || changes === undefined) return;
    void pushMutation
      .mutateAsync({
        expectedCaptureId: changes.captureId,
        idempotencyKey: `push-${crypto.randomUUID()}`,
      })
      .then(() => setPushConfirmationOpen(false))
      .catch(() => undefined);
  };

  return (
    <section className="changes-pane" aria-label="Changes">
      <ChangesToolbar
        changes={changes}
        hasFiles={hasFiles}
        canPush={canPush}
        pushPending={pushMutation.isPending}
        onPush={() => {
          pushMutation.reset();
          setPushConfirmationOpen(true);
        }}
        onReview={() => onReviewPrompt(REVIEW_CHANGES_PROMPT)}
        diffStyle={diffStyle}
        onToggleDiffStyle={() =>
          setDiffStyle((current) =>
            current === "unified" ? "split" : "unified",
          )
        }
        overflow={overflow}
        onToggleOverflow={() =>
          setOverflow((current) => (current === "scroll" ? "wrap" : "scroll"))
        }
        sortByName={sortByName}
        onToggleSort={() => setSortByName((current) => !current)}
        expandedCount={expanded.size}
        onCollapseAll={() => setExpanded(new Set())}
        refreshing={changesQuery.isFetching}
        // The agent edits continuously, so a capture is often briefly behind.
        // Show that quietly on the refresh control instead of a banner.
        updating={changes?.freshness === "stale"}
        capturedAt={changes?.capturedAt}
        onRefresh={() => void changesQuery.refetch()}
      />

      {changes?.truncated ? (
        <div className="changes-stale-notice" role="status">
          This capture exceeds the display limit; the shown file list is
          partial.
        </div>
      ) : null}

      <div
        className="changes-scroll"
        data-empty={!hasFiles || undefined}
        aria-live="polite"
      >
        {changesQuery.isPending ? (
          <ChangesState icon={<LoaderCircle className="changes-spin" />}>
            Loading changes…
          </ChangesState>
        ) : null}
        {changesQuery.error !== null ? (
          <ChangesState>
            <span>{errorMessage(changesQuery.error)}</span>
            <button type="button" onClick={() => void changesQuery.refetch()}>
              <RefreshCw aria-hidden="true" /> Retry
            </button>
          </ChangesState>
        ) : null}
        {missing ? (
          <ChangesState>
            No Changes capture yet. It will appear after the source workspace is
            first activated.
          </ChangesState>
        ) : null}
        {changes !== undefined ? (
          <>
            {hasFiles && !showWorktreeGroups ? (
              <div className="changes-range-heading">{rangeLabel(range)}</div>
            ) : null}
            {changes.files.length === 0 ? (
              <div className="changes-empty" role="status">
                <FileDiffIcon aria-hidden="true" />
                <span>No Changes</span>
              </div>
            ) : (
              <ChangesFileList
                key={JSON.stringify(range)}
                worktrees={worktrees}
                projectName={projectName}
                files={visibleFiles}
                expanded={expanded}
                onToggleFile={toggleFile}
                transport={transport}
                threadId={threadId}
                range={range}
                captureId={changes.captureId}
                diffStyle={diffStyle}
                overflow={overflow}
                onOpenFile={onOpenFile}
              />
            )}
          </>
        ) : null}
      </div>

      {showRangeNavigation ? (
        <footer className="changes-footer">
          <span>
            {changes === undefined
              ? "No commit capture"
              : `${changes.ahead} commit${changes.ahead === 1 ? "" : "s"} ahead of ${changes.upstreamLabel ?? changes.baseline.slice(0, 7)}`}
          </span>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={rangeMenuOpen}
            aria-label="Choose Changes range"
            onClick={() => setRangeMenuOpen((current) => !current)}
          >
            <ChevronDown aria-hidden="true" />
          </button>
        </footer>
      ) : null}

      {rangeMenuOpen ? (
        <ChangesRangeMenu
          range={range}
          commits={changes?.commits ?? []}
          onSelect={selectRange}
          onClose={() => setRangeMenuOpen(false)}
        />
      ) : null}

      {pushConfirmationOpen ? (
        <PushConfirmation
          pending={pushMutation.isPending}
          error={pushMutation.error}
          onCancel={() => setPushConfirmationOpen(false)}
          onConfirm={confirmPush}
        />
      ) : null}
    </section>
  );
}

function ChangesRangeMenu({
  range,
  commits,
  onSelect,
  onClose,
}: {
  readonly range: ThreadChangesRange;
  readonly commits: ThreadChangesData["commits"];
  readonly onSelect: (range: ThreadChangesRange) => void;
  readonly onClose: () => void;
}) {
  return (
    <div
      className="changes-range-menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <RangeOption
        selected={range.kind === "all"}
        onClick={() => onSelect({ kind: "all" })}
      >
        All Changes
      </RangeOption>
      <RangeOption
        selected={range.kind === "uncommitted"}
        onClick={() => onSelect({ kind: "uncommitted" })}
      >
        Uncommitted
      </RangeOption>
      {commits.map((commit) => (
        <RangeOption
          key={commit.sha}
          selected={range.kind === "commit" && range.sha === commit.sha}
          onClick={() => onSelect({ kind: "commit", sha: commit.sha })}
        >
          <GitCommitHorizontal aria-hidden="true" />
          <code>{commit.shortSha}</code>
          <span>{commit.subject}</span>
        </RangeOption>
      ))}
    </div>
  );
}

function PushConfirmation({
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  readonly pending: boolean;
  readonly error: unknown;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <dialog
      className="changes-push-confirmation"
      aria-labelledby="changes-push-confirmation-title"
      open
    >
      <strong id="changes-push-confirmation-title">Push this branch?</strong>
      <p>
        Push uses the current branch and exact remote force-with-lease
        protection.
      </p>
      {error ? <div role="alert">{errorMessage(error)}</div> : null}
      <div>
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={pending}>
          {pending ? "Pushing…" : "Confirm push"}
        </button>
      </div>
    </dialog>
  );
}

function ChangesFileList({
  worktrees,
  projectName,
  files,
  expanded,
  onToggleFile,
  transport,
  threadId,
  range,
  captureId,
  diffStyle,
  overflow,
  onOpenFile,
}: {
  readonly worktrees: ReadonlyArray<ThreadChangesWorktree>;
  readonly projectName: string;
  readonly files: ReadonlyArray<ThreadChangedFile>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggleFile: (
    worktree: ThreadChangesWorktreeId,
    path: ThreadChangesPath,
  ) => void;
  readonly transport: ChangesTransport;
  readonly threadId: ThreadId;
  readonly range: ThreadChangesRange;
  readonly captureId: ThreadChangesData["captureId"];
  readonly diffStyle: "unified" | "split";
  readonly overflow: "scroll" | "wrap";
  readonly onOpenFile?: (
    worktree: ThreadChangesWorktreeId,
    path: ThreadChangesPath,
    worktreeLabel?: string,
  ) => void;
}) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const filesByWorktree = new Map<
    ThreadChangesWorktreeId,
    Array<ThreadChangedFile>
  >();
  for (const file of files) {
    const worktree = file.worktree ?? PRIMARY_WORKTREE_ID;
    const group = filesByWorktree.get(worktree) ?? [];
    group.push(file);
    filesByWorktree.set(worktree, group);
  }
  const renderFile = (
    file: ThreadChangedFile,
    worktree: ThreadChangesWorktreeId,
    worktreeLabel: string | undefined,
    openFile: typeof onOpenFile,
  ) => {
    const identity = `${worktree}:${file.path}`;
    return (
      <ChangedFile
        key={identity}
        file={file}
        worktree={worktree}
        expanded={expanded.has(identity)}
        onToggle={() => onToggleFile(worktree, file.path)}
        transport={transport}
        threadId={threadId}
        range={range}
        captureId={captureId}
        diffStyle={diffStyle}
        overflow={overflow}
        onOpenFile={
          openFile === undefined
            ? undefined
            : (path) =>
                worktreeLabel === undefined
                  ? openFile(worktree, path)
                  : openFile(worktree, path, worktreeLabel)
        }
      />
    );
  };
  if (worktrees.length === 1)
    return files.map((file) =>
      renderFile(
        file,
        file.worktree ?? PRIMARY_WORKTREE_ID,
        undefined,
        onOpenFile,
      ),
    );
  return worktrees.map((worktree) => {
    const group = filesByWorktree.get(worktree.id);
    if (group === undefined || group.length === 0) return null;
    const isCollapsed = collapsed.has(worktree.id);
    return (
      <WorktreeChanges
        key={worktree.id}
        worktree={worktree}
        label={
          worktree.id === PRIMARY_WORKTREE_ID ? projectName : worktree.name
        }
        files={group}
        range={range}
        collapsed={isCollapsed}
        onToggle={() =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(worktree.id)) next.delete(worktree.id);
            else next.add(worktree.id);
            return next;
          })
        }
      >
        {isCollapsed
          ? null
          : group.map((file) =>
              renderFile(
                file,
                worktree.id,
                worktree.id === PRIMARY_WORKTREE_ID
                  ? projectName
                  : worktree.name,
                onOpenFile,
              ),
            )}
      </WorktreeChanges>
    );
  });
}

function WorktreeChanges({
  worktree,
  label,
  files,
  range,
  collapsed,
  onToggle,
  children,
}: {
  readonly worktree: ThreadChangesWorktree;
  readonly label: string;
  readonly files: ReadonlyArray<ThreadChangedFile>;
  readonly range: ThreadChangesRange;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}) {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const revision = `${worktree.branch ?? "detached"}@${worktree.head.slice(0, 7)}`;
  return (
    <section className="changes-worktree" aria-label={`${label} changes`}>
      <button
        type="button"
        className="changes-worktree-trigger"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDown data-open={!collapsed || undefined} aria-hidden="true" />
        <strong>
          {label} · {rangeLabel(range)}
        </strong>
        <span>{revision}</span>
        <small>
          <span className="changes-additions">+{additions}</span>
          <span className="changes-deletions">-{deletions}</span>
          <span>{files.length}</span>
        </small>
      </button>
      {children}
    </section>
  );
}

function ChangesToolbar({
  changes,
  hasFiles,
  canPush,
  pushPending,
  onPush,
  onReview,
  diffStyle,
  onToggleDiffStyle,
  overflow,
  onToggleOverflow,
  sortByName,
  onToggleSort,
  expandedCount,
  onCollapseAll,
  refreshing,
  updating,
  capturedAt,
  onRefresh,
}: {
  readonly changes: ThreadChangesData | undefined;
  readonly hasFiles: boolean;
  readonly canPush: boolean;
  readonly pushPending: boolean;
  readonly onPush: () => void;
  readonly onReview: () => void;
  readonly diffStyle: "unified" | "split";
  readonly onToggleDiffStyle: () => void;
  readonly overflow: "scroll" | "wrap";
  readonly onToggleOverflow: () => void;
  readonly sortByName: boolean;
  readonly onToggleSort: () => void;
  readonly expandedCount: number;
  readonly onCollapseAll: () => void;
  readonly refreshing: boolean;
  readonly updating: boolean;
  readonly capturedAt?: Parameters<typeof formatCaptureTime>[0];
  readonly onRefresh: () => void;
}) {
  return (
    <div className="changes-toolbar">
      <button
        type="button"
        className="changes-action"
        disabled={!canPush}
        onClick={onPush}
        title={pushTitle(changes)}
      >
        {pushPending ? (
          <LoaderCircle className="changes-spin" aria-hidden="true" />
        ) : (
          <Upload aria-hidden="true" />
        )}
        {pushPending ? "Pushing…" : "Push"}
      </button>
      <button
        type="button"
        className="changes-action"
        disabled={!hasFiles}
        onClick={onReview}
      >
        <ListChecks aria-hidden="true" /> Review
      </button>
      {hasFiles ? (
        <>
          <fieldset className="changes-totals">
            <legend className="visually-hidden">Line totals</legend>
            <span className="changes-additions">
              +{changes?.summary.additions ?? "—"}
            </span>
            <span className="changes-deletions">
              -{changes?.summary.deletions ?? "—"}
            </span>
          </fieldset>
          <fieldset className="changes-view-controls" aria-label="Diff view">
            <button
              type="button"
              title="Side-by-side diff"
              aria-label="Side-by-side diff"
              aria-pressed={diffStyle === "split"}
              onClick={onToggleDiffStyle}
            >
              <Columns2 aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Wrap lines"
              aria-label="Wrap lines"
              aria-pressed={overflow === "wrap"}
              onClick={onToggleOverflow}
            >
              <WrapText aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Sort by filename"
              aria-label="Sort by filename"
              aria-pressed={sortByName}
              onClick={onToggleSort}
            >
              <ArrowDownAZ aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Collapse all files"
              aria-label="Collapse all files"
              onClick={onCollapseAll}
              disabled={expandedCount === 0}
            >
              <ChevronsDownUp aria-hidden="true" />
            </button>
          </fieldset>
        </>
      ) : null}
      <button
        type="button"
        className="changes-refresh"
        title={
          updating && capturedAt !== undefined
            ? `Updating changes · last captured ${formatCaptureTime(capturedAt)}`
            : "Refresh changes"
        }
        aria-label={updating ? "Updating changes" : "Refresh changes"}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw
          aria-hidden="true"
          className={refreshing || updating ? "changes-spin" : undefined}
        />
      </button>
    </div>
  );
}

function ChangedFile({
  file,
  worktree,
  expanded,
  onToggle,
  transport,
  threadId,
  range,
  captureId,
  diffStyle,
  overflow,
  onOpenFile,
}: {
  readonly file: ThreadChangedFile;
  readonly worktree: ThreadChangesWorktreeId;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly transport: ChangesTransport;
  readonly threadId: ThreadId;
  readonly range: ThreadChangesRange;
  readonly captureId: ThreadChangesData["captureId"];
  readonly diffStyle: "unified" | "split";
  readonly overflow: "scroll" | "wrap";
  readonly onOpenFile?: (path: ThreadChangesPath) => void;
}) {
  const [copyStatus, setCopyStatus] = React.useState<string>();
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mounted = React.useRef(false);
  const attach = React.useCallback((element: HTMLElement | null) => {
    mounted.current = element !== null;
    return () => {
      mounted.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);
  const copyPath = async () => {
    clearTimeout(copyTimer.current);
    setCopyStatus(undefined);
    let status: string;
    try {
      await navigator.clipboard.writeText(file.path);
      status = "Path copied";
    } catch {
      status = "Could not copy path";
    }
    if (!mounted.current) return;
    setCopyStatus(status);
    copyTimer.current = setTimeout(() => setCopyStatus(undefined), 2000);
  };
  const parts = file.path.split("/");
  const name = parts.at(-1) ?? file.path;
  const directory = parts.slice(0, -1).join("/");
  const canOpenFile = onOpenFile !== undefined && file.status !== "deleted";
  return (
    <article ref={attach} className="changes-file">
      <div className="changes-file-header">
        <button
          type="button"
          className="changes-file-trigger"
          aria-expanded={expanded}
          title={file.path}
          onClick={onToggle}
        >
          <ChevronDown data-open={expanded || undefined} aria-hidden="true" />
          <strong>{name}</strong>
          {directory ? <span>{directory}</span> : null}
          <small>
            {file.additions > 0 ? (
              <span className="changes-additions">+{file.additions}</span>
            ) : null}
            {file.deletions > 0 ? (
              <span className="changes-deletions">-{file.deletions}</span>
            ) : null}
          </small>
          <b title={`Status: ${file.status}`} data-status={file.status}>
            <span aria-hidden="true">{statusBadge(file.status)}</span>
            <span className="visually-hidden">Status {file.status}</span>
          </b>
        </button>
        <Menu.Root>
          <Menu.Trigger
            className="changes-file-menu-trigger"
            aria-label={`Actions for ${file.path}`}
            title="File actions"
          >
            <MoreHorizontal aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              side="bottom"
              align="end"
              sideOffset={4}
              className="changes-menu-positioner"
            >
              <Menu.Popup className="changes-file-menu">
                <Menu.Item onClick={copyPath}>
                  <Copy aria-hidden="true" />
                  Copy Path
                </Menu.Item>
                <Menu.Item
                  disabled={!canOpenFile}
                  onClick={
                    canOpenFile ? () => onOpenFile(file.path) : undefined
                  }
                >
                  <SquareArrowOutUpRight aria-hidden="true" />
                  Open File
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {copyStatus ? (
        <div className="changes-copy-status" role="status">
          {copyStatus}
        </div>
      ) : null}
      {expanded ? (
        <div className="changes-diff-region">
          {file.binary ? (
            <ChangesState icon={<FileWarning />}>
              Binary file preview is unavailable.
            </ChangesState>
          ) : (
            <ChangedFileDiff
              transport={transport}
              threadId={threadId}
              path={file.path}
              worktree={worktree}
              range={range}
              captureId={captureId}
              diffStyle={diffStyle}
              overflow={overflow}
            />
          )}
        </div>
      ) : null}
    </article>
  );
}

function ChangedFileDiff({
  transport,
  threadId,
  path,
  worktree,
  range,
  captureId,
  diffStyle,
  overflow,
}: {
  readonly transport: ChangesTransport;
  readonly threadId: ThreadId;
  readonly path: ThreadChangesPath;
  readonly worktree: ThreadChangesWorktreeId;
  readonly range: ThreadChangesRange;
  readonly captureId: ThreadChangesData["captureId"];
  readonly diffStyle: "unified" | "split";
  readonly overflow: "scroll" | "wrap";
}) {
  const { resolvedAppearance } = useTheme();
  const query = useQuery(
    changesDiffQueryOptions(
      transport,
      threadId,
      path,
      worktree,
      range,
      captureId,
      useQueryClient(),
    ),
  );
  const parsed = React.useMemo(
    () =>
      query.data?.patch
        ? parseDiff(
            query.data.patch,
            path,
            `${threadId}:${captureId}:${worktree}:${JSON.stringify(range)}`,
          )
        : undefined,
    [query.data?.patch, path, threadId, captureId, worktree, range],
  );
  const highlight = useQuery(
    changesHighlightQueryOptions(path, resolvedAppearance),
  );
  if (query.isPending) return <ChangesState>Loading diff…</ChangesState>;
  if (query.error !== null)
    return <ChangesState>{errorMessage(query.error)}</ChangesState>;
  const data = query.data;
  if (data === undefined || data.patch === "")
    return (
      <ChangesState>
        {data?.file.truncated
          ? "This diff exceeds the capture limit."
          : "No textual diff is available."}
      </ChangesState>
    );
  if (parsed === undefined || parsed.length === 0)
    return (
      <ChangesState>The captured diff could not be rendered.</ChangesState>
    );
  if (highlight.isPending)
    return <ChangesState>Loading syntax highlighting…</ChangesState>;
  if (highlight.isError)
    return (
      <div className="changes-diff-fallback" data-overflow={overflow}>
        <div className="changes-diff-retry" role="status">
          Could not load syntax highlighting.{" "}
          <button type="button" onClick={() => void highlight.refetch()}>
            Retry
          </button>
        </div>
        <pre>{data.patch}</pre>
      </div>
    );
  return (
    <div className="changes-diff-view" data-display-only="true">
      {parsed.map((fileDiff) => (
        <FileDiff
          key={`${data.captureId}:${fileDiff.name}`}
          fileDiff={fileDiff}
          className="changes-pierre-diff"
          disableWorkerPool
          options={{
            theme:
              resolvedAppearance === "light" ? "pierre-light" : "pierre-dark",
            themeType: resolvedAppearance,
            diffStyle,
            overflow,
            lineDiffType: "word-alt",
            hunkSeparators: "line-info-basic",
            disableFileHeader: true,
            stickyHeader: false,
          }}
        />
      ))}
      {data.file.truncated ? (
        <div className="changes-diff-truncated">
          Diff truncated at the capture limit.
        </div>
      ) : null}
    </div>
  );
}

function ChangesState({
  icon,
  children,
}: {
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="changes-state" role="status">
      {icon}
      {children}
    </div>
  );
}

function RangeOption({
  selected,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const parseDiff = (
  patch: string,
  path: ThreadChangesPath,
  captureKey: string,
) => {
  const normalized =
    patch.includes("--- ") || patch.includes("diff --git")
      ? patch
      : `--- a/${path}\n+++ b/${path}\n${patch}`;
  try {
    return parsePatchFiles(
      normalized,
      `changes-${encodeURIComponent(path)}-${stableVersion(captureKey)}`,
      true,
    ).flatMap((parsed) => parsed.files);
  } catch {
    return undefined;
  }
};

const stableVersion = (value: string) => {
  let hash = 0;
  for (const character of value)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash >>> 0;
};

const statusBadge = (status: ThreadChangedFile["status"]) =>
  ({ added: "A", deleted: "D", modified: "M", untracked: "U" })[status];

const rangeLabel = (range: ThreadChangesRange) =>
  range.kind === "all"
    ? "ALL CHANGES"
    : range.kind === "uncommitted"
      ? "UNCOMMITTED"
      : `COMMIT ${range.sha.slice(0, 7)}`;

const captureTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatCaptureTime = (value: string) =>
  captureTimeFormatter.format(new Date(value));

const pushTitle = (changes: ThreadChangesData | undefined) => {
  if (changes === undefined) return "Push is unavailable until Changes loads.";
  if (changes.freshness === "stale")
    return "Push is unavailable while the capture is stale.";
  if (changes.branch === undefined)
    return "Push is unavailable from a detached checkout.";
  if (changes.ahead === 0) return "The current branch is up to date.";
  return `Push ${changes.branch} with force-with-lease protection.`;
};

const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Changes are temporarily unavailable.";
