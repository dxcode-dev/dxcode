import type { ThreadPaneLayout, ThreadPaneTab } from "@dx/api";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Download,
  Grid2x2Plus,
  Plus,
  Puzzle,
  RefreshCw,
  X,
} from "lucide-react";
import * as React from "react";
import type { CommandId } from "../../../shared/commands/command-registry.js";
import { getBrowserCommandRegistry } from "../../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../../shared/commands/shortcut-keycaps.js";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import { terminalEnvironmentFormId } from "../../../shared/terminal-session.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuItemHint,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import {
  warmTerminal,
  warmTerminalAfterDwell,
} from "../../terminal/terminal-warm-mutations.js";
import {
  canOpenTerminal,
  findViewTab,
  locateTab,
  PANE_VIEW_KINDS,
  type PaneLayoutAction,
  type PaneSide,
  type PaneViewKind,
  type PluginPaneTab,
  pluginPaneTabId,
  tabId,
  tabLabel,
  terminalSession,
} from "./pane-layout.js";
import { PANE_VIEWS, type PaneContents } from "./pane-views.js";
import { TerminalWarmContext } from "./terminal-warm-context.js";

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
 * "Open" beside one already open. Once a Terminal is open, Terminal becomes
 * "New Terminal", which opens another with its own shell session, up to the
 * Thread's limit.
 */
function ViewMenuItems({
  layout,
  contents,
  onOpen,
  onNewTerminal,
  onOpenPluginPane,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
  readonly onNewTerminal?: () => void;
  readonly onOpenPluginPane?: (tab: Omit<PluginPaneTab, "kind">) => void;
}) {
  const keycaps = useCommandKeycaps();
  const warm = useTerminalWarmIntent();
  return (
    <>
      {availableViews(contents).map((view) => {
        const { label, Icon, command } = PANE_VIEWS[view];
        const open = findViewTab(layout, view) !== undefined;
        const another =
          open && view === "terminal" && onNewTerminal !== undefined;
        return (
          <MenuItem
            key={view}
            data-view={view}
            disabled={another && !canOpenTerminal(layout)}
            onClick={() => (another ? onNewTerminal() : onOpen(view))}
            {...(view === "terminal" ? warm : {})}
          >
            <Icon aria-hidden="true" />
            <span>{another ? "New Terminal" : label}</span>
            {another ? null : open ? (
              <MenuItemHint>Open</MenuItemHint>
            ) : (
              <ShortcutKeycaps keycaps={keycaps(command)} emptyLabel="" />
            )}
          </MenuItem>
        );
      })}
      {onOpenPluginPane === undefined
        ? null
        : contents.pluginMenu?.({
            renderItem: (option) => {
              const id = pluginPaneTabId(option);
              return (
                <MenuItem
                  key={id}
                  className="pane-view-menu-item"
                  data-view={id}
                  title={option.pluginTitle}
                  onClick={() =>
                    onOpenPluginPane({
                      plugin: option.plugin,
                      pane: option.pane,
                      title: option.title,
                    })
                  }
                >
                  <Puzzle aria-hidden="true" />
                  <span>{option.title}</span>
                  {locateTab(layout, id) === undefined ? null : (
                    <MenuItemHint>Open</MenuItemHint>
                  )}
                </MenuItem>
              );
            },
          })}
    </>
  );
}

/**
 * Pointing at Terminal starts the Orb's wake before the click attaches: after
 * a short dwell (or at once on press), never on a passing hover, and only for
 * people who may open the Terminal. Viewers of a shared Thread never warm it.
 */
function useTerminalWarmIntent() {
  const threadId = React.useContext(TerminalWarmContext);
  const cancel = React.useRef<() => void>(undefined);
  const stop = () => {
    cancel.current?.();
    cancel.current = undefined;
  };
  // An item that closes mid-dwell warms nothing; the React Compiler keeps
  // this callback stable, so a re-render never cancels a dwell.
  const ref = () => stop;
  if (threadId === undefined) return {};
  return {
    onPointerEnter: () => {
      stop();
      cancel.current = warmTerminalAfterDwell(threadId);
    },
    onFocus: () => {
      stop();
      cancel.current = warmTerminalAfterDwell(threadId);
    },
    onPointerLeave: stop,
    onBlur: stop,
    onPointerDown: () => {
      stop();
      warmTerminal(threadId);
    },
    ref,
  };
}

/** The title bar's Views button: opens a view in the pane tree. */
export function ViewsMenuButton({
  layout,
  contents,
  onOpen,
  onNewTerminal,
  onOpenPluginPane,
  className,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
  readonly onNewTerminal?: () => void;
  readonly onOpenPluginPane?: (tab: Omit<PluginPaneTab, "kind">) => void;
  readonly className?: string;
}) {
  if (availableViews(contents).length === 0) return null;
  return (
    <MenuRoot>
      <MenuTrigger
        className={buttonVariants({
          variant: "subtle",
          size: "xs",
          className: `thread-title-action thread-title-action-text ${className ?? ""}`,
        })}
        aria-label="Views"
      >
        <Grid2x2Plus aria-hidden="true" />
        <span>Views</span>
      </MenuTrigger>
      <MenuPopup className="pane-view-menu" align="end">
        <ViewMenuItems
          layout={layout}
          contents={contents}
          onOpen={onOpen}
          onNewTerminal={onNewTerminal}
          onOpenPluginPane={onOpenPluginPane}
        />
      </MenuPopup>
    </MenuRoot>
  );
}

/** A pane's `+`: opens a view as a tab in that pane. */
export function OpenTabMenuButton({
  layout,
  contents,
  onOpen,
  onNewTerminal,
  onOpenPluginPane,
}: {
  readonly layout: ThreadPaneLayout;
  readonly contents: PaneContents;
  readonly onOpen: (view: PaneViewKind) => void;
  readonly onNewTerminal?: () => void;
  readonly onOpenPluginPane?: (tab: Omit<PluginPaneTab, "kind">) => void;
}) {
  if (availableViews(contents).length === 0) return null;
  return (
    <MenuRoot>
      <MenuTrigger
        className="pane-open-tab"
        aria-label="Open Tab"
        title="Open Tab"
      >
        <Plus aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup className="pane-view-menu" align="start">
        <ViewMenuItems
          layout={layout}
          contents={contents}
          onOpen={onOpen}
          onNewTerminal={onNewTerminal}
          onOpenPluginPane={onOpenPluginPane}
        />
      </MenuPopup>
    </MenuRoot>
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
    <ContextMenuRoot>
      <ContextMenuTrigger render={children} />
      <MenuPopup sideOffset={0} aria-label={`Actions for ${label}`}>
        <MenuItem onClick={() => dispatch({ type: "close", tab: id })}>
          <X />
          <span>Close</span>
        </MenuItem>
        <MenuItem
          disabled={others.length === 0}
          onClick={() => dispatch({ type: "close-others", pane, tab: id })}
        >
          <span>Close Others</span>
        </MenuItem>
        <MenuItem
          disabled={toRight.length === 0}
          onClick={() => dispatch({ type: "close-right", pane, tab: id })}
        >
          <span>Close to the Right</span>
        </MenuItem>
        <MenuItem onClick={() => dispatch({ type: "close-all", pane })}>
          <span>Close All</span>
        </MenuItem>
        {file === undefined ? null : (
          <>
            <MenuSeparator />
            {file.downloadUrl === undefined ? null : (
              <MenuItem
                onClick={() => downloadFromUrl(file.downloadUrl as string)}
              >
                <Download />
                <span>Download</span>
              </MenuItem>
            )}
            <MenuItem onClick={() => copyText(file.path)}>
              <Copy />
              <span>Copy Path</span>
            </MenuItem>
            {file.link === undefined ? null : (
              <MenuItem onClick={() => copyText(file.link as string)}>
                <span>Copy Link</span>
              </MenuItem>
            )}
          </>
        )}
        {tab.kind === "terminal" ? (
          <>
            <MenuSeparator />
            <MenuItem
              nativeButton
              render={
                <button
                  type="submit"
                  form={terminalEnvironmentFormId(terminalSession(tab))}
                />
              }
            >
              <RefreshCw />
              <span>Refresh Environment</span>
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuSubmenuRoot>
          <MenuSubmenuTrigger disabled={tabs.length === 1}>
            <span>Move To</span>
          </MenuSubmenuTrigger>
          <MenuPopup alignOffset={-4}>
            {SIDES.map(({ side, label: sideLabel, Icon }) => (
              <MenuItem
                key={side}
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
              </MenuItem>
            ))}
          </MenuPopup>
        </MenuSubmenuRoot>
      </MenuPopup>
    </ContextMenuRoot>
  );
}
