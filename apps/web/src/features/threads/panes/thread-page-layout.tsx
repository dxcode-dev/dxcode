import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { THREAD_OPEN_VIEW_EVENT } from "../../../shared/commands/command-provider.js";
import { usePaneLayout } from "./pane-layout-queries.js";
import {
  defaultPaneLayout,
  PANE_VIEW_KINDS,
  type PaneViewKind,
} from "./pane-layout.js";
import { ViewsMenuButton } from "./pane-menus.js";
import { ThreadPaneTree } from "./pane-tree.js";
import type { PaneContents } from "./pane-views.js";
import { useThreadLayoutMode } from "./thread-layout-mode.js";
import { ThreadStackedLayout } from "./thread-stacked-layout.js";

const isViewKind = (value: unknown): value is PaneViewKind =>
  typeof value === "string" &&
  (PANE_VIEW_KINDS as readonly string[]).includes(value);

const eventSnapshot = () => 0;

/** Runs `open` for each view a Thread command asks to open. */
const useOpenViewCommands = (open: (view: PaneViewKind) => void) => {
  const subscribe = (_notify: () => void) => {
    const listener = (event: Event) => {
      const view = (event as CustomEvent<{ view?: unknown }>).detail?.view;
      if (isViewKind(view)) open(view);
    };
    document.addEventListener(THREAD_OPEN_VIEW_EVENT, listener);
    return () => document.removeEventListener(THREAD_OPEN_VIEW_EVENT, listener);
  };
  React.useSyncExternalStore(subscribe, eventSnapshot, eventSnapshot);
};

/**
 * The Thread page below its refresh notice: the title bar, then the pane tree
 * (1024px and up) or the stacked view row and one view (narrower). Both read
 * the same persisted layout.
 */
export function ThreadPageLayout({
  threadId,
  contents,
  renderTitleBar,
}: {
  readonly threadId: ThreadId;
  readonly contents: PaneContents;
  /** The title bar, given the Views button when the layout has panes. */
  readonly renderTitleBar: (slots: {
    readonly views: React.ReactNode;
    readonly stacked: boolean;
  }) => React.ReactNode;
}) {
  const { layout: loaded, dispatch } = usePaneLayout(threadId);
  const layout = loaded ?? defaultPaneLayout();
  const mode = useThreadLayoutMode();
  const openView = (view: PaneViewKind) => {
    if (contents.views[view] === undefined) return;
    React.startTransition(() => dispatch({ type: "open-view", view }));
  };
  useOpenViewCommands(openView);
  if (mode.stacked)
    return (
      <div className="mobile-thread-region thread-page" data-stacked="">
        {renderTitleBar({ views: null, stacked: true })}
        <ThreadStackedLayout
          layout={layout}
          contents={contents}
          dispatch={dispatch}
        />
      </div>
    );
  return (
    <div className="thread-region thread-page">
      {renderTitleBar({
        views: (
          <ViewsMenuButton
            layout={layout}
            contents={contents}
            onOpen={openView}
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
  );
}
