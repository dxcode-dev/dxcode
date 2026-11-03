import type { ThreadTerminalId } from "@dx/api";
import * as React from "react";

/**
 * Which shell session the Terminal inside a tab shows: each Terminal tab
 * names its own, and the first Terminal's is `default`.
 */
export const TerminalSessionContext =
  React.createContext<ThreadTerminalId>("default");

/** The form a Terminal's Refresh Environment submits; one per Terminal. */
export const terminalEnvironmentFormId = (session: ThreadTerminalId) =>
  session === "default"
    ? "thread-terminal-environment"
    : `thread-terminal-environment-${session}`;
