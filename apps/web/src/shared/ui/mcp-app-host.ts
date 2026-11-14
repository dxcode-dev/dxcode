import {
  pluginStyleVariables,
  VIEW_MAX_HEIGHT,
} from "@dx/api/views/view-frame.mjs";

/**
 * The host side of MCP Apps (the `io.modelcontextprotocol/ui` extension,
 * spec 2026-01-26) for one view in its sandboxed frame. The view speaks
 * JSON-RPC 2.0 over postMessage; the view shell relays it.
 *
 * dx shows the card inline and grants it nothing beyond that: it answers
 * `ui/initialize`, hands over the tool's input and result once the view is
 * initialized, keeps its theme current (light or dark, and dx's tokens as
 * `styles.variables` for the palette), and opens a link only after the
 * person confirms. Every other request, such as `tools/call` or
 * `ui/message`, is refused as not supported, so a view cannot act for the
 * person or the model.
 *
 * A plugin's pane (`pane`) has no tool call: once initialized it hears the
 * plugin's posts as `dx/plugin.message` notifications, and its
 * `dx/plugin.post` requests reach the plugin's `onMessage`.
 */
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

type JsonRpcId = string | number;
type Message = Readonly<Record<string, unknown>>;

/** What a plugin pane's host does beyond showing the view. */
export interface PluginPaneHostOptions {
  /** The view is initialized: deliver what it has not heard yet. */
  readonly onReady: () => void;
  /** Sends a `dx/plugin.post` message; absent for view-only people. */
  readonly onPost?: (message: unknown) => Promise<unknown>;
  /**
   * A trusted pane's `window.dx` messages (`dx/stream.*`, `dx/rtc.*`,
   * `dx/portal.*`); true when handled, and the handler answers requests.
   */
  readonly onExtension?: (
    method: string,
    params: Message | undefined,
    id: JsonRpcId | undefined,
  ) => boolean;
}

export interface McpAppHostOptions {
  /** The tool or pane, as errors name it. */
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResult: unknown;
  readonly pane?: PluginPaneHostOptions;
  readonly theme: "light" | "dark";
  /** dx's palette, whose tokens the view gets as `styles.variables`. */
  readonly palette: string;
  /** Sends one JSON-RPC message to the view. */
  readonly send: (message: Message) => void;
  readonly onOpenLink: (url: string) => void;
  readonly onSize: (height: number) => void;
}

export interface McpAppHost {
  readonly receive: (message: unknown) => void;
  readonly setTheme: (theme: "light" | "dark", palette: string) => void;
  /** Whether the view finished `ui/initialize`. */
  readonly ready: () => boolean;
  /** Sends a notification to an initialized view. */
  readonly notify: (method: string, params: unknown) => void;
}

const record = (value: unknown): Message | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Message)
    : undefined;

const requestId = (value: unknown): JsonRpcId | undefined =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;

export const createMcpAppHost = (options: McpAppHostOptions): McpAppHost => {
  let theme = options.theme;
  let palette = options.palette;
  const styles = () => ({
    variables: pluginStyleVariables(palette, theme),
  });
  let initialized = false;
  let delivered = false;
  const notify = (method: string, params: unknown) =>
    options.send({ jsonrpc: "2.0", method, params });
  const reply = (id: JsonRpcId, result: unknown) =>
    options.send({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    options.send({ jsonrpc: "2.0", id, error: { code, message } });
  const hostContext = () => ({
    theme,
    styles: styles(),
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    platform: "web",
    // A pane fills its tab; a card grows to a cap.
    ...(options.pane === undefined
      ? { containerDimensions: { maxHeight: VIEW_MAX_HEIGHT } }
      : {}),
    ...(typeof navigator === "undefined" ? {} : { locale: navigator.language }),
  });

  return {
    receive: (value) => {
      const message = record(value);
      if (message?.jsonrpc !== "2.0" || typeof message.method !== "string")
        return;
      const id = requestId(message.id);
      const params = record(message.params);
      switch (message.method) {
        case "ui/initialize":
          if (id === undefined) return;
          initialized = true;
          reply(id, {
            protocolVersion: MCP_APP_PROTOCOL_VERSION,
            hostInfo: { name: "dx", version: "1.0.0" },
            hostCapabilities: { openLinks: {}, logging: {} },
            hostContext: hostContext(),
          });
          return;
        case "ui/notifications/initialized":
          if (!initialized || delivered) return;
          delivered = true;
          if (options.pane !== undefined) {
            options.pane.onReady();
            return;
          }
          notify("ui/notifications/tool-input", {
            arguments: record(options.toolInput) ?? {},
          });
          notify("ui/notifications/tool-result", options.toolResult);
          return;
        case "ui/notifications/size-changed": {
          const height = params?.height;
          if (typeof height === "number" && Number.isFinite(height))
            options.onSize(height);
          return;
        }
        case "ping":
          if (id !== undefined) reply(id, {});
          return;
        case "ui/open-link": {
          if (id === undefined) return;
          const url = params?.url;
          if (typeof url === "string" && /^https?:\/\//i.test(url)) {
            options.onOpenLink(url);
            reply(id, {});
          } else fail(id, -32602, "Only http and https links can open.");
          return;
        }
        case "ui/request-display-mode":
          if (id !== undefined) reply(id, { mode: "inline" });
          return;
        case "dx/plugin.post": {
          if (id === undefined) return;
          if (options.pane === undefined) {
            fail(
              id,
              -32601,
              `dx does not support dx/plugin.post in ${options.toolName}'s card.`,
            );
            return;
          }
          const post = options.pane.onPost;
          if (post === undefined) {
            fail(
              id,
              -32600,
              "People who can only view this Thread cannot post to plugins.",
            );
            return;
          }
          post(params?.message ?? null).then(
            (result) => reply(id, { result: result ?? null }),
            (error: unknown) =>
              fail(
                id,
                -32000,
                error instanceof Error
                  ? error.message
                  : "The plugin could not answer.",
              ),
          );
          return;
        }
        default:
          // A trusted pane's window.dx.
          if (options.pane?.onExtension?.(message.method, params, id) === true)
            return;
          // Notifications dx does not use, such as logging, are dropped.
          if (id !== undefined)
            fail(
              id,
              -32601,
              `dx does not support ${message.method.slice(0, 100)} in ${options.toolName}'s card.`,
            );
      }
    },
    ready: () => delivered,
    notify: (method, params) => {
      if (delivered) notify(method, params);
    },
    setTheme: (next, nextPalette) => {
      if (next === theme && nextPalette === palette) return;
      theme = next;
      palette = nextPalette;
      if (initialized)
        notify("ui/notifications/host-context-changed", {
          theme,
          styles: styles(),
        });
    },
  };
};
