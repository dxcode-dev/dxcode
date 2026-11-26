import { GetPluginPaneIceServersEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../../shared/api/client.js";

/**
 * A trusted pane's WebRTC ICE servers: short-lived TURN credentials
 * for this viewer, or Cloudflare's public STUN server. Loaded with the
 * pane's live chunk only.
 */

export const paneIceServers = async (
  threadId: ThreadId,
  plugin: string,
  pane: string,
) =>
  (
    await dxClient.call(GetPluginPaneIceServersEndpoint, {
      params: { threadId, plugin, pane },
    })
  ).data.iceServers;
