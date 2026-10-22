import icons from "@dx/api/views/kit/icons.svg?raw";
import css from "@dx/api/views/kit/kit.css?raw";
import js from "@dx/api/views/kit/kit.js?raw";
import {
  frameView,
  VIEW_FRAME_MESSAGE,
  VIEW_HOST_MESSAGE,
  VIEW_MAX_HEIGHT,
  type ViewKit,
} from "@dx/api/views/view-frame.mjs";
import { Maximize2 } from "lucide-react";
import * as React from "react";
import { useTheme } from "../theme/theme-provider.js";
import type { MarkdownViewProps } from "./markdown-view.js";

// This module is the lazy chunk `MarkdownView` loads with the first view: the
// frame, the message bridge, and the kit (styles, `window.ui`, and icons).
const viewKit: ViewKit = { css, js, icons };

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

const takeFrame = (document: string, title: string) => {
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
  created.srcdoc = document;
  // For the frame's lifetime: the shell only loads again when it is new.
  created.addEventListener("load", () => sendScheme(created));
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

/**
 * One document in its sandboxed frame. The frame has an opaque origin: it
 * reaches no dx cookie, storage, or DOM, its CSP blocks every request, and it
 * can neither open windows nor submit forms. It talks to the transcript only
 * through the messages below, each checked against this frame's window.
 */
function ViewDocument({
  source,
  kit,
  palette,
  scheme,
  onOpenLink,
  onError,
  onEscape,
}: {
  readonly source: string;
  readonly kit: ViewKit;
  readonly palette: string;
  readonly scheme: "light" | "dark";
  readonly onOpenLink: (url: string) => void;
  readonly onError: (message: string) => void;
  readonly onEscape: () => void;
}) {
  const [height, setHeight] = React.useState(() => heights.get(source));
  // Built once per source and palette: a theme switch only messages the view.
  const document = frameView(source, { kit, palette });
  // The slot holds the frame, a parked one when its document matches. Runs
  // again when the scheme changes, which re-themes the loaded view.
  const attach = (slot: HTMLDivElement | null) => {
    if (slot === null) return;
    const frame = takeFrame(document, viewTitle(source));
    if (frame.isConnected && canMove(slot)) slot.moveBefore(frame, null);
    else slot.append(frame);
    schemes.set(frame, scheme);
    sendScheme(frame);
    const stop = receiveFrom(frame, (message) => {
      if (message.type === "size") {
        const next = finiteHeight(message.height);
        if (next === undefined) return;
        heights.set(source, next);
        setHeight(next);
      } else if (
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

export function ViewFrame({ source, actions }: MarkdownViewProps) {
  const { resolvedAppearance, palette } = useTheme();
  const [link, setLink] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [escaped, setEscaped] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);
  const toggleFullScreen = () => {
    if (window.document.fullscreenElement === container.current)
      void window.document.exitFullscreen().catch(() => undefined);
    else container.current?.requestFullscreen?.().catch(() => undefined);
  };
  return (
    <figure className="markdown-view" ref={container}>
      {escaped ? (
        <p className="markdown-view-note" role="alert">
          This view tried to load another page, so dx stopped it.
        </p>
      ) : (
        <ViewDocument
          source={source}
          kit={viewKit}
          palette={palette}
          scheme={resolvedAppearance}
          onOpenLink={setLink}
          onError={(message) => setError((current) => current ?? message)}
          onEscape={() => setEscaped(true)}
        />
      )}
      {link !== undefined && (
        <div className="markdown-view-link" aria-live="polite">
          <span>
            Open <code>{link}</code>?
          </span>
          <button
            type="button"
            className="markdown-view-button"
            onClick={() => {
              window.open(link, "_blank", "noopener,noreferrer");
              setLink(undefined);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="markdown-view-button"
            onClick={() => setLink(undefined)}
          >
            Cancel
          </button>
        </div>
      )}
      {error !== undefined && (
        <p className="markdown-view-note" role="status">
          The view's script failed: {error}
        </p>
      )}
      <figcaption className="markdown-view-actions">
        {actions}
        <button
          type="button"
          className="markdown-view-action"
          aria-label="Show view full screen"
          title="Full screen"
          onClick={toggleFullScreen}
        >
          <Maximize2 aria-hidden="true" />
        </button>
      </figcaption>
    </figure>
  );
}
