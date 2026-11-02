import type { ThreadId } from "@dx/domain";
import * as React from "react";

/**
 * The Thread whose Terminal the menus may warm: set by the Thread page only
 * when the person may open its Terminal (owner or contributor, active
 * Thread). Anywhere else it is absent, and pointing at Terminal wakes nothing.
 */
export const TerminalWarmContext = React.createContext<ThreadId | undefined>(
  undefined,
);
