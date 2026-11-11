import * as React from "react";
import type { ThreadAutomationsSlot } from "../../shared/thread-automations-slot.js";

const nothing = () => null;

/**
 * A Thread title bar's issues, pull requests, CI, and schedule and GitHub
 * listeners, from the Space page, for the Space's own Thread and the
 * thread open in its tab; without them, a Space shows none.
 */
export const SpaceAutomationsContext =
  React.createContext<ThreadAutomationsSlot>({
    Chips: nothing,
    MenuItems: nothing,
    Sheet: nothing,
  });
