import type { Bindings } from "../../http/types.js";
import {
  STREAM_INTERNAL_ORIGIN,
  STREAM_META_HEADER,
  type StreamMeta,
} from "./relay.js";
import { signStreamToken } from "./token.js";

/**
 * Where a stream lives and how a host opens it. One relay Durable
 * Object per Thread, install, and pane.
 */

export const STREAM_PRODUCER_PATH = "/v1/plugin-streams/producer";

export interface StreamTarget {
  readonly threadId: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly paneId: string;
  readonly tier: string;
  readonly bytesPerSecond: number;
}

export const streamRelay = (bindings: Bindings, target: StreamTarget) => {
  const namespace = bindings.PLUGIN_STREAM_RELAY;
  if (namespace === undefined)
    throw new Error("This deployment does not relay plugin streams.");
  return namespace.getByName(
    `${target.threadId}:${target.pluginId}:${target.paneId}`,
  );
};

/** The deployment's public origin, which producers connect to. */
const publicOrigin = (bindings: Bindings) => {
  try {
    return new URL(bindings.DX_AUTH_URL ?? "").origin;
  } catch {
    throw new Error("This deployment has no public URL for stream producers.");
  }
};

/**
 * Opens a stream for a host: its id (the pane's) and a signed producer URL
 * that connects once within ten minutes. The Orb and container hosts hold
 * this URL's WebSocket; `PluginStream.url` hands it to a process the plugin
 * starts.
 */
export const openPluginStream = async (
  bindings: Bindings,
  target: StreamTarget,
) => {
  const { token, claims } = await signStreamToken(bindings, target);
  const origin = publicOrigin(bindings).replace(/^http/, "ws");
  return {
    id: target.paneId,
    url: `${origin}${STREAM_PRODUCER_PATH}?t=${token}`,
    expiresAt: claims.expiresAt,
  };
};

/** A request to the relay, with dx's own meta; callers' headers are dropped. */
export const relayRequest = (
  path: "/producer" | "/viewer",
  meta: StreamMeta,
  from?: Request,
) => {
  const headers = new Headers({ upgrade: "websocket" });
  if (from !== undefined)
    for (const name of [
      "connection",
      "sec-websocket-extensions",
      "sec-websocket-key",
      "sec-websocket-protocol",
      "sec-websocket-version",
    ]) {
      const value = from.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
  headers.set(STREAM_META_HEADER, JSON.stringify(meta));
  return new Request(`${STREAM_INTERNAL_ORIGIN}${path}`, { headers });
};

/**
 * A producer socket held inside dx (the Worker or Durable Object host's
 * `ctx.ui.stream`): no URL, the relay's internal fetch.
 */
export const connectHostProducer = async (
  bindings: Bindings,
  target: StreamTarget,
  host: StreamMeta["host"],
  requestId: string,
) => {
  const response = await streamRelay(bindings, target).fetch(
    relayRequest("/producer", { ...target, requestId, host }),
  );
  const socket = response.webSocket;
  if (socket === null)
    throw new Error(
      `The stream relay refused the producer (${response.status}).`,
    );
  socket.accept();
  return socket;
};
