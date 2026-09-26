import { useLocation, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { settingsNavigationState } from "../navigation/settings-return.js";
import { createCommandKeydownHandler } from "./command-dispatcher.js";
import { CommandPalette } from "./command-palette.js";
import {
  type CommandContext,
  type CommandId,
  type CommandRegistry,
  type CommandRuntime,
  commandContextFromPath,
  getBrowserCommandRegistry,
} from "./command-registry.js";
import { KeymapDialog } from "./keymap-dialog.js";

interface CommandSurfaceValue {
  readonly openPalette: () => void;
  readonly openKeymap: () => void;
  readonly paletteLabel: string;
  readonly paletteKeycaps: ReadonlyArray<string>;
  readonly keymapKeycaps: ReadonlyArray<string>;
}

const CommandSurfaceContext = React.createContext<
  CommandSurfaceValue | undefined
>(undefined);

export function useCommandPaletteSurface() {
  const surface = React.useContext(CommandSurfaceContext);
  if (surface === undefined)
    throw new Error(
      "useCommandPaletteSurface must be used inside CommandProvider.",
    );
  return surface;
}

const focusCommandTarget = (target: string) => {
  if (typeof document === "undefined") return;
  document
    .querySelector<HTMLElement>(`[data-command-target="${target}"]`)
    ?.focus();
};

const dispatcherSnapshot = () => 0;

const useGlobalCommandDispatcher = (
  handler: (event: KeyboardEvent) => void,
) => {
  const subscribe = React.useCallback(
    (_onStoreChange: () => void) => {
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    },
    [handler],
  );
  React.useSyncExternalStore(subscribe, dispatcherSnapshot, dispatcherSnapshot);
};

export function CommandProvider({
  children,
  registry = getBrowserCommandRegistry(),
  onOpenNewThread,
}: {
  readonly children: React.ReactNode;
  readonly registry?: CommandRegistry;
  readonly onOpenNewThread?: () => void;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const returnTo = useLocation({ select: (location) => location.href });
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [keymapOpen, setKeymapOpen] = React.useState(false);
  React.useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getServerSnapshot,
  );
  const context: CommandContext = commandContextFromPath(pathname);
  const runtime = React.useMemo<CommandRuntime>(
    () => ({
      navigateHome: () => navigate({ to: "/" }),
      openCommandPalette: () => setPaletteOpen(true),
      openThreadSearch: () =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-command-action="search-threads"]',
          )
          ?.click(),
      openKeymap: () => setKeymapOpen(true),
      navigateToProjects: () => navigate({ to: "/projects" }),
      navigateToNewThread: () => {
        if (onOpenNewThread === undefined)
          void navigate({ to: "/new", search: { project: undefined } });
        else onOpenNewThread();
      },
      navigateToSettings: () =>
        navigate({
          to: "/settings",
          state: settingsNavigationState(returnTo),
        }),
      navigateToWorkspaceSettings: () => {
        const workspaceSlug = document.querySelector<HTMLElement>(
          "[data-command-workspace-slug]",
        )?.dataset.commandWorkspaceSlug;
        if (workspaceSlug !== undefined)
          void navigate({
            to: "/workspaces/$workspaceSlug",
            params: { workspaceSlug },
            state: settingsNavigationState(returnTo),
          });
        else
          void navigate({
            to: "/workspaces",
            state: settingsNavigationState(returnTo),
          });
      },
      navigateToAppearanceSettings: () =>
        navigate({
          to: "/settings/$section",
          params: { section: "appearance" },
          state: settingsNavigationState(returnTo),
        }),
      navigateToKeyboardShortcuts: () =>
        navigate({
          to: "/settings/$section",
          params: { section: "keyboard-shortcuts" },
          state: settingsNavigationState(returnTo),
        }),
      focusThreadComposer: () => focusCommandTarget("thread-composer"),
      focusKeyboardShortcutSearch: () =>
        focusCommandTarget("keyboard-shortcut-search"),
      restoreKeyboardShortcutDefaults: registry.resetAll,
      copyCurrentUrl: () =>
        void navigator.clipboard.writeText(window.location.href),
      goBack: () => window.history.back(),
      goForward: () => window.history.forward(),
      toggleAndFocusSidebar: () => {
        const toggle =
          document.querySelector<HTMLElement>(
            ".mobile-sidebar-drawer [data-command-action='toggle-sidebar']",
          ) ??
          document.querySelector<HTMLElement>(
            "[data-command-action='toggle-sidebar'][aria-label='Open sidebar']",
          ) ??
          document.querySelector<HTMLElement>(
            "[data-command-action='toggle-sidebar']",
          );
        const opening = toggle?.getAttribute("aria-label") === "Open sidebar";
        toggle?.click();
        if (opening)
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>(
                "[data-command-focused='true'], [data-command-sidebar-item].selected, [data-command-sidebar-item]",
              )
              ?.focus(),
          );
      },
      moveSidebarSelection: (direction) => {
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            "[data-command-sidebar-item]",
          ),
        ];
        if (items.length === 0) return;
        const current = items.findIndex(
          (item) => item.dataset.commandFocused === "true",
        );
        const next =
          items[
            (current < 0 ? (direction < 0 ? items.length : -1) : current) +
              direction
          ];
        if (next === undefined) return;
        for (const item of items) delete item.dataset.commandFocused;
        next.dataset.commandFocused = "true";
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      },
      openFocusedSidebarItem: () =>
        document
          .querySelector<HTMLElement>("[data-command-focused='true']")
          ?.click(),
      switchThread: (direction) => {
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            "[data-command-sidebar-item]",
          ),
        ];
        const current = items.findIndex((item) =>
          item.classList.contains("selected"),
        );
        items[current + direction]?.click();
      },
      openFocusedThreadMenu: () => {
        const focused = document.querySelector<HTMLElement>(
          "[data-command-focused='true']",
        );
        if (focused === null) return;
        const bounds = focused.getBoundingClientRect();
        focused.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: bounds.right - 8,
            clientY: bounds.top + bounds.height / 2,
          }),
        );
      },
      addThreadImages: () =>
        document
          .querySelector<HTMLInputElement>("[data-command-action='add-images']")
          ?.click(),
    }),
    [navigate, onOpenNewThread, registry, returnTo],
  );
  const commands = registry.getCommands(context);
  const dispatch = React.useCallback(
    (id: CommandId) => registry.dispatch(id, runtime, context),
    [context, registry, runtime],
  );
  const handleKeyDown = React.useMemo(
    () =>
      createCommandKeydownHandler({
        registry,
        runtime,
        getContext: () => commandContextFromPath(window.location.pathname),
        document,
      }),
    [registry, runtime],
  );
  useGlobalCommandDispatcher(handleKeyDown);

  const paletteCommand = commands.find(
    (command) => command.id === "command-palette.open",
  );
  const keymapCommand = commands.find(
    (command) => command.id === "keymap.open",
  );
  const surface = React.useMemo<CommandSurfaceValue>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openKeymap: () => setKeymapOpen(true),
      paletteLabel: paletteCommand?.label ?? "Open command palette",
      paletteKeycaps: paletteCommand?.displayedKeycaps ?? [],
      keymapKeycaps: keymapCommand?.displayedKeycaps ?? [],
    }),
    [keymapCommand, paletteCommand],
  );

  return (
    <CommandSurfaceContext.Provider value={surface}>
      {children}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onOpenChange={setPaletteOpen}
        onDispatch={dispatch}
      />
      <KeymapDialog
        open={keymapOpen}
        onOpenChange={setKeymapOpen}
        commands={commands}
      />
    </CommandSurfaceContext.Provider>
  );
}
