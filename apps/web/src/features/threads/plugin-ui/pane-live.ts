import type { PluginPaneLive } from "@dx/api";
import { VIEW_HOST_MESSAGE } from "@dx/api/views/view-frame.mjs";
import type { ThreadId } from "@dx/domain";
import { paneIceServers } from "./pane-live-queries.js";

/**
 * What a trusted plugin pane's `window.dx` reaches: its stream, held
 * here as one WebSocket to dx and relayed into the sealed frame (binary
 * messages move, not copied), its WebRTC ICE servers, and the Thread's own
 * Portal drawn over a box the view reserves. The frame itself never
 * connects anywhere.
 */

export type PaneLive = PluginPaneLive;

export interface PortalPlacement {
  readonly url: string;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface PaneLiveOptions {
  readonly threadId: ThreadId;
  readonly plugin: string;
  readonly pane: string;
  readonly live: PaneLive;
  readonly frame: HTMLIFrameElement;
  /** People who can only view the Thread watch but do not send. */
  readonly canSend: boolean;
  readonly onPortal: (
    key: string,
    placement: PortalPlacement | undefined,
  ) => void;
}

const panePath = (threadId: ThreadId, plugin: string, pane: string) =>
  `/v1/threads/${encodeURIComponent(threadId)}/plugin-ui/panes/${encodeURIComponent(plugin)}/${encodeURIComponent(pane)}`;

const record = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

export const createPaneLive = (options: PaneLiveOptions) => {
  const { frame, threadId, plugin, pane, live } = options;
  let socket: WebSocket | undefined;
  let wanted = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const post = (message: Record<string, unknown>, transfer?: Transferable[]) =>
    frame.contentWindow?.postMessage(
      {
        source: VIEW_HOST_MESSAGE,
        type: "mcp",
        message: { jsonrpc: "2.0", ...message },
      },
      "*",
      transfer ?? [],
    );
  const state = (params: Record<string, unknown>) =>
    post({ method: "dx/stream.state", params: { id: pane, ...params } });

  const connect = () => {
    if (closed || !wanted) return;
    const url = `${location.origin.replace(/^http/, "ws")}${panePath(threadId, plugin, pane)}/stream`;
    const next = new WebSocket(url);
    next.binaryType = "arraybuffer";
    socket = next;
    next.onmessage = (event) => {
      const data: unknown = event.data;
      if (typeof data === "string" && data.startsWith("\u0000")) {
        // dx's own news about the stream.
        const control = record(JSON.parse(data.slice(1)));
        if (control?.t === "hello") {
          retry = 0;
          state({ state: "open", producers: control.producers });
        } else if (control?.t === "state")
          state({ producers: control.producers, reason: control.revoked });
        else if (control?.t === "throttled") state({ state: "throttled" });
        return;
      }
      if (data instanceof ArrayBuffer)
        post({ method: "dx/stream.message", params: { id: pane, data } }, [
          data,
        ]);
      else post({ method: "dx/stream.message", params: { id: pane, data } });
    };
    next.onclose = (event) => {
      if (socket !== next) return;
      socket = undefined;
      // Refused for good: the plugin lost its tier or the pane is gone
      // (4403), or dx refused the connection itself five times running
      // without ever saying hello (a 403 or 404 arrives as 1006).
      if (
        closed ||
        !wanted ||
        event.code === 4403 ||
        event.code === 1008 ||
        retry >= 5
      ) {
        state({ state: "closed", reason: event.reason || "closed" });
        return;
      }
      state({ producers: 0, reason: "reconnecting" });
      timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
    };
  };

  const reply = (id: unknown, result: unknown) => post({ id, result });
  const fail = (id: unknown, message: string) =>
    post({ id, error: { code: -32000, message } });

  return {
    /** Handles one of `window.dx`'s messages; false for any other method. */
    handle(
      method: string,
      params: Readonly<Record<string, unknown>> | undefined,
      id: unknown,
    ) {
      switch (method) {
        case "dx/stream.open":
          if (params?.id !== pane) return true;
          wanted = true;
          if (socket === undefined) connect();
          else state({ state: "open" });
          return true;
        case "dx/stream.send": {
          const data = params?.data;
          if (
            options.canSend &&
            socket?.readyState === WebSocket.OPEN &&
            (typeof data === "string" || data instanceof ArrayBuffer)
          )
            socket.send(data);
          return true;
        }
        case "dx/stream.close":
          wanted = false;
          clearTimeout(timer);
          socket?.close(1000, "closed");
          socket = undefined;
          return true;
        case "dx/rtc.iceServers":
          if (id === undefined) return true;
          if (!live.webrtc || !options.canSend) {
            fail(
              id,
              "This pane did not declare WebRTC, or you can only view this Thread.",
            );
            return true;
          }
          void paneIceServers(panePath(threadId, plugin, pane))
            .then((iceServers) => reply(id, { iceServers }))
            .catch((error: unknown) =>
              fail(
                id,
                error instanceof Error ? error.message : "No ICE servers.",
              ),
            );
          return true;
        case "dx/portal.place": {
          const key = String(params?.key ?? "");
          const port = Number(params?.port);
          const portal = live.portals.find(
            (candidate) => candidate.port === port,
          );
          const rect = record(params?.rect);
          // Only this Thread's Portal for that port: a path such as
          // `//other.example` resolves to another origin and is refused.
          const origin = portal === undefined ? "" : new URL(portal.url).origin;
          let url: URL | undefined;
          try {
            url = new URL(String(params?.path ?? "/"), `${origin}/`);
          } catch {
            url = undefined;
          }
          if (
            portal === undefined ||
            rect === undefined ||
            url === undefined ||
            url.origin !== origin
          )
            return true;
          const number = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) ? value : 0;
          options.onPortal(key, {
            url: url.href,
            rect: {
              x: number(rect.x),
              y: number(rect.y),
              width: Math.max(0, number(rect.width)),
              height: Math.max(0, number(rect.height)),
            },
          });
          return true;
        }
        case "dx/csp.violation":
          // One log line in dx's Worker per request the pane's policy refused.
          navigator.sendBeacon(
            "/api/csp-reports?policy=pane-connect",
            new Blob(
              [
                JSON.stringify({
                  "csp-report": {
                    "violated-directive": String(params?.directive ?? ""),
                    "effective-directive": String(params?.directive ?? ""),
                    "blocked-uri": String(params?.blocked ?? ""),
                    "document-uri": `plugin-pane:${plugin}/${pane}`,
                  },
                }),
              ],
              { type: "application/csp-report" },
            ),
          );
          return true;
        case "dx/portal.close":
          options.onPortal(String(params?.key ?? ""), undefined);
          return true;
        default:
          return false;
      }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close(1000, "pane closed");
      socket = undefined;
    },
  };
};
