import type { PersonalAccountData, SettingsContextData } from "@dx/api";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  Bug,
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
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";

export function SidebarAccountMenu({
  personalAccount,
  settingsContext,
  bugReportReader = false,
  onNavigate,
}: {
  readonly personalAccount?: PersonalAccountData;
  readonly settingsContext?: SettingsContextData;
  /** One of the deployment's report readers, who see every report. */
  readonly bugReportReader?: boolean;
  readonly onNavigate: () => void;
}) {
  const auth = useIdentity();
  // Read when a menu item runs, so navigating does not re-render the menu.
  const router = useRouter();
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
      <MenuRoot>
        <MenuTrigger
          className="sidebar-account-row"
          aria-label="Open account menu"
        >
          <span className="sidebar-account-avatar">
            {personalAccount?.avatarUrl === undefined ? (
              <span>{username.slice(0, 1).toUpperCase() || "D"}</span>
            ) : (
              <img src={personalAccount.avatarUrl} alt="" />
            )}
          </span>
          <span className="account-copy">
            <strong>{username}</strong>
            <small>{email}</small>
          </span>
          <ChevronsUpDown className="account-chevrons" />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuItem
            disabled={auth === undefined}
            onClick={() => auth?.logout()}
          >
            <LogOut />
            <span>Sign out</span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              onNavigate();
              commandSurfaces.openKeymap();
            }}
          >
            <Keyboard />
            <span>Keymap</span>
            <ShortcutKeycaps keycaps={commandSurfaces.keymapKeycaps} />
          </MenuItem>
          <MenuItem
            onClick={() => {
              onNavigate();
              commandSurfaces.openPalette();
            }}
          >
            <Command />
            <span>Command Palette</span>
            <ShortcutKeycaps keycaps={commandSurfaces.paletteKeycaps} />
          </MenuItem>
          {bugReportReader ? (
            <MenuItem
              onClick={() => {
                onNavigate();
                void navigate({ to: "/bug-reports/all" });
              }}
            >
              <Bug />
              <span>All Bug Reports</span>
            </MenuItem>
          ) : null}
          {workspace === undefined ? null : (
            <MenuItem
              onClick={() => {
                onNavigate();
                void navigate({
                  to: "/workspaces/$workspaceSlug",
                  params: { workspaceSlug: workspace.shortName },
                  state: settingsNavigationState(router.state.location.href),
                });
              }}
            >
              <Building2 />
              <span>{workspace.displayName} Settings</span>
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              onNavigate();
              void navigate({
                to: "/settings",
                state: settingsNavigationState(router.state.location.href),
              });
            }}
          >
            {workspace === undefined ? <Settings /> : <UserRound />}
            <span>Personal Settings</span>
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}
