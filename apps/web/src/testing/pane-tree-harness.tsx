import type { ThreadPaneLayout } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import * as React from "react";
import {
  type PaneLayoutAction,
  type PaneViewKind,
  reducePaneLayout,
} from "../features/threads/panes/pane-layout.js";
import { ThreadPaneTree } from "../features/threads/panes/pane-tree.js";
import type {
  PaneContents,
  PaneTabContent,
} from "../features/threads/panes/pane-views.js";
import { paneLayoutWith } from "./pane-layouts.js";

const HARNESS_THREAD = "thr_00000000-0000-4000-8000-00000000f1e1" as ThreadId;

/**
 * The pane tree with its layout in local state: tests render views as the
 * Thread page would, without the server-backed layout query.
 */
export function PaneTreeHarness({
  main = null,
  changes,
  files,
  terminal,
  desktop,
  preview,
  open,
  threadId = HARNESS_THREAD,
  initialLayout,
}: {
  readonly main?: React.ReactNode;
  readonly changes?: PaneTabContent;
  readonly files?: PaneTabContent;
  readonly terminal?: PaneTabContent;
  readonly desktop?: PaneTabContent;
  readonly preview?: PaneTabContent;
  /** Views open at first; defaults to every provided view, Changes first. */
  readonly open?: ReadonlyArray<PaneViewKind>;
  readonly threadId?: ThreadId;
  readonly initialLayout?: ThreadPaneLayout;
}) {
  const views: PaneContents["views"] = {
    ...(changes === undefined ? {} : { changes }),
    ...(files === undefined ? {} : { files }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(desktop === undefined ? {} : { desktop }),
    ...(preview === undefined ? {} : { portal: preview }),
  };
  const [layout, setLayout] = React.useState(
    () =>
      initialLayout ??
      paneLayoutWith(
        open ??
          (
            ["changes", "files", "terminal", "portal", "desktop"] as const
          ).filter((view) => views[view] !== undefined),
      ),
  );
  const dispatch = (action: PaneLayoutAction) =>
    setLayout((current) => reducePaneLayout(current, action));
  const contents: PaneContents = {
    agent: main,
    views,
    file: () => null,
    dirtyTabs: new Set(),
  };
  return (
    <ThreadPaneTree
      layout={layout}
      contents={contents}
      threadId={threadId}
      dispatch={dispatch}
    />
  );
}
