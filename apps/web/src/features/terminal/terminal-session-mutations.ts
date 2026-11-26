import { CloseThreadTerminalEndpoint, type ThreadTerminalId } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../shared/api/client.js";

/**
 * A Terminal's tab closed: end its shell session in the Orb. Core ends it
 * now, or when a paused Orb next connects; it never wakes the Orb. The first
 * Terminal's session is shared with the agent and never ends this way.
 */
export const closeTerminalSession = (
  threadId: ThreadId | string,
  terminal: ThreadTerminalId,
) => {
  if (terminal === "default") return;
  // keepalive: the request outlives the tab or page that closes it.
  void dxClient
    .call(
      CloseThreadTerminalEndpoint,
      { params: { threadId: threadId as ThreadId }, body: { terminal } },
      { keepalive: true },
    )
    .catch(() => undefined);
};
