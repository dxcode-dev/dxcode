import { Menu } from "@base-ui/react/menu";
import type { PersonalAccountData, SettingsContextData } from "@dx/api";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Building2,
  ChevronsUpDown,
  Command,
  Keyboard,
  LogOut,
  Settings,
  UserRound,
} from "lucide-react";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { useCommandPaletteSurface } from "../../shared/commands/command-provider.js";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { settingsNavigationState } from "../../shared/navigation/settings-return.js";

export function SidebarAccountMenu({
  personalAccount,
  settingsContext,
  onNavigate,
}: {
  readonly personalAccount?: PersonalAccountData;
  readonly settingsContext?: SettingsContextData;
  readonly onNavigate: () => void;
}) {
  const auth = useIdentity();
  const returnTo = useLocation({ select: (location) => location.href });
  const navigate = useNavigate();
  const commandSurfaces = useCommandPaletteSurface();
  const workspace = settingsContext?.workspace;
  const name = personalAccount?.displayName ?? auth?.identity.name ?? "DX";
  const email = personalAccount?.email ?? auth?.identity.email ?? "";
  const emailSeparator = email.indexOf("@");
  const username =
    personalAccount?.username ??
    (emailSeparator > 0
      ? email.slice(0, emailSeparator)
      : name.replaceAll(" ", "").toLocaleLowerCase());

  return (
    <div className="sidebar-account-shell">
      <Menu.Root>
        <Menu.Trigger
          className="sidebar-account-row"
          aria-label="Open account menu"
        >
          <span className="sidebar-account-avatar">
            <span>{username.slice(0, 1).toUpperCase() || "D"}</span>
          </span>
          <span className="account-copy">
            <strong>{username}</strong>
            <small>{email}</small>
          </span>
          <ChevronsUpDown className="account-chevrons" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="sidebar-menu-positioner"
            side="top"
            align="start"
            sideOffset={4}
          >
            <Menu.Popup className="sidebar-menu account-menu">
              <Menu.Item
                className="sidebar-menu-item"
                disabled={auth === undefined}
                onClick={() => auth?.logout()}
              >
                <LogOut /> Sign out
              </Menu.Item>
              <Menu.Item
                className="sidebar-menu-item"
                onClick={() => {
                  onNavigate();
                  commandSurfaces.openKeymap();
                }}
              >
                <Keyboard /> <span className="sidebar-menu-label">Keymap</span>
                <ShortcutKeycaps keycaps={commandSurfaces.keymapKeycaps} />
              </Menu.Item>
              <Menu.Item
                className="sidebar-menu-item"
                onClick={() => {
                  onNavigate();
                  commandSurfaces.openPalette();
                }}
              >
                <Command />
                <span className="sidebar-menu-label">Command Palette</span>
                <ShortcutKeycaps keycaps={commandSurfaces.paletteKeycaps} />
              </Menu.Item>
              {workspace === undefined ? null : (
                <Menu.Item
                  className="sidebar-menu-item"
                  onClick={() => {
                    onNavigate();
                    void navigate({
                      to: "/workspaces/$workspaceSlug",
                      params: { workspaceSlug: workspace.shortName },
                      state: settingsNavigationState(returnTo),
                    });
                  }}
                >
                  <Building2 /> {workspace.displayName} Settings
                </Menu.Item>
              )}
              <Menu.Item
                className="sidebar-menu-item"
                onClick={() => {
                  onNavigate();
                  void navigate({
                    to: "/settings",
                    state: settingsNavigationState(returnTo),
                  });
                }}
              >
                {workspace === undefined ? <Settings /> : <UserRound />}
                Personal Settings
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
