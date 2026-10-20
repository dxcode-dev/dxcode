import { X } from "lucide-react";
import * as React from "react";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import type { CenterFileTab } from "./thread-center-tabs.js";
import { fileTargetKey } from "./transcript-file-link.js";
import {
  renderTool,
  type ToolContent,
  toolPresentation,
  type WorkspaceTool,
} from "./workspace-tools.js";
import "./thread-mobile.css";

/** On a phone each workspace tool takes the whole screen below the header. */
export type MobileThreadTool = "agent" | WorkspaceTool;

// Phone order: the conversation, then what it changed, then the workspace
// views.
const MOBILE_TOOLS = [
  "agent",
  "changes",
  "preview",
  "files",
  "terminal",
  "desktop",
] as const satisfies ReadonlyArray<MobileThreadTool>;

export type MobileWorkspaceTools = {
  readonly changes: React.ReactNode;
  readonly files: ToolContent;
  readonly terminal?: ToolContent;
  readonly preview?: ToolContent;
  readonly desktop?: ToolContent;
};

const tabId = (tool: MobileThreadTool) => `thread-mobile-tab-${tool}`;
const panelId = (tool: WorkspaceTool) => `thread-mobile-${tool}-panel`;
const filename = (path: string) => path.split("/").at(-1) ?? path;

/**
 * Which tool fills the phone screen. A tool mounts the first time it is
 * chosen and then stays mounted, so the Terminal keeps its scrollback and
 * Changes does not refetch on every switch.
 */
export function useMobileThreadTool() {
  const [tool, setTool] = React.useState<MobileThreadTool>("agent");
  const [opened, setOpened] = React.useState<ReadonlySet<MobileThreadTool>>(
    () => new Set(["agent"]),
  );
  const select = (next: MobileThreadTool) => {
    setTool(next);
    setOpened((current) =>
      current.has(next) ? current : new Set([...current, next]),
    );
  };
  return { tool, opened, select };
}

/**
 * Scrolls a newly chosen tab fully into view. An intersection observer
 * reports after the browser lays out, so choosing a tab never forces a
 * layout of the tool it shows, and a tab already in full view stays put.
 */
const revealSelectedTab = (node: HTMLButtonElement | null) => {
  if (node === null) return;
  const observer = new IntersectionObserver(
    ([entry]) => {
      observer.disconnect();
      if (entry !== undefined && entry.intersectionRatio < 1)
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    { root: node.closest('[role="tablist"]'), threshold: 1 },
  );
  observer.observe(node);
  return () => observer.disconnect();
};

const availableTools = (tools: MobileWorkspaceTools) =>
  MOBILE_TOOLS.filter(
    (tool) =>
      (tool !== "terminal" || tools.terminal !== undefined) &&
      (tool !== "preview" || tools.preview !== undefined) &&
      (tool !== "desktop" || tools.desktop !== undefined),
  );

const scrollSelectedIntoView = (node: HTMLButtonElement | null) =>
  node?.scrollIntoView({ block: "nearest", inline: "nearest" });

export function MobileThreadTabs({
  tools,
  activeTool,
  files,
  activeFile,
  onSelectTool,
  onSelectFile,
  onCloseFile,
}: {
  readonly tools: MobileWorkspaceTools;
  readonly activeTool: MobileThreadTool;
  readonly files: readonly CenterFileTab[];
  readonly activeFile?: string;
  readonly onSelectTool: (tool: MobileThreadTool) => void;
  readonly onSelectFile: (key: string) => void;
  readonly onCloseFile: (file: CenterFileTab) => void;
}) {
  return (
    <div
      className="thread-mobile-tabs"
      role="tablist"
      aria-label="Thread views"
    >
      {availableTools(tools).map((tool) => {
        const selected = activeFile === undefined && activeTool === tool;
        const { label, Icon } =
          tool === "agent"
            ? { label: "Agent", Icon: OrbIcon }
            : toolPresentation[tool];
        return (
          <button
            key={tool}
            id={tabId(tool)}
            ref={selected ? revealSelectedTab : undefined}
            type="button"
            role="tab"
            className="thread-mobile-tab"
            aria-selected={selected}
            aria-controls={tool === "agent" ? undefined : panelId(tool)}
            data-active={selected || undefined}
            onClick={() => onSelectTool(tool)}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        );
      })}
      {files.map((file) => {
        const key = fileTargetKey(file);
        const selected = activeFile === key;
        return (
          <span
            key={key}
            className="thread-mobile-file-tab"
            role="presentation"
            data-active={selected || undefined}
          >
            <button
              ref={selected ? revealSelectedTab : undefined}
              type="button"
              role="tab"
              className="thread-mobile-tab"
              aria-selected={selected}
              aria-label={`${file.path}${file.dirty ? " (unsaved)" : ""}`}
              data-active={selected || undefined}
              onClick={() => onSelectFile(key)}
            >
              {filename(file.path)}
              {file.dirty ? <span aria-hidden="true"> •</span> : null}
            </button>
            <button
              type="button"
              className="thread-mobile-file-close"
              aria-label={`Close ${file.path}`}
              onClick={() => {
                if (
                  file.dirty &&
                  !window.confirm(
                    `Discard unsaved changes to ${filename(file.path)}?`,
                  )
                )
                  return;
                onCloseFile(file);
              }}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** The chosen workspace tool, full screen; the agent panel hides itself. */
export function MobileToolPanels({
  tools,
  activeTool,
  opened,
  fileActive,
}: {
  readonly tools: MobileWorkspaceTools;
  readonly activeTool: MobileThreadTool;
  readonly opened: ReadonlySet<MobileThreadTool>;
  /** An open file covers every tool. */
  readonly fileActive: boolean;
}) {
  return (
    <>
      {availableTools(tools).map((tool) => {
        if (tool === "agent" || !opened.has(tool)) return null;
        const active = !fileActive && activeTool === tool;
        return (
          <section
            key={tool}
            id={panelId(tool)}
            className="thread-mobile-tool"
            role="tabpanel"
            aria-labelledby={tabId(tool)}
            hidden={!active}
            inert={!active}
            data-tool={tool}
          >
            {tool === "changes"
              ? tools.changes
              : renderTool(tools[tool], active)}
          </section>
        );
      })}
    </>
  );
}
