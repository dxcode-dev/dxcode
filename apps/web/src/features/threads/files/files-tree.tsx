import type {
  ThreadChangedFile,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileTreeData,
  ThreadFileTreeEntry,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeOptions,
  GitStatusEntry,
  FileTree as TreeModel,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  type InfiniteData,
  notifyManager,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  FileText,
} from "lucide-react";
import * as React from "react";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import type { ThreadFilesApi } from "./files-api.js";
import { threadFilesKeys, threadFileTreeOptions } from "./files-queries.js";

/** The handle as a directory, when it is one. */
const asDirectory = (
  handle: FileTreeItemHandle | null,
): FileTreeDirectoryHandle | undefined =>
  handle !== null && "collapse" in handle ? handle : undefined;

const directoryPath = (path: string) =>
  path.endsWith("/") ? path : `${path}/`;
const plainPath = (path: string) =>
  path.endsWith("/") ? path.slice(0, -1) : path;
const emptyLoadingPathsSnapshot = () => "";

const toTreePaths = (entries: readonly ThreadFileTreeEntry[]) => {
  const paths = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const ancestorCount =
      entry.kind === "directory" ? segments.length : segments.length - 1;
    for (let index = 1; index <= ancestorCount; index += 1)
      paths.add(directoryPath(segments.slice(0, index).join("/")));
    if (entry.kind !== "directory") paths.add(entry.path);
  }
  return [...paths].sort();
};

const toTreeGitStatus = (
  gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>,
): readonly GitStatusEntry[] => {
  const directoryStatus = new Map<string, ThreadChangedFile["status"]>();
  const files: GitStatusEntry[] = [];
  for (const [path, status] of gitStatus) {
    files.push({ path, status });
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = directoryPath(segments.slice(0, index).join("/"));
      const previous = directoryStatus.get(ancestor);
      directoryStatus.set(
        ancestor,
        previous === undefined || previous === status ? status : "modified",
      );
    }
  }
  return [
    ...files,
    ...[...directoryStatus].map(([path, status]) => ({ path, status })),
  ].sort((left, right) => left.path.localeCompare(right.path));
};

const serializeCssString = (value: string) => {
  let serialized = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === "\\") serialized += `\\${character}`;
    else if (code === 0) serialized += "�";
    else if (code <= 31 || code === 127)
      serialized += `\\${code.toString(16)} `;
    else serialized += character;
  }
  return `${serialized}"`;
};

const LOADING_STYLE_ATTRIBUTE = "data-thread-files-loading";

/** A blinking dot replaces the folder icon of each directory still loading. */
const loadingCss = (loadingPaths: readonly string[]) =>
  loadingPaths.length === 0
    ? ""
    : `
@keyframes thread-files-blink {
  50% { opacity: 0; }
}
${loadingPaths
  .map((path) => {
    const row = `[data-item-path=${serializeCssString(path)}] > [data-item-section="icon"]`;
    return `${row} > svg {
  display: none;
}
${row}::before {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--foreground);
  animation: thread-files-blink 2.4s ease-in-out infinite;
  content: "";
}`;
  })
  .join("\n")}
@media (prefers-reduced-motion: reduce) {
  [data-item-section="icon"]::before { animation: none !important; }
}`;

/**
 * The tree reads its stylesheet once, when it is created. The loading rules
 * change while it stays mounted, so they live in a style dx owns inside the
 * tree's shadow root.
 */
const syncLoadingStyle = (host: Element | null, css: string) => {
  const shadowRoot = host?.shadowRoot;
  if (shadowRoot === null || shadowRoot === undefined) return;
  const existing = shadowRoot.querySelector(
    `style[${LOADING_STYLE_ATTRIBUTE}]`,
  );
  if (css === "") {
    existing?.remove();
    return;
  }
  const style = existing ?? document.createElement("style");
  if (existing === null) {
    style.setAttribute(LOADING_STYLE_ATTRIBUTE, "");
    shadowRoot.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
};

const expandedPaths = (model: TreeModel) => {
  const paths: string[] = [];
  for (const row of model.getVisibleRows(0, model.getVisibleCount()))
    if (row.kind === "directory" && row.isExpanded) paths.push(row.path);
  return paths;
};

const useLoadingPaths = (
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  expanded: readonly string[],
) => {
  const queryClient = useQueryClient();
  // Observers notify the cache while they render; defer like useIsFetching
  // so this component never updates during another component's render.
  const subscribe = (notify: () => void) =>
    queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify));
  const snapshot = () =>
    expanded
      .filter(
        (path) =>
          queryClient.getQueryState(
            threadFilesKeys.tree(
              threadId,
              worktree,
              plainPath(path) as ThreadFilesPath,
            ),
          )?.status === "pending",
      )
      .join("\0");
  const paths = React.useSyncExternalStore(
    subscribe,
    snapshot,
    emptyLoadingPathsSnapshot,
  );
  return paths === "" ? [] : paths.split("\0");
};

interface TreeLatest {
  readonly entries: readonly ThreadFileTreeEntry[];
  readonly onOpenFile: (path: ThreadFilesPath) => void;
}

/**
 * The tree reports selection after commit; this opens the file against the
 * entries `attach` last committed.
 */
const createTreeSelection = (initial: TreeLatest) => {
  let latest = initial;
  return {
    update: (next: TreeLatest) => {
      latest = next;
    },
    open: (path: string) => {
      const entry = latest.entries.find((candidate) => candidate.path === path);
      if (entry?.kind === "file") latest.onOpenFile(entry.path);
    },
  };
};

const treeOptions = (
  paths: readonly string[],
  selectedPath: ThreadFilesPath | undefined,
  initiallyExpanded: readonly string[],
  gitStatus: readonly GitStatusEntry[],
  onSelect: (path: string) => void,
): FileTreeOptions => ({
  density: "compact",
  flattenEmptyDirectories: false,
  initialExpansion: "closed",
  initialExpandedPaths: initiallyExpanded,
  initialSelectedPaths: selectedPath === undefined ? [] : [selectedPath],
  initialVisibleRowCount: 24,
  paths,
  gitStatus,
  composition: {
    contextMenu: { enabled: true, triggerMode: "right-click" },
  },
  onSelectionChange: (selection) => {
    const selected = selection.at(-1);
    if (selected !== undefined) onSelect(plainPath(selected));
  },
});

const samePaths = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((path, index) => path === right[index]);

/**
 * One tree model lives as long as the worktree's tree. A refresh, a new
 * file, or a status change updates it in place, so rows, scroll position,
 * and expansion never flash through a remount.
 */
const TreeView = ({
  entries,
  expanded,
  gitStatus,
  loadingPaths,
  selectedPath,
  onExpandedChange,
  onOpenFile,
  downloadUrlFor,
  collapseSignal,
}: {
  readonly entries: readonly ThreadFileTreeEntry[];
  readonly expanded: readonly string[];
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly loadingPaths: readonly string[];
  readonly selectedPath?: ThreadFilesPath;
  readonly onExpandedChange: (paths: readonly string[]) => void;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
  readonly downloadUrlFor?: (path: ThreadFilesPath) => string | undefined;
  /** Each change collapses every open folder (the toolbar's Collapse All). */
  readonly collapseSignal: number;
}) => {
  const paths = toTreePaths(entries);
  const statusEntries = toTreeGitStatus(gitStatus);
  const loading = loadingCss(loadingPaths);
  const [selection] = React.useState(() =>
    createTreeSelection({ entries, onOpenFile }),
  );
  // The model reads its options once; later renders sync it in `attach`.
  const [initialOptions] = React.useState(() =>
    treeOptions(paths, selectedPath, expanded, statusEntries, selection.open),
  );
  const model = useFileTree(initialOptions).model;
  const applied = React.useRef({
    paths,
    statusEntries,
    selectedPath,
    collapseSignal,
  });
  const attach = (node: HTMLDivElement | null) => {
    if (node === null) return;
    selection.update({ entries, onOpenFile });
    const current = applied.current;
    if (current.paths !== paths && !samePaths(current.paths, paths))
      model.resetPaths(paths, { initialExpandedPaths: expandedPaths(model) });
    if (current.statusEntries !== statusEntries)
      model.setGitStatus(statusEntries);
    if (current.selectedPath !== selectedPath) {
      if (current.selectedPath !== undefined)
        model.getItem(current.selectedPath)?.deselect();
      if (selectedPath !== undefined) model.getItem(selectedPath)?.select();
    }
    if (current.collapseSignal !== collapseSignal)
      for (const path of expandedPaths(model)) {
        asDirectory(model.getItem(path))?.collapse();
      }
    applied.current = { paths, statusEntries, selectedPath, collapseSignal };
    syncLoadingStyle(node.querySelector("file-tree-container"), loading);
    const syncHeight = () =>
      node.style.setProperty(
        "--thread-files-tree-content-height",
        `${model.getVisibleCount() * model.getItemHeight()}px`,
      );
    syncHeight();
    let previous = expandedPaths(model).join("\0");
    return model.subscribe(() => {
      syncHeight();
      const nextPaths = expandedPaths(model);
      const next = nextPaths.join("\0");
      if (next === previous) return;
      previous = next;
      onExpandedChange(nextPaths);
    });
  };
  return (
    <div
      className="thread-files-tree"
      ref={attach}
      style={
        {
          "--trees-bg-override": "transparent",
          "--trees-border-color-override": "transparent",
          "--trees-fg-override": "var(--foreground)",
          "--trees-fg-muted-override": "var(--muted-foreground)",
          "--trees-git-added-color-override": "var(--success)",
          "--trees-git-deleted-color-override": "var(--destructive)",
          "--trees-git-modified-color-override": "var(--warning)",
          "--trees-git-untracked-color-override": "var(--success)",
          "--trees-padding-inline-override": "8px",
          "--trees-item-padding-x-override": "6px",
          "--trees-font-size-override": "12px",
        } as React.CSSProperties
      }
    >
      <FileTree
        aria-busy={loadingPaths.length > 0 ? "true" : "false"}
        aria-label="Workspace files"
        model={model}
        renderContextMenu={(item, context) => {
          const path = plainPath(item.path) as ThreadFilesPath;
          const act = (action: () => void) => {
            context.close();
            action();
          };
          const copyPath = (
            <button
              className="thread-context-item"
              onClick={() =>
                act(() => void navigator.clipboard.writeText(path))
              }
              role="menuitem"
              type="button"
            >
              <Copy aria-hidden="true" /> Copy Path
            </button>
          );
          if (item.kind !== "file") {
            const expanded =
              asDirectory(model.getItem(item.path))?.isExpanded() === true;
            return (
              <div
                aria-label={`Actions for ${item.name}`}
                className="thread-context-menu thread-files-tree-menu"
                role="menu"
              >
                <button
                  className="thread-context-item"
                  onClick={() =>
                    act(() => {
                      asDirectory(model.getItem(item.path))?.toggle();
                    })
                  }
                  role="menuitem"
                  type="button"
                >
                  {expanded ? (
                    <ChevronsDownUp aria-hidden="true" />
                  ) : (
                    <ChevronsUpDown aria-hidden="true" />
                  )}{" "}
                  {expanded ? "Collapse" : "Expand"}
                </button>
                <hr className="thread-context-separator" />
                {copyPath}
              </div>
            );
          }
          const downloadUrl = downloadUrlFor?.(path);
          return (
            <div
              aria-label={`Actions for ${item.name}`}
              className="thread-context-menu thread-files-tree-menu"
              role="menu"
            >
              <button
                className="thread-context-item"
                onClick={() => act(() => onOpenFile(path))}
                role="menuitem"
                type="button"
              >
                <FileText aria-hidden="true" /> Open
              </button>
              <hr className="thread-context-separator" />
              {downloadUrl === undefined ? null : (
                <button
                  className="thread-context-item"
                  onClick={() => act(() => downloadFromUrl(downloadUrl))}
                  role="menuitem"
                  type="button"
                >
                  <Download aria-hidden="true" /> Download
                </button>
              )}
              {copyPath}
            </div>
          );
        }}
        style={{ colorScheme: "inherit" }}
      />
    </div>
  );
};

/** Keeps one expanded directory's listing live and offers its next page. */
const DirectoryQuery = ({
  api,
  active,
  threadId,
  worktree,
  path,
}: {
  readonly api: ThreadFilesApi;
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly worktree: ThreadFilesWorktreeId;
  readonly path: ThreadFilesPath;
}) => {
  const query = useInfiniteQuery(
    threadFileTreeOptions(api, threadId, worktree, path, active),
  );
  return query.hasNextPage ? (
    <button
      className="thread-files-more"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
      type="button"
    >
      {query.isFetchingNextPage ? "Loading…" : `More in ${path}`}
    </button>
  ) : null;
};

type DirectoryData = InfiniteData<ThreadFileTreeData> | undefined;

/**
 * The cached listings of the expanded directories. The snapshot keeps its
 * identity until one of them changes, so unrelated cache traffic never
 * re-renders the tree.
 */
const useExpandedDirectoryData = (
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
  expanded: readonly string[],
) => {
  const queryClient = useQueryClient();
  const last = React.useRef<readonly DirectoryData[]>([]);
  // Observers notify the cache while they render; defer like useIsFetching
  // so this component never updates during another component's render.
  const subscribe = (notify: () => void) =>
    queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify));
  const snapshot = () => {
    const next = expanded.map((path) =>
      queryClient.getQueryData<InfiniteData<ThreadFileTreeData>>(
        threadFilesKeys.tree(
          threadId,
          worktree,
          plainPath(path) as ThreadFilesPath,
        ),
      ),
    );
    const previous = last.current;
    if (
      previous.length === next.length &&
      next.every((data, index) => data === previous[index])
    )
      return previous;
    last.current = next;
    return next;
  };
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

const mergeDirectoryEntries = (
  entries: readonly ThreadFileTreeEntry[],
  directories: readonly DirectoryData[],
) => {
  if (directories.every((data) => data === undefined)) return entries;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const data of directories)
    for (const page of data?.pages ?? [])
      for (const entry of page.entries) byPath.set(entry.path, entry);
  return [...byPath.values()];
};

export const ThreadFilesTree = ({
  api,
  active = true,
  threadId,
  worktree = "primary" as ThreadFilesWorktreeId,
  entries,
  gitStatus,
  selectedPath,
  onOpenFile,
  downloadUrlFor,
  collapseSignal = 0,
}: {
  readonly api: ThreadFilesApi;
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly worktree?: ThreadFilesWorktreeId;
  readonly entries: readonly ThreadFileTreeEntry[];
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly selectedPath?: ThreadFilesPath;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
  /** Download URL for a file, when this worktree's files can be downloaded. */
  readonly downloadUrlFor?: (path: ThreadFilesPath) => string | undefined;
  /** Each change collapses every open folder. */
  readonly collapseSignal?: number;
}) => {
  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const loadingPaths = useLoadingPaths(threadId, worktree, expanded);
  const directories = useExpandedDirectoryData(threadId, worktree, expanded);
  const merged = mergeDirectoryEntries(entries, directories);
  return (
    <>
      <TreeView
        entries={merged}
        expanded={expanded}
        gitStatus={gitStatus}
        loadingPaths={loadingPaths}
        onExpandedChange={setExpanded}
        onOpenFile={onOpenFile}
        {...(downloadUrlFor === undefined ? {} : { downloadUrlFor })}
        selectedPath={selectedPath}
        collapseSignal={collapseSignal}
      />
      {expanded.map((path) => (
        <DirectoryQuery
          active={active}
          api={api}
          key={path}
          path={plainPath(path) as ThreadFilesPath}
          threadId={threadId}
          worktree={worktree}
        />
      ))}
      <span className="sr-only" role="status">
        {loadingPaths.length > 0
          ? `Loading ${loadingPaths.map(plainPath).join(", ")}…`
          : ""}
      </span>
    </>
  );
};
