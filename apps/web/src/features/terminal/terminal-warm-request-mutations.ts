import { WarmThreadTerminalEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../shared/api/client.js";

/**
 * `POST /v1/threads/:id/terminal/warm`. Loaded on the first warm, so the
 * Thread page's first load does not carry the Terminal endpoints.
 */
export const requestTerminalWarm = (threadId: ThreadId) =>
  dxClient.call(
    WarmThreadTerminalEndpoint,
    { params: { threadId } },
    { keepalive: true },
  );
