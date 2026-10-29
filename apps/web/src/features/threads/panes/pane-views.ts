import {
  AppWindow,
  FolderTree,
  GitCompareArrows,
  type LucideIcon,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import type * as React from "react";
import type { CommandId } from "../../../shared/commands/command-registry.js";
import type { PaneViewKind } from "./pane-layout.js";

/** How each workspace view is named and drawn, on every layout. */
export const PANE_VIEWS: Readonly<
  Record<
    PaneViewKind,
    {
      readonly label: string;
      readonly Icon: LucideIcon;
      readonly command: CommandId;
    }
  >
> = {
  files: { label: "Files", Icon: FolderTree, command: "thread.open-files" },
  changes: {
    label: "Changes",
    Icon: GitCompareArrows,
    command: "thread.open-changes",
  },
  portal: { label: "Portal", Icon: AppWindow, command: "thread.open-portal" },
  terminal: {
    label: "Terminal",
    Icon: SquareTerminal,
    command: "thread.open-terminal",
  },
  desktop: { label: "Desktop", Icon: Monitor, command: "thread.open-desktop" },
};

/** A tab's content: a node, or a function of whether the tab is shown. */
export type PaneTabContent =
  | React.ReactNode
  | ((active: boolean) => React.ReactNode);

export const renderPaneContent = (content: PaneTabContent, active: boolean) =>
  typeof content === "function" ? content(active) : content;

/** What the pane tree renders in each tab; a view absent here is unavailable. */
export interface PaneContents {
  readonly agent: PaneTabContent;
  readonly views: Partial<Record<PaneViewKind, PaneTabContent>>;
  readonly file: (
    target: import("@dx/api").ThreadPaneFileTarget,
    active: boolean,
  ) => React.ReactNode;
  /** Open file tabs with unsaved edits, by tab id. */
  readonly dirtyTabs: ReadonlySet<string>;
}
