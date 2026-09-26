import { Menu } from "@base-ui/react/menu";
import {
  EllipsisVertical,
  Files,
  GitCompareArrows,
  Maximize2,
  Minimize2,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import * as React from "react";

const RIGHT_PANE_MAX_VIEWPORT_RATIO = 0.46;
const RIGHT_PANE_DEFAULT_WIDTH = 360;
const RIGHT_PANE_MIN_WIDTH = 260;
const RESIZE_HANDLE_WIDTH = 1;
const WORKSPACE_TOOLS = ["changes", "files", "terminal"] as const;

type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

const toolTabId = (tool: WorkspaceTool) => `thread-workspace-tab-${tool}`;
const toolPanelId = (tool: WorkspaceTool) => `thread-${tool}-panel`;
const toolPresentation = {
  changes: { label: "Changes", Icon: GitCompareArrows },
  files: { label: "Files", Icon: Files },
  terminal: { label: "Terminal", Icon: SquareTerminal },
} as const;

function WorkspaceToolbar({
  activeTool,
  focused,
  onSelectTool,
  onToolKeyDown,
  onCaptureFocus,
  onToggleFocus,
}: {
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
        {WORKSPACE_TOOLS.map((tool) => {
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
  changes,
  files,
}: {
  readonly rightPaneCollapsed: boolean;
  readonly main: React.ReactNode;
  readonly terminal?: React.ReactNode | ((active: boolean) => React.ReactNode);
  readonly changes?: React.ReactNode;
  readonly files?: React.ReactNode | ((active: boolean) => React.ReactNode);
}) {
  const [rightPaneWidth, setRightPaneWidth] = React.useState(
    RIGHT_PANE_DEFAULT_WIDTH,
  );
  const [rightPaneResizing, setRightPaneResizing] = React.useState(false);
  const [activeTool, setActiveTool] = React.useState<WorkspaceTool>(() =>
    changes === undefined && terminal !== undefined ? "terminal" : "changes",
  );
  const [terminalActivated, setTerminalActivated] = React.useState(
    activeTool === "terminal",
  );
  const [filesActivated, setFilesActivated] = React.useState(false);
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
    setActiveTool(tool);
  }, []);

  const handleToolKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tool: WorkspaceTool) => {
      const currentIndex = WORKSPACE_TOOLS.indexOf(tool);
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % WORKSPACE_TOOLS.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex =
          (currentIndex - 1 + WORKSPACE_TOOLS.length) % WORKSPACE_TOOLS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = WORKSPACE_TOOLS.length - 1;
      }
      if (nextIndex === undefined) return;
      event.preventDefault();
      const nextTool = WORKSPACE_TOOLS[nextIndex];
      selectTool(nextTool);
      event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelector<HTMLButtonElement>(`#${toolTabId(nextTool)}`)
        ?.focus();
    },
    [selectTool],
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
            activeTool={activeTool}
            focused={rightPaneFocused}
            onSelectTool={selectTool}
            onToolKeyDown={handleToolKeyDown}
            onCaptureFocus={captureFocusRestoreTarget}
            onToggleFocus={toggleRightPaneFocus}
          />
          <div
            id={toolPanelId("changes")}
            className="right-pane-content"
            role="tabpanel"
            aria-labelledby={toolTabId("changes")}
            aria-label="Changes"
            aria-hidden={activeTool !== "changes" || undefined}
            hidden={activeTool !== "changes"}
            inert={activeTool !== "changes"}
          >
            {changes}
          </div>
          <div
            id={toolPanelId("files")}
            className="right-pane-content"
            role="tabpanel"
            aria-labelledby={toolTabId("files")}
            aria-label="Files"
            aria-hidden={activeTool !== "files" || undefined}
            hidden={activeTool !== "files"}
            inert={activeTool !== "files"}
          >
            {filesActivated
              ? typeof files === "function"
                ? files(!effectivelyCollapsed && activeTool === "files")
                : files
              : null}
          </div>
          <div
            id={toolPanelId("terminal")}
            className="right-pane-content"
            role="tabpanel"
            aria-labelledby={toolTabId("terminal")}
            aria-label="Terminal"
            aria-hidden={activeTool !== "terminal" || undefined}
            hidden={activeTool !== "terminal"}
            inert={activeTool !== "terminal"}
          >
            {terminalActivated
              ? typeof terminal === "function"
                ? terminal(!effectivelyCollapsed && activeTool === "terminal")
                : terminal
              : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
