import type { ThreadPaneLayout, ThreadPaneTab } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  type PluginPaneRequest,
  THREAD_OPEN_VIEW_EVENT,
  takeThreadViewRequest,
} from "../../../shared/commands/thread-open-view-event.js";
import { RestoredTerminalsContext } from "../../../shared/terminal-session.js";
import { threadQueryOptions } from "../thread-queries.js";
import {
  defaultPaneLayout,
  keepPaneTabs,
  PANE_VIEW_KINDS,
  type PaneLayoutAction,
  type PaneViewKind,
  reducePaneLayout,
  tabId,
  terminalSessions,
} from "./pane-layout.js";
import { usePaneLayout } from "./pane-layout-queries.js";
import { ViewsMenuButton } from "./pane-menus.js";
import { ThreadPaneTree } from "./pane-tree.js";
import type { PaneContents } from "./pane-views.js";
import { TerminalWarmContext } from "./terminal-warm-context.js";
import { useThreadLayoutMode } from "./thread-layout-mode.js";
import { ThreadStackedLayout } from "./thread-stacked-layout.js";

const isViewKind = (value: unknown): value is PaneViewKind =>
  typeof value === "string" &&
  (PANE_VIEW_KINDS as readonly string[]).includes(value);

const eventSnapshot = () => 0;

/**
 * Runs `open` for each view a Thread command asks this Thread's page to
 * open, and for one asked of it just before it opened; `openPlugin` for each
 * plugin pane a plugin asks it to open.
 */
export const useOpenViewCommands = (
  threadId: ThreadId,
  open: (view: PaneViewKind) => void,
  openPlugin?: (request: PluginPaneRequest) => void,
) => {
  const subscribe = (_notify: () => void) => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ view?: unknown; threadId?: unknown }>
      ).detail;
      if (detail?.threadId !== undefined && detail.threadId !== threadId)
        return;
      if (detail?.view === "plugin") {
        openPlugin?.(detail as unknown as PluginPaneRequest);
        return;
      }
      if (detail?.threadId !== undefined) takeThreadViewRequest(threadId);
      if (isViewKind(detail?.view)) open(detail.view);
    };
    const requested = takeThreadViewRequest(threadId);
    if (isViewKind(requested)) open(requested);
    document.addEventListener(THREAD_OPEN_VIEW_EVENT, listener);
    return () => document.removeEventListener(THREAD_OPEN_VIEW_EVENT, listener);
  };
  React.useSyncExternalStore(subscribe, eventSnapshot, eventSnapshot);
};

/** Whether the page can draw the tab: the Agent, a view it has, or a file. */
const servable = (contents: PaneContents) => (tab: ThreadPaneTab) =>
  tab.kind === "file"
    ? contents.dirtyTabs.has(tabId(tab))
    : tab.kind === "plugin"
      ? contents.plugin !== undefined && (contents.pluginShown?.(tab) ?? true)
      : tab.kind === "agent" || contents.views[tab.kind] !== undefined;

/**
 * The layout an archived Thread shows. Its Orb is stopped, so the saved
 * layout keeps only the Agent, Artifacts, files with unsaved edits, and the
 * plugin panes their plugins keep in archived Threads.
 * Changes made meanwhile stay on this page and are never saved, so
 * unarchiving brings back the saved layout.
 */
const useArchivedLayout = (
  archived: boolean,
  saved: ThreadPaneLayout,
  contents: PaneContents,
) => {
  const [edited, setEdited] = React.useState<{
    readonly from: ThreadPaneLayout;
    readonly layout: ThreadPaneLayout;
  }>();
  // Unarchiving forgets them, so archiving again starts from the saved one.
  if (!archived && edited !== undefined) setEdited(undefined);
  const base = edited?.from === saved ? edited.layout : saved;
  const layout = keepPaneTabs(base, servable(contents));
  const dispatch = (action: PaneLayoutAction) =>
    setEdited({ from: saved, layout: reducePaneLayout(layout, action) });
  return { layout, dispatch };
};

/**
 * The Thread page below its refresh notice: the title bar, then the pane tree
 * (1024px and up) or the stacked view row and one view (narrower). Both read
 * the same persisted layout.
 */
export function ThreadPageLayout({
  threadId,
  archived,
  contents,
  renderTitleBar,
}: {
  readonly threadId: ThreadId;
  /** An archived Thread shows only the tabs it can serve (`useArchivedLayout`). */
  readonly archived: boolean;
  readonly contents: PaneContents;
  /** The title bar, given the Views button when the layout has panes. */
  readonly renderTitleBar: (slots: {
    readonly views: React.ReactNode;
    readonly stacked: boolean;
  }) => React.ReactNode;
}) {
  const { layout: loaded, dispatch: saveLayout } = usePaneLayout(threadId);
  const saved = loaded ?? defaultPaneLayout();
  const archivedLayout = useArchivedLayout(archived, saved, contents);
  const { layout, dispatch } = archived
    ? archivedLayout
    : { layout: saved, dispatch: saveLayout };
  // The Terminals the saved layout brought back as this page opened: the
  // page waits for the layout and remounts per Thread (#1847).
  const [restoredTerminals] = React.useState(() => terminalSessions(saved));
  const mode = useThreadLayoutMode();
  // Pointing at Terminal may wake the Orb only for people who may open it.
  const { identity } = useAuthenticatedIdentity();
  const mayOpenTerminal = useQuery({
    ...threadQueryOptions(identity.id, threadId),
    // The Thread page already observes this query; only read its cache.
    enabled: false,
    select: (thread) =>
      thread.lifecycleState === "active" &&
      (thread.access === undefined ||
        thread.access === "owner" ||
        thread.access === "contribute"),
  }).data;
  const openView = (view: PaneViewKind) => {
    if (contents.views[view] === undefined) return;
    React.startTransition(() => dispatch({ type: "open-view", view }));
  };
  const openPluginPane = (tab: {
    readonly plugin: string;
    readonly pane: string;
    readonly title: string;
  }) => {
    if (contents.plugin === undefined) return;
    const { plugin, pane, title } = tab;
    React.startTransition(() =>
      dispatch({ type: "open-plugin-pane", tab: { plugin, pane, title } }),
    );
  };
  useOpenViewCommands(threadId, openView, openPluginPane);
  const page = mode.stacked ? (
    <div className="mobile-thread-region thread-page" data-stacked="">
      {renderTitleBar({ views: null, stacked: true })}
      <ThreadStackedLayout
        layout={layout}
        contents={contents}
        dispatch={dispatch}
      />
    </div>
  ) : (
    <TerminalWarmContext value={mayOpenTerminal ? threadId : undefined}>
      <div className="thread-region thread-page">
        {renderTitleBar({
          views: (
            <ViewsMenuButton
              layout={layout}
              contents={contents}
              onOpen={openView}
              onOpenPluginPane={openPluginPane}
              onNewTerminal={() =>
                React.startTransition(() => dispatch({ type: "new-terminal" }))
              }
            />
          ),
          stacked: false,
        })}
        <ThreadPaneTree
          layout={layout}
          contents={contents}
          threadId={threadId}
          dispatch={dispatch}
        />
      </div>
    </TerminalWarmContext>
  );
  return (
    <RestoredTerminalsContext value={restoredTerminals}>
      {page}
    </RestoredTerminalsContext>
  );
}
