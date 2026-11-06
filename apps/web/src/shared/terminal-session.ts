import type { ThreadTerminalId } from "@dx/api";
import * as React from "react";

/**
 * Which shell session the Terminal inside a tab shows: each Terminal tab
 * names its own, and the first Terminal's is `default`.
 */
export const TerminalSessionContext =
  React.createContext<ThreadTerminalId>("default");

/**
 * The Terminals the page restored with the saved layout, by session. One
 * that shows as the page opens attaches without waking a paused Orb: the
 * person only opened the Thread (#1847).
 */
export const RestoredTerminalsContext = React.createContext<
  ReadonlySet<ThreadTerminalId>
>(new Set());

/** The form a Terminal's Refresh Environment submits; one per Terminal. */
export const terminalEnvironmentFormId = (session: ThreadTerminalId) =>
  session === "default"
    ? "thread-terminal-environment"
    : `thread-terminal-environment-${session}`;
