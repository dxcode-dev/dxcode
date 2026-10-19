import { Menu } from "@base-ui/react/menu";
import {
  EllipsisVertical,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import * as React from "react";
import {
  renderTool,
  type ToolContent,
  toolPresentation,
  WORKSPACE_TOOLS,
  type WorkspaceTool,
} from "./workspace-tools.js";

const RIGHT_PANE_MAX_VIEWPORT_RATIO = 0.46;
const RIGHT_PANE_DEFAULT_WIDTH = 360;
const RIGHT_PANE_MIN_WIDTH = 260;
const RESIZE_HANDLE_WIDTH = 1;

const toolTabId = (tool: WorkspaceTool) => `thread-workspace-tab-${tool}`;
const toolPanelId = (tool: WorkspaceTool) => `thread-${tool}-panel`;

function WorkspaceToolbar({
  tools,
  activeTool,
  focused,
  onSelectTool,
  onToolKeyDown,
  onCaptureFocus,
  onToggleFocus,
}: {
  readonly tools: ReadonlyArray<WorkspaceTool>;
  readonly activeTool: WorkspaceTool;
  readonly focused: boolean;
  readonly onSelectTool: (tool: WorkspaceTool) => void;
  readonly onToolKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tool: WorkspaceTool,
  ) => void;
  readonly onCaptureFocus: () => void;
  readonly onToggleFocus: () => void;
}) {
  const [terminalMenuOpen, setTerminalMenuOpen] = React.useState(false);
  return (
    <header className="right-pane-topbar">
      <div
        className="right-pane-tabs"
        role="tablist"
        aria-label="Workspace tools"
      >
        {tools.map((tool) => {
          const { label, Icon } = toolPresentation[tool];
          const active = activeTool === tool;
          const tab = (
            <button
              id={toolTabId(tool)}
              className="right-pane-tab"
              type="button"
              role="tab"
              aria-controls={toolPanelId(tool)}
              aria-selected={active}
              data-active={active || undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelectTool(tool)}
              onKeyDown={(event) => onToolKeyDown(event, tool)}
              key={tool}
            >
              <Icon />
              {label}
            </button>
          );
          if (tool !== "terminal") return tab;
          return (
            <div
              className="right-pane-terminal-tab"
              role="presentation"
              data-active={active || undefined}
              key={tool}
            >
              {tab}
              <Menu.Root
                open={terminalMenuOpen}
                onOpenChange={(open) => {
                  if (open) onSelectTool("terminal");
                  setTerminalMenuOpen(open);
                }}
              >
                <Menu.Trigger
                  className="right-pane-terminal-options"
                  aria-label="Terminal options"
                  title="Terminal options"
                >
                  <EllipsisVertical aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner
                    className="thread-menu-positioner"
                    align="end"
                    sideOffset={4}
                  >
                    <Menu.Popup className="thread-menu-popup thread-terminal-menu-popup">
                      <Menu.Item
                        className="thread-menu-item"
                        nativeButton
                        render={
                          <button
                            type="submit"
                            form="thread-terminal-environment"
                          />
                        }
                      >
                        <RefreshCw aria-hidden="true" />
                        Refresh environment
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </div>
          );
        })}
      </div>
      <button
        className="thread-workspace-focus-control"
        type="button"
        aria-label={focused ? "Unfocus Pane" : "Focus Pane"}
        title={focused ? "Unfocus Pane" : "Focus Pane"}
        onPointerDown={onCaptureFocus}
        onClick={onToggleFocus}
      >
        {focused ? (
          <Minimize2 aria-hidden="true" />
        ) : (
          <Maximize2 aria-hidden="true" />
        )}
      </button>
    </header>
  );
}

function WorkspaceToolPanel({
  tool,
  activeTool,
  children,
}: {
  readonly tool: WorkspaceTool;
  readonly activeTool: WorkspaceTool;
  readonly children: React.ReactNode;
}) {
  const hidden = activeTool !== tool;
  return (
    <div
      id={toolPanelId(tool)}
      className="right-pane-content"
      role="tabpanel"
      aria-labelledby={toolTabId(tool)}
      aria-label={toolPresentation[tool].label}
      aria-hidden={hidden || undefined}
      hidden={hidden}
      inert={hidden}
    >
      {children}
    </div>
  );
}

const maximumRightPaneWidth = (workspaceWidth: number, viewportWidth: number) =>
  Math.max(
    0,
    Math.min(
      viewportWidth * RIGHT_PANE_MAX_VIEWPORT_RATIO,
      workspaceWidth - RESIZE_HANDLE_WIDTH,
    ),
  );

const clampRightPaneWidth = (
  width: number,
  workspaceWidth: number,
  viewportWidth: number,
) => {
  const maximum = maximumRightPaneWidth(workspaceWidth, viewportWidth);
  const minimum = Math.min(RIGHT_PANE_MIN_WIDTH, maximum);
  return Math.round(Math.min(Math.max(width, minimum), maximum));
};

const observeElementResize = (element: HTMLElement, onResize: () => void) => {
  const observer = new ResizeObserver(onResize);
  observer.observe(element);
  return () => observer.disconnect();
};

export function ThreadDesktopLayout({
  rightPaneCollapsed,
  main,
  terminal,
  desktop,
  changes,
  files,
  preview,
}: {
  readonly rightPaneCollapsed: boolean;
  readonly main: React.ReactNode;
  readonly terminal?: ToolContent;
  /** The Thread's remote desktop; its tab appears only when provided. */
  readonly desktop?: ToolContent;
  readonly changes?: React.ReactNode;
  readonly files?: ToolContent;
  /** Portals; the tab exists only when the deployment serves them. */
  readonly preview?: ToolContent;
}) {
  const previewAvailable = preview !== undefined;
  const desktopAvailable = desktop !== undefined;
  const tools = React.useMemo<ReadonlyArray<WorkspaceTool>>(
    () =>
      WORKSPACE_TOOLS.filter(
        (tool) =>
          (tool !== "preview" || previewAvailable) &&
          (tool !== "desktop" || desktopAvailable),
      ),
    [previewAvailable, desktopAvailable],
  );
  const [rightPaneWidth, setRightPaneWidth] = React.useState(
    RIGHT_PANE_DEFAULT_WIDTH,
  );
  const [rightPaneResizing, setRightPaneResizing] = React.useState(false);
  const [selectedTool, setActiveTool] = React.useState<WorkspaceTool>(() =>
    changes === undefined && terminal !== undefined ? "terminal" : "changes",
  );
  const activeTool = tools.includes(selectedTool) ? selectedTool : "changes";
  const [terminalActivated, setTerminalActivated] = React.useState(
    activeTool === "terminal",
  );
  const [filesActivated, setFilesActivated] = React.useState(false);
  const [previewActivated, setPreviewActivated] = React.useState(false);
  const [desktopActivated, setDesktopActivated] = React.useState(false);
  const [rightPaneFocused, setRightPaneFocused] = React.useState(false);
  const mainPanel = React.useRef<HTMLElement | null>(null);
  const focusRestoreTarget = React.useRef<HTMLElement | null>(null);
  const [rightPaneMaximum, setRightPaneMaximum] = React.useState(() =>
    maximumRightPaneWidth(window.innerWidth, window.innerWidth),
  );
  const effectivelyCollapsed = rightPaneCollapsed && !rightPaneFocused;

  const observePanelGroup = React.useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    const synchronizeWidth = () => {
      const workspaceWidth = node.getBoundingClientRect().width;
      const viewportWidth = window.innerWidth;
      setRightPaneMaximum(maximumRightPaneWidth(workspaceWidth, viewportWidth));
      setRightPaneWidth((currentWidth) =>
        clampRightPaneWidth(currentWidth, workspaceWidth, viewportWidth),
      );
    };
    synchronizeWidth();
    return observeElementResize(node, synchronizeWidth);
  }, []);

  const resizeRightPaneBy = React.useCallback((delta: number) => {
    setRightPaneWidth((currentWidth) => {
      const workspaceWidth =
        document
          .querySelector<HTMLElement>(".thread-panel-group")
          ?.getBoundingClientRect().width ?? window.innerWidth;
      return clampRightPaneWidth(
        currentWidth + delta,
        workspaceWidth,
        window.innerWidth,
      );
    });
  }, []);

  const selectTool = React.useCallback((tool: WorkspaceTool) => {
    if (tool === "files") setFilesActivated(true);
    if (tool === "terminal") setTerminalActivated(true);
    if (tool === "preview") setPreviewActivated(true);
    if (tool === "desktop") setDesktopActivated(true);
    setActiveTool(tool);
  }, []);

  const handleToolKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tool: WorkspaceTool) => {
      const currentIndex = tools.indexOf(tool);
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % tools.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + tools.length) % tools.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tools.length - 1;
      }
      const nextTool = nextIndex === undefined ? undefined : tools[nextIndex];
      if (nextTool === undefined) return;
      event.preventDefault();
      selectTool(nextTool);
      event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelector<HTMLButtonElement>(`#${toolTabId(nextTool)}`)
        ?.focus();
    },
    [selectTool, tools],
  );

  const toggleRightPaneFocus = React.useCallback(() => {
    if (rightPaneFocused) {
      const target = focusRestoreTarget.current;
      focusRestoreTarget.current = null;
      setRightPaneFocused(false);
      requestAnimationFrame(() => {
        const targetWillBeInert =
          rightPaneCollapsed && target?.closest("#thread-right-pane") !== null;
        if (target?.isConnected && !targetWillBeInert) target.focus();
        else mainPanel.current?.focus();
      });
      return;
    }
    if (focusRestoreTarget.current === null) {
      focusRestoreTarget.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    setRightPaneFocused(true);
  }, [rightPaneCollapsed, rightPaneFocused]);

  const captureFocusRestoreTarget = React.useCallback(() => {
    if (rightPaneFocused) return;
    focusRestoreTarget.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [rightPaneFocused]);

  return (
    <div
      className="thread-panel-group"
      data-right-pane-focused={rightPaneFocused || undefined}
      ref={observePanelGroup}
    >
      <section
        className="thread-main-panel"
        hidden={rightPaneFocused}
        inert={rightPaneFocused}
        ref={mainPanel}
        tabIndex={-1}
      >
        {main}
      </section>
      <div
        className="resize-handle right-pane-resize-handle"
        hidden={rightPaneFocused}
        inert={rightPaneFocused}
        role="slider"
        aria-label="Resize right pane"
        aria-orientation="vertical"
        aria-valuemin={Math.min(RIGHT_PANE_MIN_WIDTH, rightPaneMaximum)}
        aria-valuemax={Math.round(rightPaneMaximum)}
        aria-valuenow={effectivelyCollapsed ? undefined : rightPaneWidth}
        data-resize-handle-active={rightPaneResizing || undefined}
        tabIndex={effectivelyCollapsed || rightPaneFocused ? -1 : 0}
        onKeyDown={(event) => {
          if (effectivelyCollapsed || rightPaneFocused) return;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeRightPaneBy(16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeRightPaneBy(-16);
          }
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            !event.isPrimary ||
            effectivelyCollapsed ||
            rightPaneFocused
          )
            return;
          const workspaceWidth =
            event.currentTarget.parentElement?.getBoundingClientRect().width;
          const rightPane = event.currentTarget
            .nextElementSibling as HTMLElement | null;
          if (workspaceWidth === undefined || rightPane === null) return;
          const resizeHandle = event.currentTarget;
          const startX = event.clientX;
          const startWidth = rightPaneWidth;
          let latestWidth = startWidth;
          const resizeSession = new AbortController();
          const finishResize = () => {
            resizeSession.abort();
            setRightPaneWidth(latestWidth);
            setRightPaneResizing(false);
          };
          window.addEventListener(
            "pointermove",
            (moveEvent) => {
              latestWidth = clampRightPaneWidth(
                startWidth + startX - moveEvent.clientX,
                workspaceWidth,
                window.innerWidth,
              );
              rightPane.style.width = `${latestWidth}px`;
              resizeHandle.setAttribute("aria-valuenow", String(latestWidth));
            },
            { signal: resizeSession.signal },
          );
          window.addEventListener("pointerup", finishResize, {
            once: true,
            signal: resizeSession.signal,
          });
          window.addEventListener("pointercancel", finishResize, {
            once: true,
            signal: resizeSession.signal,
          });
          setRightPaneResizing(true);
        }}
      />
      <div
        className="right-pane-panel"
        data-collapsed={effectivelyCollapsed || undefined}
        data-focused={rightPaneFocused || undefined}
        data-resizing={rightPaneResizing || undefined}
        style={{
          width: rightPaneFocused
            ? "100%"
            : rightPaneCollapsed
              ? 0
              : rightPaneWidth,
        }}
      >
        <aside
          id="thread-right-pane"
          className="workspace-pane right-pane"
          aria-label="Right pane"
          inert={effectivelyCollapsed}
        >
          <WorkspaceToolbar
            tools={tools}
            activeTool={activeTool}
            focused={rightPaneFocused}
            onSelectTool={selectTool}
            onToolKeyDown={handleToolKeyDown}
            onCaptureFocus={captureFocusRestoreTarget}
            onToggleFocus={toggleRightPaneFocus}
          />
          <WorkspaceToolPanel tool="changes" activeTool={activeTool}>
            {changes}
          </WorkspaceToolPanel>
          <WorkspaceToolPanel tool="files" activeTool={activeTool}>
            {filesActivated
              ? renderTool(
                  files,
                  !effectivelyCollapsed && activeTool === "files",
                )
              : null}
          </WorkspaceToolPanel>
          <WorkspaceToolPanel tool="terminal" activeTool={activeTool}>
            {terminalActivated
              ? renderTool(
                  terminal,
                  !effectivelyCollapsed && activeTool === "terminal",
                )
              : null}
          </WorkspaceToolPanel>
          {!previewAvailable ? null : (
            <WorkspaceToolPanel tool="preview" activeTool={activeTool}>
              {previewActivated
                ? renderTool(
                    preview,
                    !effectivelyCollapsed && activeTool === "preview",
                  )
                : null}
            </WorkspaceToolPanel>
          )}
          {!desktopAvailable ? null : (
            <WorkspaceToolPanel tool="desktop" activeTool={activeTool}>
              {desktopActivated
                ? renderTool(
                    desktop,
                    !effectivelyCollapsed && activeTool === "desktop",
                  )
                : null}
            </WorkspaceToolPanel>
          )}
        </aside>
      </div>
    </div>
  );
}
