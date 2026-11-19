import * as React from "react";
import {
  type CommandId,
  getBrowserCommandRegistry,
} from "./command-registry.js";

/**
 * The keycaps of a command's effective binding on this device, as the keymap
 * shows them: the person's override when they set one, else the default.
 * Re-renders when a binding changes.
 */
export const useCommandKeycaps = () => {
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
