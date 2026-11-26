import icons from "@dx/api/views/kit/icons.svg?raw";
import css from "@dx/api/views/kit/kit.css?raw";
import js from "@dx/api/views/kit/kit.js?raw";
import {
  type UiSdkCode,
  uiSdkComponents,
  usesPluginUi,
  VIEW_FRAME_MESSAGE,
  VIEW_FRAME_PATH,
  VIEW_HOST_MESSAGE,
  VIEW_MAX_HEIGHT,
  type ViewKit,
  viewDocument,
} from "@dx/api/views/view-frame.mjs";
import { useRouter } from "@tanstack/react-router";
import { Maximize2 } from "lucide-react";
import * as React from "react";
import { useTheme } from "../theme/theme-provider.js";
import { Button } from "./button.js";
import type { MarkdownViewProps } from "./markdown-view.js";
import { createMcpAppHost, type McpAppHost } from "./mcp-app-host.js";
import type { McpAppViewProps } from "./mcp-app-view.js";

// This module is the lazy chunk `MarkdownView` loads with the first view: the
// frame, the message bridge, and the kit (styles, `window.ui`, and icons).
const viewKit: ViewKit = { css, js, icons };

/**
 * The link a frame asks to open. A page of this dx deployment, such as a
 * Thread or an artifact, opens in place like any dx link; another site waits
 * under the frame for the person's Open or Cancel.
 */
const useFrameLink = () => {
  const router = useRouter({ warn: false });
  const [link, setLink] = React.useState<string>();
  const open = (url: string) => {
    const target = URL.canParse(url) ? new URL(url) : undefined;
    if (
      router !== undefined &&
      target !== undefined &&
      target.origin === window.location.origin
    ) {
      setLink(undefined);
      router.history.push(`${target.pathname}${target.search}${target.hash}`);
      return;
    }
    setLink(url);
  };
  return { link, open, setLink };
};

/**
 * `@dxcode/plugin-ui`'s code, a chunk of its own that loads only with the
 * first view or MCP Apps card that asks for it. A failed load leaves such frames
 * plain HTML.
 */
let pluginUiCode: Promise<string | undefined> | undefined;
const loadPluginUi = () => {
  pluginUiCode ??= import("@dxcode/plugin-ui/plugin-ui.js?minified").then(
    (module) => module.default,
    () => {
      // Later frames try again, such as after a deploy renamed the chunk.
      setTimeout(() => {
        pluginUiCode = undefined;
      }, 30_000);
      return undefined;
    },
  );
  return pluginUiCode;
};
const usePluginUi = (html: string) =>
  usesPluginUi(html) ? React.use(loadPluginUi()) : undefined;

/**
 * UI SDK's styles and the code of the components a view uses (`ui-*`
 * tags), by set of components. Each chunk is a lazy module of its own that
 * loads only with the first view that needs it. A failed load leaves the
 * view's `ui-*` tags plain HTML; later views try again.
 */
const uiSdkCode = new Map<string, Promise<UiSdkCode | undefined>>();
// Kept for the session, so a view that renders again gets the same promise
// and never suspends twice: a session sees a few distinct sets at most.
const loadUiSdk = (components: readonly string[]) => {
  const key = components.join(" ");
  let code = uiSdkCode.get(key);
  if (code === undefined) {
    code = import("virtual:dx-ui-sdk").then(
      (kit) => kit.uiSdkCode(components),
      () => {
        setTimeout(() => uiSdkCode.delete(key), 30_000);
        return undefined;
      },
    );
    uiSdkCode.set(key, code);
  }
  return code;
};
const useUiSdk = (html: string) => {
  const components = uiSdkComponents(html);
  return components.length > 0 ? React.use(loadUiSdk(components)) : undefined;
};

/**
 * The last height each view reported, so a view that scrolls back into a
 * virtualized transcript takes its space before its frame loads again.
 */
const heights = new Map<string, number>();

const viewTitle = (source: string) =>
  (
    /<title[^>]*>([^<]*)<\/title>/i.exec(source)?.[1] ??
    /class="[^"]*\bui-title\b[^"]*"[^>]*>([^<]*)</i.exec(source)?.[1]
  )
    ?.replace(/\s+/g, " ")
    .trim() || "Interactive view";

const finiteHeight = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(VIEW_MAX_HEIGHT, Math.max(0, Math.ceil(value)))
    : undefined;

type FrameMessage = Readonly<Record<string, unknown>>;

/** Each mounted view frame's handler for the messages its window posts. */
const receivers = new Map<HTMLIFrameElement, (message: FrameMessage) => void>();

const dispatch = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (event.source === null || typeof data !== "object" || data === null)
    return;
  const message = data as FrameMessage;
  if (message.source !== VIEW_FRAME_MESSAGE) return;
  for (const [frame, receive] of receivers)
    if (event.source === frame.contentWindow) receive(message);
};

/**
 * Routes the messages `frame`'s own window posts to `receive`, through one
 * window listener for every view, until the returned function runs.
 */
const receiveFrom = (
  frame: HTMLIFrameElement,
  receive: (message: FrameMessage) => void,
) => {
  if (receivers.size === 0) window.addEventListener("message", dispatch);
  receivers.set(frame, receive);
  return () => {
    receivers.delete(frame);
    if (receivers.size === 0) window.removeEventListener("message", dispatch);
  };
};

/**
 * Frames whose view unmounted, by document. The transcript remounts a reply
 * when its turn finishes (the reply moves from the work list to the answer)
 * and when a row scrolls out of the virtualizer; a frame moved with
 * `moveBefore` keeps its document, so a view that mounts again with the same
 * document takes the parked frame instead of reloading. Frames wait on an
 * offscreen shelf for a few seconds. Browsers without `moveBefore` reload.
 */
const parked = new Map<string, HTMLIFrameElement[]>();
const PARK_MS = 5_000;
const PARK_LIMIT = 4;
let shelf: HTMLDivElement | undefined;
let parkedCount = 0;
/** Frames that navigated away; they never return to a view. */
const escapedFrames = new WeakSet<HTMLIFrameElement>();

const canMove = (
  node: Element,
): node is Element & {
  moveBefore: (node: Node, child: Node | null) => void;
} => "moveBefore" in node;

/** The scheme each frame's view should show; a reloaded frame gets it again. */
const schemes = new WeakMap<HTMLIFrameElement, "light" | "dark">();

const sendScheme = (frame: HTMLIFrameElement) => {
  const scheme = schemes.get(frame);
  if (scheme !== undefined)
    frame.contentWindow?.postMessage(
      { source: VIEW_HOST_MESSAGE, type: "scheme", scheme },
      "*",
    );
};

/**
 * The shell at `VIEW_FRAME_PATH` has its own CSP; a srcdoc frame would take
 * the app's. It gets the view's document once it loads, and again if it ever
 * loads afresh.
 */
const sendDocument = (
  frame: HTMLIFrameElement,
  document: string,
  mcpApp: boolean,
) =>
  frame.contentWindow?.postMessage(
    { source: VIEW_HOST_MESSAGE, type: "document", document, mcpApp },
    "*",
  );

const takeFrame = (document: string, title: string, mcpApp: boolean) => {
  const waiting = parked.get(document);
  const frame = waiting?.pop();
  if (frame !== undefined) {
    parkedCount--;
    if (waiting?.length === 0) parked.delete(document);
    return frame;
  }
  const created = window.document.createElement("iframe");
  created.className = "markdown-view-frame";
  created.title = title;
  created.sandbox.add("allow-scripts");
  created.referrerPolicy = "no-referrer";
  created.src = VIEW_FRAME_PATH;
  // For the frame's lifetime: the shell only loads again when it is new.
  created.addEventListener("load", () => {
    sendDocument(created, document, mcpApp);
    sendScheme(created);
  });
  return created;
};

const parkFrame = (frame: HTMLIFrameElement, document: string) => {
  if (shelf === undefined) {
    shelf = window.document.createElement("div");
    shelf.className = "markdown-view-shelf";
    shelf.setAttribute("aria-hidden", "true");
  }
  const target = shelf;
  if (
    escapedFrames.has(frame) ||
    !frame.isConnected ||
    !canMove(target) ||
    parkedCount >= PARK_LIMIT
  ) {
    frame.remove();
    return;
  }
  if (!target.isConnected) window.document.body.append(target);
  // Same width on the shelf, so the view does not lay out again.
  target.style.width = `${frame.getBoundingClientRect().width}px`;
  target.moveBefore(frame, null);
  parked.set(document, [...(parked.get(document) ?? []), frame]);
  parkedCount++;
  setTimeout(() => {
    const waiting = parked.get(document) ?? [];
    if (!waiting.includes(frame)) return;
    parked.set(
      document,
      waiting.filter((candidate) => candidate !== frame),
    );
    if (parked.get(document)?.length === 0) parked.delete(document);
    parkedCount--;
    frame.remove();
  }, PARK_MS);
};

/** What an MCP App card hands its view, and the call it came from. */
interface McpAppCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResult: unknown;
}

/**
 * Each MCP App frame's host, kept with the frame so a parked frame keeps its
 * session, and the handlers of the view that currently shows it.
 */
const mcpHosts = new WeakMap<HTMLIFrameElement, McpAppHost>();
const mcpHandlers = new WeakMap<
  HTMLIFrameElement,
  {
    readonly onOpenLink: (url: string) => void;
    readonly onSize: (height: number) => void;
  }
>();

const mcpHostFor = (
  frame: HTMLIFrameElement,
  call: McpAppCall,
  theme: "light" | "dark",
  palette: string,
) => {
  const existing = mcpHosts.get(frame);
  if (existing !== undefined) return existing;
  const host = createMcpAppHost({
    ...call,
    theme,
    palette,
    send: (message) =>
      frame.contentWindow?.postMessage(
        { source: VIEW_HOST_MESSAGE, type: "mcp", message },
        "*",
      ),
    onOpenLink: (url) => mcpHandlers.get(frame)?.onOpenLink(url),
    onSize: (height) => mcpHandlers.get(frame)?.onSize(height),
  });
  mcpHosts.set(frame, host);
  return host;
};

/**
 * One document in its sandboxed frame. The frame has an opaque origin: it
 * reaches no dx cookie, storage, or DOM, its CSP blocks every request, and it
 * can neither open windows nor submit forms. It talks to the transcript only
 * through the messages below, each checked against this frame's window.
 * An MCP App's frame (`mcp`) also speaks MCP Apps JSON-RPC to its host.
 */
function ViewDocument({
  document,
  title,
  scheme,
  palette,
  mcp,
  onOpenLink,
  onError,
  onEscape,
}: {
  readonly document: string;
  readonly title: string;
  readonly scheme: "light" | "dark";
  readonly palette: string;
  readonly mcp?: McpAppCall;
  readonly onOpenLink: (url: string) => void;
  readonly onError: (message: string) => void;
  readonly onEscape: () => void;
}) {
  const [height, setHeight] = React.useState(() => heights.get(document));
  const resize = (value: unknown) => {
    const next = finiteHeight(value);
    if (next === undefined) return;
    heights.set(document, next);
    setHeight(next);
  };
  // The slot holds the frame, a parked one when its document matches. Runs
  // again when the scheme changes, which re-themes the loaded view.
  const attach = (slot: HTMLDivElement | null) => {
    if (slot === null) return;
    const frame = takeFrame(document, title, mcp !== undefined);
    if (frame.isConnected && canMove(slot)) slot.moveBefore(frame, null);
    else slot.append(frame);
    schemes.set(frame, scheme);
    sendScheme(frame);
    const host =
      mcp === undefined ? undefined : mcpHostFor(frame, mcp, scheme, palette);
    if (host !== undefined) {
      mcpHandlers.set(frame, { onOpenLink, onSize: resize });
      host.setTheme(scheme, palette);
    }
    const stop = receiveFrom(frame, (message) => {
      if (message.type === "size") resize(message.height);
      else if (message.type === "mcp") host?.receive(message.message);
      else if (
        message.type === "open" &&
        typeof message.url === "string" &&
        /^https?:\/\//i.test(message.url)
      )
        onOpenLink(message.url);
      else if (message.type === "error" && typeof message.message === "string")
        onError(message.message.slice(0, 300));
      else if (message.type === "escaped") {
        escapedFrames.add(frame);
        onEscape();
      }
    });
    return () => {
      stop();
      parkFrame(frame, document);
    };
  };
  return (
    <div
      ref={attach}
      className="markdown-view-slot"
      style={
        height === undefined
          ? undefined
          : ({ "--view-height": `${height}px` } as React.CSSProperties)
      }
    />
  );
}

/** A framed document with its link confirmation, notes, and actions. */
function FramedView({
  document,
  title,
  mcp,
  className,
  actions,
}: {
  readonly document: string;
  readonly title: string;
  readonly mcp?: McpAppCall;
  readonly className?: string;
  readonly actions: React.ReactNode;
}) {
  const { resolvedAppearance, palette } = useTheme();
  const { link, open: openLink, setLink } = useFrameLink();
  const [error, setError] = React.useState<string>();
  const [escaped, setEscaped] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);
  const toggleFullScreen = () => {
    if (window.document.fullscreenElement === container.current)
      void window.document.exitFullscreen().catch(() => undefined);
    else container.current?.requestFullscreen?.().catch(() => undefined);
  };
  return (
    <figure
      className={
        className === undefined ? "markdown-view" : `markdown-view ${className}`
      }
      ref={container}
    >
      {escaped ? (
        <p className="markdown-view-note" role="alert">
          This view tried to load another page, so dx stopped it.
        </p>
      ) : (
        <ViewDocument
          document={document}
          title={title}
          scheme={resolvedAppearance}
          palette={palette}
          mcp={mcp}
          onOpenLink={openLink}
          onError={(message) => setError((current) => current ?? message)}
          onEscape={() => setEscaped(true)}
        />
      )}
      {link !== undefined && (
        <div className="markdown-view-link" aria-live="polite">
          <span>
            Open <code>{link}</code>?
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              window.open(link, "_blank", "noopener,noreferrer");
              setLink(undefined);
            }}
          >
            Open
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setLink(undefined)}
          >
            Cancel
          </Button>
        </div>
      )}
      {error !== undefined && (
        <p className="markdown-view-note" role="status">
          The view's script failed: {error}
        </p>
      )}
      <figcaption className="markdown-view-actions">
        {actions}
        <Button
          variant="ghost"
          size="icon-xs"
          className="markdown-view-action"
          aria-label="Show view full screen"
          title="Full screen"
          onClick={toggleFullScreen}
        >
          <Maximize2 aria-hidden="true" />
        </Button>
      </figcaption>
    </figure>
  );
}

export function ViewFrame({ source, actions }: MarkdownViewProps) {
  const { palette } = useTheme();
  // A view may ask for @dxcode/plugin-ui.
  const pluginUi = usePluginUi(source);
  // Built once per source and palette: a theme switch only messages the view.
  const uiSdk = useUiSdk(source);
  const document = viewDocument(source, {
    kit: viewKit,
    palette,
    pluginUi,
    uiSdk,
  });
  return (
    <FramedView
      document={document}
      title={viewTitle(source)}
      actions={actions}
    />
  );
}

/**
 * An MCP App's view in a tool row: the same frame as a dx-view, speaking
 * MCP Apps to a host that only shows it. `cardKey` keeps two calls that
 * share a view from sharing a parked frame, and so each other's results.
 */
export function McpAppFrame({ view, cardKey }: McpAppViewProps) {
  const { palette } = useTheme();
  const pluginUi = usePluginUi(view.html);
  const uiSdk = useUiSdk(view.html);
  // The palette when the card mounts: a later change reaches it as
  // `styles.variables`, without reloading the card.
  const [initialPalette] = React.useState(palette);
  const document = `${viewDocument(view.html, { kit: viewKit, mcpApp: true, palette: initialPalette, pluginUi, uiSdk })}\n<!-- ${cardKey.replaceAll("-->", "")} -->\n`;
  return (
    <FramedView
      document={document}
      title={`${view.server} ${view.tool}`}
      className={
        view.prefersBorder === true ? "is-mcp-app is-bordered" : "is-mcp-app"
      }
      mcp={{
        toolName: view.tool,
        toolInput: view.toolInput,
        toolResult: view.toolResult,
      }}
      actions={null}
    />
  );
}
