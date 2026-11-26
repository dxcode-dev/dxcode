import type * as React from "react";
import type { PaneViewKind } from "./pane-layout.js";

/** A tab's content: a node, or a function of whether the tab is shown. */
export type PaneTabContent =
  | React.ReactNode
  | ((active: boolean) => React.ReactNode);

export const renderPaneContent = (content: PaneTabContent, active: boolean) =>
  typeof content === "function" ? content(active) : content;

/** A view an installed plugin shows as a panel in the Thread. */
export interface PluginPaneOption {
  readonly plugin: string;
  /** The view's id. */
  readonly pane: string;
  readonly title: string;
  readonly pluginTitle: string;
  /** The view's own icon, `lucide:<name>` or an asset hash. */
  readonly icon?: string;
}

/** What the Views menu hands the plugins' pane items, which load lazily. */
export interface PluginPaneMenuProps {
  readonly renderItem: (option: PluginPaneOption) => React.ReactNode;
}

/** What the pane tree renders in each tab; a view absent here is unavailable. */
export interface PaneContents {
  readonly agent: PaneTabContent;
  readonly views: Partial<Record<PaneViewKind, PaneTabContent>>;
  /** Installed plugins' views; absent where plugin code cannot run. */
  readonly plugin?: (
    tab: import("./pane-layout.js").PluginPaneTab,
    active: boolean,
  ) => React.ReactNode;
  /**
   * In an archived Thread, whether its plugin still lists the tab's view;
   * absent keeps every plugin tab.
   */
  readonly pluginShown?: (
    tab: import("./pane-layout.js").PluginPaneTab,
  ) => boolean;
  /** The Views menu's items for the plugins' views, loaded lazily. */
  readonly pluginMenu?: (props: PluginPaneMenuProps) => React.ReactNode;
  readonly file: (
    target: import("@dx/api").ThreadPaneFileTarget,
    active: boolean,
  ) => React.ReactNode;
  /** Open file tabs with unsaved edits, by tab id. */
  readonly dirtyTabs: ReadonlySet<string>;
}
