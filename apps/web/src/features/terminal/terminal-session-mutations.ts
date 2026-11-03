import type { ThreadTerminalId } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";

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
  void sameOriginFetch(
    `/v1/threads/${encodeURIComponent(threadId)}/terminal/close`,
    {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminal }),
    },
  )
    .then((response) => response.body?.cancel())
    .catch(() => undefined);
};
