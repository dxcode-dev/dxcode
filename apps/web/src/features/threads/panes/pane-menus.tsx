import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import type { ThreadPaneLayout, ThreadPaneTab } from "@dx/api";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  Grid2x2Plus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import * as React from "react";
import type { CommandId } from "../../../shared/commands/command-registry.js";
import { getBrowserCommandRegistry } from "../../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../../shared/commands/shortcut-keycaps.js";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import {
  findViewTab,
  PANE_VIEW_KINDS,
  type PaneLayoutAction,
  type PaneSide,
  type PaneViewKind,
  tabId,
  tabLabel,
} from "./pane-layout.js";
import { PANE_VIEWS, type PaneContents } from "./pane-views.js";

/** The keycaps bound to a Thread command, as the keymap shows them. */
const useCommandKeycaps = () => {
  const registry = getBrowserCommandRegistry();
  React.useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );
  const commands = registry.getCommands("thread");
  return (id: CommandId) =>
    commands.find((command) => command.id === id)?.displayedKeycaps ?? [];
};

const availableViews = (contents: PaneContents) =>
  PANE_VIEW_KINDS.filter((view) => contents.views[view] !== undefined);

/**
 * The Views and Open Tab items: every available view with its shortcut, and
 * "Open" beside one already open. Terminal says "New Terminal" once one
 * exists; dx keeps one Terminal, so that entry brings it forward.
 */
function ViewMenuItems({
  layout,
  contents,
  onOpen,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
}) {
  const keycaps = useCommandKeycaps();
  return (
    <>
      {availableViews(contents).map((view) => {
        const { label, Icon, command } = PANE_VIEWS[view];
        const open = findViewTab(layout, view) !== undefined;
        return (
          <Menu.Item
            key={view}
            className="thread-menu-item pane-view-menu-item"
            data-view={view}
            onClick={() => onOpen(view)}
          >
            <Icon aria-hidden="true" />
            <span>{open && view === "terminal" ? "New Terminal" : label}</span>
            {open ? (
              <small className="pane-view-menu-open">Open</small>
            ) : (
              <ShortcutKeycaps keycaps={keycaps(command)} emptyLabel="" />
            )}
          </Menu.Item>
        );
      })}
    </>
  );
}

/** The title bar's Views button: opens a view in the pane tree. */
export function ViewsMenuButton({
  layout,
  contents,
  onOpen,
  className,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
  readonly className?: string;
}) {
  if (availableViews(contents).length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={`thread-title-action thread-title-action-text ${className ?? ""}`}
        aria-label="Views"
      >
        <Grid2x2Plus aria-hidden="true" />
        <span>Views</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup thread-actions-menu pane-view-menu">
            <ViewMenuItems
              layout={layout}
              contents={contents}
              onOpen={onOpen}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A pane's `+`: opens a view as a tab in that pane. */
export function OpenTabMenuButton({
  layout,
  contents,
  onOpen,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
}) {
  if (availableViews(contents).length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        className="pane-open-tab"
        aria-label="Open Tab"
        title="Open Tab"
      >
        <Plus aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="start"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup thread-actions-menu pane-view-menu">
            <ViewMenuItems
              layout={layout}
              contents={contents}
              onOpen={onOpen}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const SIDES: ReadonlyArray<{
  readonly side: PaneSide;
  readonly label: string;
  readonly Icon: typeof ArrowLeft;
}> = [
  { side: "left", label: "Left", Icon: ArrowLeft },
  { side: "right", label: "Right", Icon: ArrowRight },
  { side: "top", label: "Above", Icon: ArrowUp },
  { side: "bottom", label: "Below", Icon: ArrowDown },
];

const copyText = (text: string) => void navigator.clipboard.writeText(text);

export interface TabMenuFileActions {
  readonly downloadUrl?: string;
  readonly path: string;
  readonly link?: string;
}

/**
 * The right-click menu of a view or file tab: closing, the file's actions,
 * moving it into a new pane beside this one, and the Terminal's refresh.
 */
export function PaneTabContextMenu({
  pane,
  tab,
  tabs,
  dispatch,
  file,
  children,
}: {
  readonly pane: string;
  readonly tab: ThreadPaneTab;
  readonly tabs: ReadonlyArray<ThreadPaneTab>;
  readonly dispatch: (action: PaneLayoutAction) => void;
  readonly file?: TabMenuFileActions;
  readonly children: React.ReactElement;
}) {
  const id = tabId(tab);
  const index = tabs.findIndex((candidate) => tabId(candidate) === id);
  const closable = tabs.filter((candidate) => candidate.kind !== "agent");
  const others = closable.filter((candidate) => tabId(candidate) !== id);
  const toRight = tabs
    .slice(index + 1)
    .filter((candidate) => candidate.kind !== "agent");
  const label = tabLabel(tab);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="thread-context-positioner">
          <ContextMenu.Popup
            className="thread-context-menu pane-tab-menu"
            aria-label={`Actions for ${label}`}
          >
            <ContextMenu.Item
              className="thread-context-item"
              onClick={() => dispatch({ type: "close", tab: id })}
            >
              <X />
              <span>Close</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className="thread-context-item"
              disabled={others.length === 0}
              onClick={() => dispatch({ type: "close-others", pane, tab: id })}
            >
              <span>Close Others</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className="thread-context-item"
              disabled={toRight.length === 0}
              onClick={() => dispatch({ type: "close-right", pane, tab: id })}
            >
              <span>Close to the Right</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              className="thread-context-item"
              onClick={() => dispatch({ type: "close-all", pane })}
            >
              <span>Close All</span>
            </ContextMenu.Item>
            {file === undefined ? null : (
              <>
                <ContextMenu.Separator className="thread-context-separator" />
                {file.downloadUrl === undefined ? null : (
                  <ContextMenu.Item
                    className="thread-context-item"
                    onClick={() => downloadFromUrl(file.downloadUrl as string)}
                  >
                    <Download />
                    <span>Download</span>
                  </ContextMenu.Item>
                )}
                <ContextMenu.Item
                  className="thread-context-item"
                  onClick={() => copyText(file.path)}
                >
                  <Copy />
                  <span>Copy Path</span>
                </ContextMenu.Item>
                {file.link === undefined ? null : (
                  <ContextMenu.Item
                    className="thread-context-item"
                    onClick={() => copyText(file.link as string)}
                  >
                    <span>Copy Link</span>
                  </ContextMenu.Item>
                )}
              </>
            )}
            {tab.kind === "terminal" ? (
              <>
                <ContextMenu.Separator className="thread-context-separator" />
                <ContextMenu.Item
                  className="thread-context-item"
                  nativeButton
                  render={
                    <button type="submit" form="thread-terminal-environment" />
                  }
                >
                  <RefreshCw />
                  <span>Refresh Environment</span>
                </ContextMenu.Item>
              </>
            ) : null}
            <ContextMenu.Separator className="thread-context-separator" />
            <ContextMenu.SubmenuRoot>
              <ContextMenu.SubmenuTrigger
                className="thread-context-item"
                disabled={tabs.length === 1}
              >
                <span>Move To</span>
                <ChevronRight />
              </ContextMenu.SubmenuTrigger>
              <ContextMenu.Portal>
                <ContextMenu.Positioner
                  className="thread-context-positioner"
                  sideOffset={4}
                  alignOffset={-4}
                >
                  <ContextMenu.Popup className="thread-context-menu pane-tab-menu">
                    {SIDES.map(({ side, label: sideLabel, Icon }) => (
                      <ContextMenu.Item
                        key={side}
                        className="thread-context-item"
                        onClick={() =>
                          dispatch({
                            type: "move",
                            tab: id,
                            to: { pane, side },
                          })
                        }
                      >
                        <Icon />
                        <span>{sideLabel}</span>
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            </ContextMenu.SubmenuRoot>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
