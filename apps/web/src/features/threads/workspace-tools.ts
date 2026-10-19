import {
  AppWindow,
  Files,
  GitCompareArrows,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import type * as React from "react";

/** The Thread's workspace tools, named and drawn alike on every layout. */
export const WORKSPACE_TOOLS = [
  "changes",
  "files",
  "terminal",
  "preview",
  "desktop",
] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

export const toolPresentation = {
  changes: { label: "Changes", Icon: GitCompareArrows },
  files: { label: "Files", Icon: Files },
  terminal: { label: "Terminal", Icon: SquareTerminal },
  preview: { label: "Preview", Icon: AppWindow },
  desktop: { label: "Desktop", Icon: Monitor },
} as const;

export type ToolContent =
  | React.ReactNode
  | ((active: boolean) => React.ReactNode)
  | undefined;

export const renderTool = (content: ToolContent, active: boolean) =>
  typeof content === "function" ? content(active) : content;
