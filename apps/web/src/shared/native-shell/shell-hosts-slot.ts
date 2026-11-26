import { type ComponentType, createContext } from "react";

/**
 * The account menu's Hosts group inside the Mac app (the dx installs it
 * opens, to switch between), which the application composes in from the
 * native shell feature's lazy chunk. Absent in a browser.
 */
export const ShellHostsSlot = createContext<ComponentType | undefined>(
  undefined,
);
