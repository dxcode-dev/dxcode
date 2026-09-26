import type {
  ThreadChangedFile,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileTreeEntry,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type {
  FileTreeOptions,
  GitStatusEntry,
  FileTree as TreeModel,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { ThreadFilesApi } from "./files-api.js";
import { threadFilesKeys, threadFileTreeOptions } from "./files-queries.js";

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

const treeKey = (entries: readonly ThreadFileTreeEntry[]) =>
  entries.map((entry) => `${entry.kind}:${entry.path}`).join("\0");

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

const loadingPresentation = (
  entries: readonly ThreadFileTreeEntry[],
  loadingPaths: readonly string[],
) => {
  const loading = new Set(loadingPaths);
  const attributes: Record<string, "true"> = {};
  let rules = "";
  let directoryIndex = 0;
  for (const path of toTreePaths(entries)) {
    if (!path.endsWith("/")) continue;
    const attribute = `data-loading-directory-${directoryIndex}`;
    if (loading.has(path)) attributes[attribute] = "true";
    rules += `
:host([${attribute}="true"]) [data-item-path=${serializeCssString(path)}] > [data-item-section="icon"] > svg {
  display: none;
}
:host([${attribute}="true"]) [data-item-path=${serializeCssString(path)}] > [data-item-section="icon"]::before {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--foreground);
  animation: thread-files-blink 2.4s ease-in-out infinite;
  content: "";
}`;
    directoryIndex += 1;
  }
  return {
    attributes,
    css: `
@keyframes thread-files-blink {
  50% { opacity: 0; }
}
${rules}
@media (prefers-reduced-motion: reduce) {
  [data-item-section="icon"]::before { animation: none !important; }
}`,
  };
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
  const subscribe = React.useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
    [queryClient],
  );
  const snapshot = React.useCallback(
    () =>
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
        .join("\0"),
    [expanded, queryClient, threadId, worktree],
  );
  const paths = React.useSyncExternalStore(
    subscribe,
    snapshot,
    emptyLoadingPathsSnapshot,
  );
  return paths === "" ? [] : paths.split("\0");
};

const treeOptions = (
  entries: readonly ThreadFileTreeEntry[],
  selectedPath: ThreadFilesPath | undefined,
  initiallyExpanded: readonly string[],
  gitStatus: readonly GitStatusEntry[],
  unsafeCSS: string,
  onOpenFile: (path: ThreadFilesPath) => void,
): FileTreeOptions => {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    density: "compact",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    initialExpandedPaths: initiallyExpanded,
    initialSelectedPaths: selectedPath === undefined ? [] : [selectedPath],
    initialVisibleRowCount: 24,
    paths: toTreePaths(entries),
    gitStatus,
    unsafeCSS,
    onSelectionChange: (paths) => {
      const selected = paths.at(-1);
      if (selected === undefined) return;
      const entry = byPath.get(plainPath(selected) as ThreadFilesPath);
      if (entry?.kind === "file") onOpenFile(entry.path);
    },
  };
};

const TreeView = ({
  entries,
  expanded,
  gitStatus,
  loadingPaths,
  selectedPath,
  onExpandedChange,
  onOpenFile,
}: {
  readonly entries: readonly ThreadFileTreeEntry[];
  readonly expanded: readonly string[];
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly loadingPaths: readonly string[];
  readonly selectedPath?: ThreadFilesPath;
  readonly onExpandedChange: (paths: readonly string[]) => void;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
}) => {
  const statusEntries = React.useMemo(
    () => toTreeGitStatus(gitStatus),
    [gitStatus],
  );
  const loading = React.useMemo(
    () => loadingPresentation(entries, loadingPaths),
    [entries, loadingPaths],
  );
  const model = useFileTree(
    treeOptions(
      entries,
      selectedPath,
      expanded,
      statusEntries,
      loading.css,
      onOpenFile,
    ),
  ).model;
  const previousSelectedPath = React.useRef(selectedPath);
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) return;
      model.setGitStatus(statusEntries);
      const previousSelection = previousSelectedPath.current;
      if (previousSelection !== selectedPath) {
        if (previousSelection !== undefined)
          model.getItem(previousSelection)?.deselect();
        if (selectedPath !== undefined) model.getItem(selectedPath)?.select();
        previousSelectedPath.current = selectedPath;
      }
      let previous = expandedPaths(model).join("\0");
      return model.subscribe(() => {
        const nextPaths = expandedPaths(model);
        const next = nextPaths.join("\0");
        if (next === previous) return;
        previous = next;
        onExpandedChange(nextPaths);
      });
    },
    [model, onExpandedChange, selectedPath, statusEntries],
  );
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
          "--thread-files-tree-content-height": `${model.getVisibleCount() * model.getItemHeight()}px`,
        } as React.CSSProperties
      }
    >
      <FileTree
        {...loading.attributes}
        aria-busy={loadingPaths.length > 0 ? "true" : "false"}
        aria-label="Workspace files"
        model={model}
        style={{ colorScheme: "inherit" }}
      />
    </div>
  );
};

const ChildQueries = ({
  api,
  active,
  threadId,
  worktree,
  rootEntries,
  expanded,
  gitStatus,
  index,
  loaded,
  loadingPaths,
  selectedPath,
  onExpandedChange,
  onOpenFile,
}: {
  readonly api: ThreadFilesApi;
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly worktree: ThreadFilesWorktreeId;
  readonly rootEntries: readonly ThreadFileTreeEntry[];
  readonly expanded: readonly string[];
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly index: number;
  readonly loaded: readonly (readonly ThreadFileTreeEntry[])[];
  readonly loadingPaths: readonly string[];
  readonly selectedPath?: ThreadFilesPath;
  readonly onExpandedChange: (paths: readonly string[]) => void;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
}) => {
  const path = plainPath(expanded[index] ?? "") as ThreadFilesPath;
  const query = useInfiniteQuery(
    threadFileTreeOptions(api, threadId, worktree, path, active),
  );
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const nextLoaded = [...loaded, entries];
  const more = query.hasNextPage ? (
    <button
      className="thread-files-more"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
      type="button"
    >
      {query.isFetchingNextPage ? "Loading…" : `More in ${path}`}
    </button>
  ) : null;
  if (index + 1 < expanded.length)
    return (
      <>
        <ChildQueries
          api={api}
          active={active}
          expanded={expanded}
          gitStatus={gitStatus}
          index={index + 1}
          loaded={nextLoaded}
          loadingPaths={loadingPaths}
          onExpandedChange={onExpandedChange}
          onOpenFile={onOpenFile}
          rootEntries={rootEntries}
          selectedPath={selectedPath}
          threadId={threadId}
          worktree={worktree}
        />
        {more}
      </>
    );
  const byPath = new Map(
    [rootEntries, ...nextLoaded].flat().map((entry) => [entry.path, entry]),
  );
  return (
    <>
      <TreeView
        entries={[...byPath.values()]}
        expanded={expanded}
        gitStatus={gitStatus}
        key={treeKey([...byPath.values()])}
        loadingPaths={loadingPaths}
        onExpandedChange={onExpandedChange}
        onOpenFile={onOpenFile}
        selectedPath={selectedPath}
      />
      {more}
    </>
  );
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
}: {
  readonly api: ThreadFilesApi;
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly worktree?: ThreadFilesWorktreeId;
  readonly entries: readonly ThreadFileTreeEntry[];
  readonly gitStatus: ReadonlyMap<string, ThreadChangedFile["status"]>;
  readonly selectedPath?: ThreadFilesPath;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
}) => {
  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const loadingPaths = useLoadingPaths(threadId, worktree, expanded);
  return (
    <>
      {expanded.length === 0 ? (
        <TreeView
          entries={entries}
          expanded={expanded}
          gitStatus={gitStatus}
          key={treeKey(entries)}
          loadingPaths={loadingPaths}
          onExpandedChange={setExpanded}
          onOpenFile={onOpenFile}
          selectedPath={selectedPath}
        />
      ) : (
        <ChildQueries
          api={api}
          active={active}
          expanded={expanded}
          gitStatus={gitStatus}
          index={0}
          loaded={[]}
          loadingPaths={loadingPaths}
          onExpandedChange={setExpanded}
          onOpenFile={onOpenFile}
          rootEntries={entries}
          selectedPath={selectedPath}
          threadId={threadId}
          worktree={worktree}
        />
      )}
      <span className="sr-only" role="status">
        {loadingPaths.length > 0
          ? `Loading ${loadingPaths.map(plainPath).join(", ")}…`
          : ""}
      </span>
    </>
  );
};
