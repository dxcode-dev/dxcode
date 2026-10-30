import type {
  ThreadPane,
  ThreadPaneFileTarget,
  ThreadPaneLayout,
  ThreadPaneNode,
  ThreadPaneSplit,
  ThreadPaneTab,
} from "@dx/api";

/** The workspace views a Thread page can open; each is one tab per Thread. */
export type PaneViewKind =
  | "files"
  | "changes"
  | "portal"
  | "terminal"
  | "desktop";
export const PANE_VIEW_KINDS: ReadonlyArray<PaneViewKind> = [
  "files",
  "changes",
  "portal",
  "terminal",
  "desktop",
];

export type PaneSide = "left" | "right" | "top" | "bottom";

export type PaneLayoutAction =
  | {
      readonly type: "open-view";
      readonly view: PaneViewKind;
      readonly pane?: string;
    }
  | {
      readonly type: "open-file";
      readonly target: ThreadPaneFileTarget;
      readonly pane?: string;
    }
  | { readonly type: "activate"; readonly pane: string; readonly tab: string }
  | { readonly type: "close"; readonly tab: string }
  | {
      readonly type: "close-others";
      readonly pane: string;
      readonly tab: string;
    }
  | {
      readonly type: "close-right";
      readonly pane: string;
      readonly tab: string;
    }
  | { readonly type: "close-all"; readonly pane: string }
  | {
      readonly type: "move";
      readonly tab: string;
      readonly to:
        | {
            readonly pane: string;
            readonly index?: number;
            readonly side?: undefined;
          }
        | {
            readonly pane: string;
            readonly side: PaneSide;
            readonly index?: undefined;
          };
    }
  | {
      readonly type: "resize";
      readonly split: string;
      readonly sizes: ReadonlyArray<number>;
    }
  | { readonly type: "focus"; readonly pane: string };

/** No child of a split may take less than this share of it. */
export const PANE_MIN_SHARE = 0.1;

const AGENT_TAB: ThreadPaneTab = { kind: "agent" };

export const fileTargetKey = (target: ThreadPaneFileTarget) =>
  target.kind === "sandbox"
    ? `sandbox:${target.path}`
    : `${target.worktree}:${target.path}`;

/** Stable identity of a tab; the same view or file has one id per Thread. */
export const tabId = (tab: ThreadPaneTab): string => {
  switch (tab.kind) {
    case "terminal":
      return `terminal:${tab.ordinal}`;
    case "file":
      return `file:${fileTargetKey(tab.target)}`;
    default:
      return tab.kind;
  }
};

const filename = (path: string) => path.split("/").at(-1) ?? path;

export const tabLabel = (tab: ThreadPaneTab): string => {
  switch (tab.kind) {
    case "agent":
      return "Agent";
    case "files":
      return "Files";
    case "changes":
      return "Changes";
    case "portal":
      return "Portal";
    case "desktop":
      return "Desktop";
    case "terminal":
      return tab.ordinal === 1 ? "Terminal" : `Terminal ${tab.ordinal}`;
    case "file":
      return filename(tab.target.path);
  }
};

const domSafe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
/** The DOM id of a tab's button, for `aria-controls` and tests. */
export const paneTabDomId = (id: string) => `thread-view-tab-${domSafe(id)}`;
/** The DOM id of a tab's panel. */
export const panelDomId = (id: string) => `thread-view-panel-${domSafe(id)}`;

export const defaultPaneLayout = (): ThreadPaneLayout => ({
  version: 1,
  root: { kind: "pane", id: "p0", tabs: [AGENT_TAB], active: 0 },
  focused: "p0",
  nextPane: 1,
  nextTerminal: 1,
});

/** Every pane in tree order (left to right, top to bottom). */
export const listPanes = (
  layout: ThreadPaneLayout,
): ReadonlyArray<ThreadPane> => {
  const panes: ThreadPane[] = [];
  const walk = (node: ThreadPaneNode) => {
    if (node.kind === "pane") panes.push(node);
    else for (const child of node.children) walk(child);
  };
  walk(layout.root);
  return panes;
};

export const paneOf = (layout: ThreadPaneLayout, paneId: string) =>
  listPanes(layout).find((pane) => pane.id === paneId);

/** The pane holding the tab, with the tab's index in it. */
export const locateTab = (layout: ThreadPaneLayout, id: string) => {
  for (const pane of listPanes(layout)) {
    const index = pane.tabs.findIndex((tab) => tabId(tab) === id);
    if (index !== -1)
      return { pane, index, tab: pane.tabs[index] as ThreadPaneTab };
  }
  return undefined;
};

export const findViewTab = (layout: ThreadPaneLayout, view: PaneViewKind) =>
  listPanes(layout)
    .flatMap((pane) => pane.tabs)
    .find((tab) => tab.kind === view);

export interface FlatPaneTab {
  readonly pane: string;
  readonly tab: ThreadPaneTab;
  readonly id: string;
}

/** Every tab, Agent first and then tree order; the stacked layout's row. */
export const flattenPaneTabs = (
  layout: ThreadPaneLayout,
): ReadonlyArray<FlatPaneTab> => {
  const entries = listPanes(layout).flatMap((pane) =>
    pane.tabs.map((tab) => ({ pane: pane.id, tab, id: tabId(tab) })),
  );
  const agent = entries.find((entry) => entry.tab.kind === "agent");
  return agent === undefined
    ? entries
    : [agent, ...entries.filter((entry) => entry !== agent)];
};

/** The tab shown by the whole page: the focused pane's active tab. */
export const focusedTab = (layout: ThreadPaneLayout) => {
  const pane = paneOf(layout, layout.focused) ?? listPanes(layout)[0];
  return pane?.tabs[pane.active];
};

/** The pane's tabs that were active before its active tab, most recent first. */
const recentTabs = (pane: ThreadPane): ReadonlyArray<ThreadPaneTab> =>
  (pane.recent ?? []).flatMap((index) => {
    const tab = pane.tabs[index];
    return tab === undefined ? [] : [tab];
  });

/**
 * The pane with new tabs, the tab to show, and the tabs shown before it, most
 * recent first. Tabs no longer in `tabs` leave the history. When the tab to
 * show is gone, the most recent remaining one shows, else the tab at
 * `fallback` or the last.
 */
const withTabs = (
  pane: ThreadPane,
  tabs: ReadonlyArray<ThreadPaneTab>,
  shown: ThreadPaneTab | undefined,
  earlier: ReadonlyArray<ThreadPaneTab | undefined>,
  fallback: number,
): ThreadPane => {
  const history = earlier.flatMap((tab) => {
    const index = tab === undefined ? -1 : tabs.indexOf(tab);
    return index === -1 ? [] : [index];
  });
  const shownIndex = shown === undefined ? -1 : tabs.indexOf(shown);
  const active = Math.max(
    0,
    shownIndex !== -1
      ? shownIndex
      : (history[0] ?? Math.min(fallback, tabs.length - 1)),
  );
  const recent = [...new Set(history)].filter((index) => index !== active);
  const { recent: _previous, ...rest } = pane;
  return recent.length === 0
    ? { ...rest, tabs, active }
    : { ...rest, tabs, active, recent };
};

const clampActive = (pane: ThreadPane): ThreadPane => {
  const active = Math.min(Math.max(0, pane.active), pane.tabs.length - 1);
  const next = withTabs(
    pane,
    pane.tabs,
    pane.tabs[active],
    recentTabs(pane),
    active,
  );
  const recent = pane.recent ?? [];
  const nextRecent = next.recent ?? [];
  return next.active === pane.active &&
    nextRecent.length === recent.length &&
    nextRecent.every((index, at) => index === recent[at])
    ? pane
    : next;
};

const normalizeSizes = (sizes: ReadonlyArray<number>, count: number) => {
  let shares =
    sizes.length === count &&
    sizes.every((size) => Number.isFinite(size) && size > 0)
      ? [...sizes]
      : Array.from({ length: count }, () => 1 / count);
  const total = shares.reduce((sum, size) => sum + size, 0);
  shares = shares.map((size) => size / total);
  // Lift every child to the minimum share, taking from the largest ones.
  const minimum = Math.min(PANE_MIN_SHARE, 1 / count);
  for (let guard = 0; guard < count; guard += 1) {
    const deficit = shares.reduce(
      (sum, size) => (size < minimum ? sum + (minimum - size) : sum),
      0,
    );
    if (deficit <= 1e-9) break;
    const donors = shares.filter((size) => size > minimum);
    const donorTotal = donors.reduce((sum, size) => sum + (size - minimum), 0);
    shares = shares.map((size) =>
      size < minimum
        ? minimum
        : size - (deficit * (size - minimum)) / donorTotal,
    );
  }
  return shares;
};

const sameSizes = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
  left.length === right.length &&
  left.every((size, index) => Math.abs(size - (right[index] ?? 0)) < 1e-9);

/**
 * Removes empty panes, collapses single-child splits, merges a child split
 * running in its parent's direction into the parent, and renormalizes sizes.
 */
const normalizeNode = (node: ThreadPaneNode): ThreadPaneNode | undefined => {
  if (node.kind === "pane")
    return node.tabs.length === 0 ? undefined : clampActive(node);
  const children: ThreadPaneNode[] = [];
  const sizes: number[] = [];
  const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
  node.children.forEach((child, index) => {
    const normalized = normalizeNode(child);
    if (normalized === undefined) return;
    const share = (node.sizes[index] ?? 1 / node.children.length) / total;
    if (
      normalized.kind === "split" &&
      normalized.direction === node.direction
    ) {
      normalized.children.forEach((grandchild, grandIndex) => {
        children.push(grandchild);
        sizes.push(share * (normalized.sizes[grandIndex] ?? 0));
      });
      return;
    }
    children.push(normalized);
    sizes.push(share);
  });
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  const normalizedSizes = normalizeSizes(sizes, children.length);
  if (
    children.length === node.children.length &&
    children.every((child, index) => child === node.children[index]) &&
    sameSizes(normalizedSizes, node.sizes)
  )
    return node;
  return { ...node, children, sizes: normalizedSizes };
};

const maxIdNumber = (node: ThreadPaneNode): number => {
  const own = Number(/^[ps](\d+)$/.exec(node.id)?.[1] ?? -1);
  return node.kind === "pane"
    ? own
    : Math.max(own, ...node.children.map(maxIdNumber));
};

/**
 * A layout saved elsewhere may no longer fit: an empty pane, an active index
 * past the tabs, a focused pane that is gone, or no Agent tab. Repairs it.
 */
export const repairPaneLayout = (
  layout: ThreadPaneLayout,
): ThreadPaneLayout => {
  let root = normalizeNode(layout.root) ?? defaultPaneLayout().root;
  const panes = (() => {
    const list: ThreadPane[] = [];
    const walk = (node: ThreadPaneNode) => {
      if (node.kind === "pane") list.push(node);
      else node.children.forEach(walk);
    };
    walk(root);
    return list;
  })();
  if (!panes.some((pane) => pane.tabs.some((tab) => tab.kind === "agent"))) {
    const first = panes[0] as ThreadPane;
    root = replacePane(
      root,
      first.id,
      withTabs(
        first,
        [AGENT_TAB, ...first.tabs],
        first.tabs[first.active],
        recentTabs(first),
        first.active + 1,
      ),
    );
  }
  const paneIds = new Set(
    listPanes({ ...layout, root }).map((pane) => pane.id),
  );
  const focused = paneIds.has(layout.focused)
    ? layout.focused
    : (agentPane({ ...layout, root })?.id ?? [...paneIds][0] ?? "p0");
  const nextPane = Math.max(layout.nextPane, maxIdNumber(root) + 1);
  const terminals = listPanes({ ...layout, root }).flatMap((pane) =>
    pane.tabs.flatMap((tab) => (tab.kind === "terminal" ? [tab.ordinal] : [])),
  );
  const nextTerminal = Math.max(
    layout.nextTerminal,
    ...terminals.map((n) => n + 1),
    1,
  );
  if (
    root === layout.root &&
    focused === layout.focused &&
    nextPane === layout.nextPane &&
    nextTerminal === layout.nextTerminal
  )
    return layout;
  return { ...layout, root, focused, nextPane, nextTerminal };
};

const agentPane = (layout: ThreadPaneLayout) =>
  listPanes(layout).find((pane) =>
    pane.tabs.some((tab) => tab.kind === "agent"),
  );

const replacePane = (
  node: ThreadPaneNode,
  paneId: string,
  replacement: ThreadPaneNode,
): ThreadPaneNode => {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = replacePane(child, paneId, replacement);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
};

const replaceSplit = (
  node: ThreadPaneNode,
  splitId: string,
  update: (split: ThreadPaneSplit) => ThreadPaneSplit,
): ThreadPaneNode => {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return update(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = replaceSplit(child, splitId, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
};

const parentOf = (
  node: ThreadPaneNode,
  paneId: string,
): ThreadPaneSplit | undefined => {
  if (node.kind === "pane") return undefined;
  if (
    node.children.some((child) => child.kind === "pane" && child.id === paneId)
  )
    return node;
  for (const child of node.children) {
    const found = parentOf(child, paneId);
    if (found !== undefined) return found;
  }
  return undefined;
};

const withRoot = (
  layout: ThreadPaneLayout,
  root: ThreadPaneNode | undefined,
) => {
  const normalized = root === undefined ? undefined : normalizeNode(root);
  return repairPaneLayout({
    ...layout,
    root: normalized ?? defaultPaneLayout().root,
  });
};

const removeTab = (pane: ThreadPane, index: number): ThreadPane =>
  withTabs(
    pane,
    pane.tabs.filter((_, tabIndex) => tabIndex !== index),
    pane.tabs[pane.active],
    recentTabs(pane),
    index,
  );

/** Adds a tab and shows it; the tab shown until now becomes the most recent. */
const insertTab = (
  pane: ThreadPane,
  tab: ThreadPaneTab,
  index?: number,
): ThreadPane => {
  const at = Math.min(Math.max(0, index ?? pane.tabs.length), pane.tabs.length);
  return withTabs(
    pane,
    [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)],
    tab,
    [pane.tabs[pane.active], ...recentTabs(pane)],
    at,
  );
};

/** Where a new view goes: the asked pane, the focused non-Agent pane, or a new right half. */
const placementPane = (
  layout: ThreadPaneLayout,
  requested: string | undefined,
): ThreadPane | undefined => {
  if (requested !== undefined) return paneOf(layout, requested);
  const focused = paneOf(layout, layout.focused);
  if (
    focused !== undefined &&
    !focused.tabs.some((tab) => tab.kind === "agent")
  )
    return focused;
  return listPanes(layout).find(
    (pane) => !pane.tabs.some((tab) => tab.kind === "agent"),
  );
};

/** Adds a tab to a pane, or opens it in a new pane on the right half. */
const placeTab = (
  layout: ThreadPaneLayout,
  tab: ThreadPaneTab,
  requested: string | undefined,
): ThreadPaneLayout => {
  const target = placementPane(layout, requested);
  if (target !== undefined) {
    const root = replacePane(layout.root, target.id, insertTab(target, tab));
    return withRoot({ ...layout, root, focused: target.id }, root);
  }
  // A split is created with exactly one new pane, so it shares the number.
  const paneId = `p${layout.nextPane}`;
  const splitId = `s${layout.nextPane}`;
  const pane: ThreadPane = { kind: "pane", id: paneId, tabs: [tab], active: 0 };
  const root: ThreadPaneSplit = {
    kind: "split",
    id: splitId,
    direction: "row",
    children: [layout.root, pane],
    sizes: [0.5, 0.5],
  };
  return withRoot(
    { ...layout, root, focused: paneId, nextPane: layout.nextPane + 1 },
    root,
  );
};

const activateTab = (
  layout: ThreadPaneLayout,
  pane: ThreadPane,
  index: number,
): ThreadPaneLayout => {
  if (pane.active === index && layout.focused === pane.id) return layout;
  const next =
    pane.active === index
      ? pane
      : withTabs(
          pane,
          pane.tabs,
          pane.tabs[index],
          [pane.tabs[pane.active], ...recentTabs(pane)],
          index,
        );
  const root = replacePane(layout.root, pane.id, next);
  return { ...layout, root, focused: pane.id };
};

const closeTabs = (
  layout: ThreadPaneLayout,
  pane: ThreadPane,
  keep: (tab: ThreadPaneTab, index: number) => boolean,
): ThreadPaneLayout => {
  const tabs = pane.tabs.filter(keep);
  if (tabs.length === pane.tabs.length) return layout;
  // A closed active tab gives way to the most recent earlier tab still open,
  // else the tab now at its index, or the last.
  const next = withTabs(
    pane,
    tabs,
    pane.tabs[pane.active],
    recentTabs(pane),
    pane.active,
  );
  const root = replacePane(layout.root, pane.id, next);
  return withRoot({ ...layout, root }, root);
};

const moveTab = (
  layout: ThreadPaneLayout,
  id: string,
  to: Extract<PaneLayoutAction, { type: "move" }>["to"],
): ThreadPaneLayout => {
  const source = locateTab(layout, id);
  const target = paneOf(layout, to.pane);
  if (source === undefined || target === undefined) return layout;
  const onlyTab = source.pane.tabs.length === 1;
  if (source.pane.id === target.id && onlyTab) return layout;
  if (to.side === undefined) {
    if (source.pane.id === target.id) {
      // Reorder: the index is in terms of the current tabs.
      const without = removeTab(source.pane, source.index);
      const at = Math.min(
        to.index === undefined
          ? without.tabs.length
          : to.index > source.index
            ? to.index - 1
            : to.index,
        without.tabs.length,
      );
      const reordered = insertTab(without, source.tab, at);
      if (
        reordered.tabs.length === source.pane.tabs.length &&
        reordered.tabs.every((tab, index) => tab === source.pane.tabs[index])
      )
        return activateTab(layout, source.pane, source.index);
      const root = replacePane(layout.root, source.pane.id, reordered);
      return { ...layout, root, focused: source.pane.id };
    }
    let root = replacePane(
      layout.root,
      source.pane.id,
      removeTab(source.pane, source.index),
    );
    root = replacePane(
      root,
      target.id,
      insertTab(target, source.tab, to.index),
    );
    return withRoot({ ...layout, root, focused: target.id }, root);
  }
  // Split: the tab leaves its pane and a new pane appears beside the target.
  const paneId = `p${layout.nextPane}`;
  const newPane: ThreadPane = {
    kind: "pane",
    id: paneId,
    tabs: [source.tab],
    active: 0,
  };
  const direction =
    to.side === "left" || to.side === "right" ? "row" : "column";
  const before = to.side === "left" || to.side === "top";
  let root = replacePane(
    layout.root,
    source.pane.id,
    removeTab(source.pane, source.index),
  );
  const parent = parentOf(root, target.id);
  const nextPane = layout.nextPane + 1;
  if (parent !== undefined && parent.direction === direction) {
    root = replaceSplit(root, parent.id, (split) => {
      const index = split.children.findIndex(
        (child) => child.kind === "pane" && child.id === target.id,
      );
      const share = (split.sizes[index] ?? 0) / 2;
      const children = [...split.children];
      const sizes = [...split.sizes];
      sizes[index] = share;
      children.splice(before ? index : index + 1, 0, newPane);
      sizes.splice(before ? index : index + 1, 0, share);
      return { ...split, children, sizes };
    });
  } else {
    const current = paneOf({ ...layout, root }, target.id);
    if (current === undefined) return layout;
    const split: ThreadPaneSplit = {
      kind: "split",
      id: `s${layout.nextPane}`,
      direction,
      children: before ? [newPane, current] : [current, newPane],
      sizes: [0.5, 0.5],
    };
    root = replacePane(root, target.id, split);
  }
  return withRoot({ ...layout, root, focused: paneId, nextPane }, root);
};

export const reducePaneLayout = (
  layout: ThreadPaneLayout,
  action: PaneLayoutAction,
): ThreadPaneLayout => {
  switch (action.type) {
    case "open-view": {
      const existing = locateTab(
        layout,
        action.view === "terminal" ? "terminal:1" : action.view,
      );
      if (existing !== undefined) {
        const found = findViewTab(layout, action.view);
        const located =
          found === undefined
            ? existing
            : (locateTab(layout, tabId(found)) ?? existing);
        return activateTab(layout, located.pane, located.index);
      }
      const terminal = findViewTab(layout, "terminal");
      if (action.view === "terminal" && terminal !== undefined) {
        const located = locateTab(layout, tabId(terminal));
        return located === undefined
          ? layout
          : activateTab(layout, located.pane, located.index);
      }
      const tab: ThreadPaneTab =
        action.view === "terminal"
          ? { kind: "terminal", ordinal: layout.nextTerminal }
          : { kind: action.view };
      const next =
        action.view === "terminal"
          ? { ...layout, nextTerminal: layout.nextTerminal + 1 }
          : layout;
      return placeTab(next, tab, action.pane);
    }
    case "open-file": {
      const tab: ThreadPaneTab = { kind: "file", target: action.target };
      const existing = locateTab(layout, tabId(tab));
      if (existing !== undefined)
        return activateTab(layout, existing.pane, existing.index);
      const filesPane =
        action.pane === undefined
          ? listPanes(layout).find((pane) =>
              pane.tabs.some((candidate) => candidate.kind === "files"),
            )
          : undefined;
      return placeTab(layout, tab, action.pane ?? filesPane?.id);
    }
    case "activate": {
      const pane = paneOf(layout, action.pane);
      const index =
        pane?.tabs.findIndex((tab) => tabId(tab) === action.tab) ?? -1;
      if (pane === undefined || index === -1) return layout;
      return activateTab(layout, pane, index);
    }
    case "close": {
      const located = locateTab(layout, action.tab);
      if (located === undefined || located.tab.kind === "agent") return layout;
      return closeTabs(
        layout,
        located.pane,
        (_, index) => index !== located.index,
      );
    }
    case "close-others": {
      const pane = paneOf(layout, action.pane);
      if (pane === undefined) return layout;
      return closeTabs(
        layout,
        pane,
        (tab) => tab.kind === "agent" || tabId(tab) === action.tab,
      );
    }
    case "close-right": {
      const pane = paneOf(layout, action.pane);
      const at = pane?.tabs.findIndex((tab) => tabId(tab) === action.tab) ?? -1;
      if (pane === undefined || at === -1) return layout;
      return closeTabs(
        layout,
        pane,
        (tab, index) => tab.kind === "agent" || index <= at,
      );
    }
    case "close-all": {
      const pane = paneOf(layout, action.pane);
      if (pane === undefined) return layout;
      return closeTabs(layout, pane, (tab) => tab.kind === "agent");
    }
    case "move":
      return moveTab(layout, action.tab, action.to);
    case "resize": {
      let found = false;
      const root = replaceSplit(layout.root, action.split, (split) => {
        found = true;
        const sizes = normalizeSizes(action.sizes, split.children.length);
        return sameSizes(sizes, split.sizes) ? split : { ...split, sizes };
      });
      return found && root !== layout.root ? { ...layout, root } : layout;
    }
    case "focus":
      return paneOf(layout, action.pane) === undefined ||
        layout.focused === action.pane
        ? layout
        : { ...layout, focused: action.pane };
  }
};
