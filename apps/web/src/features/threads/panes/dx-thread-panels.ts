import {
  AppWindow,
  FileText,
  FolderTree,
  GitCompareArrows,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import type { PaneViewKind } from "./pane-layout.js";
import {
  createThreadPanelRegistry,
  type ThreadPanelRegistration,
} from "./thread-panels.js";

const files = {
  id: "files",
  label: "Files",
  Icon: FolderTree,
  command: "thread.open-files",
} satisfies ThreadPanelRegistration<PaneViewKind>;

const changes = {
  id: "changes",
  label: "Changes",
  Icon: GitCompareArrows,
  command: "thread.open-changes",
} satisfies ThreadPanelRegistration<PaneViewKind>;

const portal = {
  id: "portal",
  label: "Portal",
  Icon: AppWindow,
  command: "thread.open-portal",
} satisfies ThreadPanelRegistration<PaneViewKind>;

const terminal = {
  id: "terminal",
  label: "Terminal",
  Icon: SquareTerminal,
  command: "thread.open-terminal",
} satisfies ThreadPanelRegistration<PaneViewKind>;

const desktop = {
  id: "desktop",
  label: "Desktop",
  Icon: Monitor,
  command: "thread.open-desktop",
} satisfies ThreadPanelRegistration<PaneViewKind>;

const artifacts = {
  id: "artifacts",
  label: "Artifacts",
  Icon: FileText,
  command: "thread.open-artifacts",
} satisfies ThreadPanelRegistration<PaneViewKind>;

/** dx's own Thread panels, registered in the order menus list them. */
export const DX_THREAD_PANELS = createThreadPanelRegistry<PaneViewKind>([
  files,
  changes,
  portal,
  terminal,
  desktop,
  artifacts,
]);
