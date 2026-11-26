import { Check, Plus, Server } from "lucide-react";
import {
  addShellHost,
  switchShellHost,
  useShellHosts,
} from "../../shared/native-shell/use-shell-hosts.js";
import {
  MenuGroup,
  MenuItem,
  MenuItemHint,
  MenuLabel,
  MenuSeparator,
} from "../../shared/ui/menu.js";

/**
 * The account menu's Hosts group inside the Mac app: the dx installs it
 * opens, to switch between. Loaded only inside the app, with the bridge.
 */
export function ShellHostsMenuGroup() {
  const hosts = useShellHosts();
  if (hosts.length === 0) return null;
  return (
    <>
      <MenuGroup>
        <MenuLabel>Hosts</MenuLabel>
        {hosts.map((host) => (
          <MenuItem
            key={host.id}
            aria-checked={host.active}
            onClick={() => switchShellHost(host.id)}
          >
            {host.active ? <Check /> : <Server />}
            <span>{host.name}</span>
            <MenuItemHint>{host.shortcut}</MenuItemHint>
          </MenuItem>
        ))}
        <MenuItem onClick={() => addShellHost()}>
          <Plus />
          <span>Add Host…</span>
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
    </>
  );
}
