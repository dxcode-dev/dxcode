import type {
  ThreadChangedFile,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileTreeData,
  ThreadFileTreeEntry,
  WriteThreadFilesRequest,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type {
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeOptions,
  FileTreeRenameEvent,
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
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FileText,
  FolderPlus,
  Link,
  Pencil,
  Scissors,
  Trash2,
  Upload,
} from "lucide-react";
import * as React from "react";
import { getBrowserCommandRegistry } from "../../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../../shared/commands/shortcut-keycaps.js";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import type { ThreadFilesApi } from "./files-api.js";
import type { FilesDeleteTarget } from "./files-delete-dialog.js";
import { threadFilesKeys, threadFileTreeOptions } from "./files-queries.js";
import {
  baseName,
  childPath,
  freeName,
  parentOf,
  writeErrorMessage,
} from "./files-tree-names.js";

/** A cut or copied entry, waiting for Paste in the same worktree. */
export interface FilesClipboard {
  readonly mode: "cut" | "copy";
  readonly worktree: ThreadFilesWorktreeId;
  readonly path: ThreadFilesPath;
}

/**
 * What the tree may change, for people who can write to the Thread. Absent
 * for View members: the tree offers no write action.
 */
export interface FilesTreeWrites {
  /** One write; rejects with the API's error. */
  readonly write: (request: WriteThreadFilesRequest) => Promise<unknown>;
  /** Pick files to upload into `folder` (the worktree root when undefined). */
  readonly upload: (folder: ThreadFilesPath | undefined) => void;
  readonly requestDelete: (target: FilesDeleteTarget) => void;
  readonly clipboard: FilesClipboard | undefined;
  readonly setClipboard: (clipboard: FilesClipboard | undefined) => void;
  readonly onError: (message: string) => void;
}

/** A toolbar action for the tree: each new `id` runs once. */
export interface FilesTreeCommand {
  readonly id: number;
  readonly kind: "new-file" | "new-folder" | "upload";
}

type Hotkey = Parameters<
  ReturnType<typeof getBrowserCommandRegistry>["getDisplayedKeycaps"]
>[0];
const keycaps = (binding: string) =>
  getBrowserCommandRegistry().getDisplayedKeycaps(binding as Hotkey);

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
  readonly writes?: FilesTreeWrites;
  /** Puts the rows back to the last listing, after a refused write. */
  readonly revert?: () => void;
}

/**
 * The tree reports selection and renames after commit; this answers them
 * against the entries and handlers `attach` last committed.
 */
const createTreeSelection = (initial: TreeLatest) => {
  let latest = initial;
  /** Rows added for New File or New Folder, still being named. */
  const pending = new Map<string, "file" | "directory">();
  // Starting a rename selects its row. Selecting a file opens it, which would
  // take the Files tab away and end the rename, so a rename's own selection
  // opens nothing.
  let renamingUntil = 0;
  return {
    update: (next: TreeLatest) => {
      latest = next;
    },
    open: (path: string) => {
      if (performance.now() < renamingUntil) return;
      const entry = latest.entries.find((candidate) => candidate.path === path);
      if (entry?.kind === "file") latest.onOpenFile(entry.path);
    },
    /** A rename is about to start: its selection must not open the file. */
    renaming: () => {
      renamingUntil = performance.now() + 500;
    },
    pending,
    /**
     * The tree refused a name itself (one already in the folder): say so and
     * drop a New File or New Folder row still waiting for its name.
     */
    renameError: () => {
      pending.clear();
      latest.revert?.();
      latest.writes?.onError("Something with that name already exists here.");
    },
    /** A named new row is created; a renamed row moves. */
    rename: (event: FileTreeRenameEvent) => {
      const writes = latest.writes;
      const from = plainPath(event.sourcePath);
      const to = plainPath(event.destinationPath) as ThreadFilesPath;
      const created = pending.get(from);
      pending.delete(from);
      if (writes === undefined) return;
      const request: WriteThreadFilesRequest | undefined =
        created !== undefined
          ? { action: "create", path: to, kind: created }
          : from === to
            ? undefined
            : { action: "move", from: from as ThreadFilesPath, to };
      if (request === undefined) return;
      const revert = latest.revert;
      writes.write(request).catch((error: unknown) => {
        // The tree already shows the new name; the listing is unchanged.
        revert?.();
        writes.onError(writeErrorMessage(error, baseName(to)));
      });
    },
  };
};

const kindOf = (path: string): "file" | "directory" =>
  path.endsWith("/") ? "directory" : "file";

/**
 * The tree's write actions against its model: naming new rows in place,
 * Duplicate, Paste, the toolbar's target folder, and the file manager keys.
 */
const treeWriteActions = ({
  model,
  selection,
  writes,
  worktree,
  entries,
}: {
  readonly model: TreeModel;
  readonly selection: ReturnType<typeof createTreeSelection>;
  readonly writes?: FilesTreeWrites;
  readonly worktree: ThreadFilesWorktreeId;
  readonly entries: readonly ThreadFileTreeEntry[];
}) => {
  const taken = new Set<string>(entries.map((entry) => entry.path));
  /**
   * The folder a toolbar action targets: the selected folder, or the
   * selected file's; the root when nothing is selected. (The tree reports
   * its first row as focused before anyone uses it, so focus can't decide.)
   */
  const focusedFolder = () => {
    const selected = model.getSelectedPaths().at(-1);
    if (selected === undefined) return undefined;
    return (
      selected.endsWith("/") ? plainPath(selected) : parentOf(selected)
    ) as ThreadFilesPath | undefined;
  };
  /** A new row in `folder`, named in place; naming it creates it. */
  const startCreate = (
    folder: ThreadFilesPath | undefined,
    kind: "file" | "directory",
  ) => {
    const name = freeName(
      taken,
      kind === "directory" ? "untitled folder" : "untitled",
      "plain",
      folder,
    );
    const path = childPath(folder, name);
    if (folder !== undefined)
      asDirectory(model.getItem(directoryPath(folder)))?.expand();
    const row = kind === "directory" ? directoryPath(path) : path;
    selection.pending.set(path, kind);
    model.add(row);
    selection.renaming();
    model.startRenaming(row, { removeIfCanceled: true });
  };
  const run = (request: WriteThreadFilesRequest, name: string) =>
    writes
      ?.write(request)
      .catch((error: unknown) =>
        writes.onError(writeErrorMessage(error, name)),
      );
  const duplicate = (path: ThreadFilesPath) => {
    const folder = parentOf(path) as ThreadFilesPath | undefined;
    const name = freeName(taken, baseName(path), "copy", folder);
    void run({ action: "copy", from: path, to: childPath(folder, name) }, name);
  };
  const paste = (folder: ThreadFilesPath | undefined) => {
    const clipboard = writes?.clipboard;
    if (clipboard === undefined || clipboard.worktree !== worktree) return;
    const source = clipboard.path;
    if (clipboard.mode === "cut") {
      const to = childPath(folder, baseName(source));
      if (to === source) return;
      writes?.setClipboard(undefined);
      void run({ action: "move", from: source, to }, baseName(source));
      return;
    }
    const name = freeName(
      taken,
      baseName(source),
      parentOf(source) === folder ? "copy" : "plain",
      folder,
    );
    void run(
      { action: "copy", from: source, to: childPath(folder, name) },
      name,
    );
  };
  /** Delete, Cut, Copy, and Paste on the focused row, as a file manager has. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (writes === undefined || event.defaultPrevented) return;
    // Typing in the rename field edits the name, never the files.
    const origin = event.nativeEvent.composedPath()[0];
    if (
      origin instanceof HTMLElement &&
      (origin.isContentEditable ||
        origin.tagName === "INPUT" ||
        origin.tagName === "TEXTAREA")
    )
      return;
    const focused = model.getFocusedPath();
    if (focused === null) return;
    const path = plainPath(focused) as ThreadFilesPath;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (
      (event.key === "Delete" && !mod) ||
      (event.metaKey && key === "backspace")
    )
      writes.requestDelete({ path, kind: kindOf(focused) });
    else if (mod && !event.shiftKey && !event.altKey && key === "x")
      writes.setClipboard({ mode: "cut", worktree, path });
    else if (mod && !event.shiftKey && !event.altKey && key === "c")
      writes.setClipboard({ mode: "copy", worktree, path });
    else if (mod && !event.shiftKey && !event.altKey && key === "v")
      paste(
        (focused.endsWith("/") ? path : parentOf(path)) as
          | ThreadFilesPath
          | undefined,
      );
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return { focusedFolder, startCreate, duplicate, paste, onKeyDown };
};

const treeOptions = (
  paths: readonly string[],
  selectedPath: ThreadFilesPath | undefined,
  initiallyExpanded: readonly string[],
  gitStatus: readonly GitStatusEntry[],
  onSelect: (path: string) => void,
  renaming:
    | {
        readonly onRename: (event: FileTreeRenameEvent) => void;
        readonly onError: () => void;
      }
    | undefined,
): FileTreeOptions => ({
  // F2 and Rename… edit a row's name in place; only for people who write.
  renaming: renaming ?? false,
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

const SEPARATOR = <hr className="thread-context-separator" />;

/** A row's menu: reading actions for everyone, write actions for writers. */
function TreeRowMenu({
  item,
  context,
  model,
  selection,
  actions,
  writes,
  worktree,
  onOpenFile,
  downloadUrlFor,
}: {
  readonly item: FileTreeContextMenuItem;
  readonly context: FileTreeContextMenuOpenContext;
  readonly model: TreeModel;
  readonly selection: ReturnType<typeof createTreeSelection>;
  readonly actions: ReturnType<typeof treeWriteActions>;
  readonly writes?: FilesTreeWrites;
  readonly worktree: ThreadFilesWorktreeId;
  readonly onOpenFile: (path: ThreadFilesPath) => void;
  readonly downloadUrlFor?: (path: ThreadFilesPath) => string | undefined;
}) {
  const path = plainPath(item.path) as ThreadFilesPath;
  const folder = item.kind === "file" ? undefined : path;
  const parent = (folder ?? parentOf(path)) as ThreadFilesPath | undefined;
  const act = (action: () => void, restoreFocus = true) => {
    // A rename takes focus into its field; the row must not take it back.
    context.close({ restoreFocus });
    action();
  };
  const entry = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    shortcut?: string,
    renames = false,
  ) => (
    <button
      className="thread-context-item"
      onClick={() => act(action, !renames)}
      role="menuitem"
      type="button"
    >
      {icon} {label}
      {shortcut === undefined ? null : (
        <ShortcutKeycaps
          keycaps={shortcut.startsWith("Mod+") ? keycaps(shortcut) : [shortcut]}
          emptyLabel=""
        />
      )}
    </button>
  );
  const create =
    writes === undefined ? null : (
      <>
        {entry(
          "New File…",
          <FilePlus aria-hidden="true" />,
          () => actions.startCreate(parent, "file"),
          undefined,
          true,
        )}
        {entry(
          "New Folder…",
          <FolderPlus aria-hidden="true" />,
          () => actions.startCreate(parent, "directory"),
          undefined,
          true,
        )}
        {SEPARATOR}
      </>
    );
  const copyPath = entry(
    "Copy Path",
    <Link aria-hidden="true" />,
    () => void navigator.clipboard.writeText(path),
  );
  const clipboard = writes?.clipboard;
  const edits =
    writes === undefined ? null : (
      <>
        {SEPARATOR}
        {entry(
          "Cut",
          <Scissors aria-hidden="true" />,
          () => writes.setClipboard({ mode: "cut", worktree, path }),
          "Mod+X",
        )}
        {entry(
          "Copy",
          <Copy aria-hidden="true" />,
          () => writes.setClipboard({ mode: "copy", worktree, path }),
          "Mod+C",
        )}
        {clipboard === undefined || clipboard.worktree !== worktree
          ? null
          : entry(
              `Paste “${baseName(clipboard.path)}”`,
              <ClipboardPaste aria-hidden="true" />,
              () => actions.paste(parent),
              "Mod+V",
            )}
        {entry("Duplicate", <CopyPlus aria-hidden="true" />, () =>
          actions.duplicate(path),
        )}
        {entry(
          "Rename…",
          <Pencil aria-hidden="true" />,
          () => {
            selection.renaming();
            model.startRenaming(item.path);
          },
          "F2",
          true,
        )}
        {SEPARATOR}
        {entry(
          "Delete",
          <Trash2 aria-hidden="true" />,
          () =>
            writes.requestDelete({
              path,
              kind: item.kind === "file" ? "file" : "directory",
            }),
          "Delete",
        )}
      </>
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
        {entry(
          expanded ? "Collapse" : "Expand",
          expanded ? (
            <ChevronsDownUp aria-hidden="true" />
          ) : (
            <ChevronsUpDown aria-hidden="true" />
          ),
          () => asDirectory(model.getItem(item.path))?.toggle(),
        )}
        {SEPARATOR}
        {create}
        {copyPath}
        {writes === undefined
          ? null
          : entry("Upload Files…", <Upload aria-hidden="true" />, () =>
              writes.upload(path),
            )}
        {edits}
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
      {create}
      {entry("Open", <FileText aria-hidden="true" />, () => onOpenFile(path))}
      {SEPARATOR}
      {downloadUrl === undefined
        ? null
        : entry("Download", <Download aria-hidden="true" />, () =>
            downloadFromUrl(downloadUrl),
          )}
      {copyPath}
      {edits}
    </div>
  );
}

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
  worktree,
  writes,
  command,
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
  readonly worktree: ThreadFilesWorktreeId;
  readonly writes?: FilesTreeWrites;
  readonly command?: FilesTreeCommand;
}) => {
  const paths = toTreePaths(entries);
  const statusEntries = toTreeGitStatus(gitStatus);
  const loading = loadingCss(loadingPaths);
  const [selection] = React.useState(() =>
    createTreeSelection({
      entries,
      onOpenFile,
      ...(writes === undefined ? {} : { writes }),
    }),
  );
  // The model reads its options once; later renders sync it in `attach`.
  // Whether renaming is on is fixed for the tree's life; the panel remounts
  // the tree when the person's access changes.
  const [initialOptions] = React.useState(() =>
    treeOptions(
      paths,
      selectedPath,
      expanded,
      statusEntries,
      selection.open,
      writes === undefined
        ? undefined
        : { onRename: selection.rename, onError: selection.renameError },
    ),
  );
  const model = useFileTree(initialOptions).model;
  const applied = React.useRef({
    paths,
    statusEntries,
    selectedPath,
    collapseSignal,
    command: command?.id,
  });
  const actions = treeWriteActions({
    model,
    selection,
    worktree,
    entries,
    ...(writes === undefined ? {} : { writes }),
  });
  const { focusedFolder, startCreate } = actions;
  const attach = (node: HTMLDivElement | null) => {
    if (node === null) return;
    selection.update({
      entries,
      onOpenFile,
      ...(writes === undefined ? {} : { writes }),
      revert: () =>
        model.resetPaths(applied.current.paths, {
          initialExpandedPaths: expandedPaths(model),
        }),
    });
    const current = applied.current;
    // A listing that lands while a name is being typed would end the
    // rename and drop a new row; it applies once the name field closes.
    const isNaming = () =>
      node
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector("input") != null;
    const naming = isNaming();
    if (!naming && current.paths !== paths && !samePaths(current.paths, paths))
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
    if (
      command !== undefined &&
      current.command !== command.id &&
      writes !== undefined
    ) {
      const folder = focusedFolder();
      if (command.kind === "upload") writes.upload(folder);
      else
        startCreate(
          folder,
          command.kind === "new-folder" ? "directory" : "file",
        );
    }
    applied.current = {
      paths: naming ? current.paths : paths,
      statusEntries,
      selectedPath,
      collapseSignal,
      command: command?.id,
    };
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
      const shown = applied.current.paths;
      if (shown !== paths && !samePaths(shown, paths) && !isNaming()) {
        applied.current = { ...applied.current, paths };
        model.resetPaths(paths, { initialExpandedPaths: expandedPaths(model) });
      }
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
        // Keys from the tree's shadow root reach its host. F2 is seen on the
        // way down, before the tree starts its rename.
        onKeyDownCapture={(event) => {
          if (event.key === "F2") selection.renaming();
        }}
        onKeyDown={actions.onKeyDown}
        renderContextMenu={(item, context) => (
          <TreeRowMenu
            item={item}
            context={context}
            model={model}
            selection={selection}
            actions={actions}
            worktree={worktree}
            onOpenFile={onOpenFile}
            {...(writes === undefined ? {} : { writes })}
            {...(downloadUrlFor === undefined ? {} : { downloadUrlFor })}
          />
        )}
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

/**
 * When the root listing on screen is the Orb's last one, served while it
 * wakes: the time it was read. Reads the cache without observing the query.
 */
const useRootSnapshotTime = (
  threadId: ThreadId,
  worktree: ThreadFilesWorktreeId,
) => {
  const queryClient = useQueryClient();
  const subscribe = (notify: () => void) =>
    queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify));
  const snapshot = () =>
    queryClient.getQueryData<InfiniteData<ThreadFileTreeData>>(
      threadFilesKeys.tree(threadId, worktree),
    )?.pages[0]?.snapshotAt;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
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
  writes,
  command,
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
  /** Write actions; absent for View members. */
  readonly writes?: FilesTreeWrites;
  readonly command?: FilesTreeCommand;
}) => {
  const [expanded, setExpanded] = React.useState<readonly string[]>([]);
  const loadingPaths = useLoadingPaths(threadId, worktree, expanded);
  const directories = useExpandedDirectoryData(threadId, worktree, expanded);
  const merged = mergeDirectoryEntries(entries, directories);
  const snapshotAt = useRootSnapshotTime(threadId, worktree);
  return (
    <>
      {snapshotAt === undefined ? null : (
        <div className="thread-files-recovery" role="status">
          {`Files as of ${new Date(snapshotAt).toLocaleString([], {
            dateStyle: "short",
            timeStyle: "short",
          })} · updating…`}
        </div>
      )}
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
        worktree={worktree}
        {...(writes === undefined ? {} : { writes })}
        {...(command === undefined ? {} : { command })}
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
