import type { ThreadId } from "@dx/domain";
import type { WaymoteSession, WaymoteSessionState } from "@rockorager/waymote";
import { Monitor, Play, RefreshCw } from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import {
  desktopPath,
  checkDesktop as requestDesktop,
} from "./desktop-queries.js";

// The Thread's Linux desktop, streamed by Waymote from the sandbox. The
// browser reaches it only through dx Core's authenticated Thread routes: a
// status check that starts the desktop, then three WebSockets that Core
// relays to the sandbox's loopback gateway (deploy/orb/README.md#desktop).

const loadWaymote = () => import("@rockorager/waymote");

type DesktopChannel = "stream" | "audio" | "control";

const desktopChannelUrl = (threadId: ThreadId, channel: DesktopChannel) =>
  `${window.location.origin.replace(/^http/, "ws")}${desktopPath(threadId)}/${channel}`;

/**
 * Without input on the desktop for this long, the viewer disconnects. Waymote
 * pings the control socket every second and Core counts every browser
 * message as workspace activity, so a forgotten Desktop tab would keep the
 * sandbox awake forever. Five minutes, plus the workspace's own five-minute
 * inactivity pause, bounds a forgotten tab to about ten minutes awake; an
 * agent at work keeps the workspace awake by itself.
 */
export const DESKTOP_IDLE_PAUSE_MS = 5 * 60_000;
/**
 * After the Desktop leaves the screen (another tab, a collapsed pane, a
 * hidden document) the stream stays connected this long, so coming straight
 * back shows it at once instead of reconnecting.
 */
export const DESKTOP_HIDDEN_GRACE_MS = 60_000;
/** Consecutive sockets that close before opening, before checking again. */
const SOCKET_FAILURE_LIMIT = 6;
/** Status checks after socket failures before the viewer gives up. */
const RECOVERY_LIMIT = 2;
/** A socket open this long proves the desktop healthy again. */
const STABLE_SOCKET_MS = 30_000;
/**
 * The remote clipboard reaches the local one only this soon after a key
 * press or click on the desktop by the person holding control, so guest
 * code cannot replace the local clipboard on its own.
 */
const CLIPBOARD_GESTURE_MS = 2_000;

// The remote output follows the viewer's size at its pixel density, at least
// a usable laptop-sized desktop (the canvas letterboxes when the pane is
// smaller) and at most about 1080p of encoded pixels.
const remoteDisplay = () => {
  const density = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const minWidth = Math.round(960 * density);
  const minHeight = Math.round(540 * density);
  return {
    mode: "observe",
    devicePixelRatio: density,
    minWidth,
    minHeight,
    maxPixels: Math.max(1920 * 1200, minWidth * minHeight),
  } as const;
};

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const documentVisible = () => document.visibilityState === "visible";
const serverVisible = () => false;

type DesktopStatus =
  | { readonly phase: "starting" }
  | { readonly phase: "live"; readonly inputBusy: boolean }
  | { readonly phase: "reconnecting" }
  | { readonly phase: "unsupported" }
  | {
      readonly phase: "failed";
      readonly message: string;
      /** The viewer's code failed to load: only a page reload fetches it. */
      readonly reload?: boolean;
    };

const nextStatus = (
  state: WaymoteSessionState,
  connectedOnce: boolean,
): DesktopStatus => {
  switch (state.video.state) {
    case "connected":
      return { phase: "live", inputBusy: state.input.state === "busy" };
    case "error":
      return { phase: "failed", message: state.video.message };
    default:
      return connectedOnce ? { phase: "reconnecting" } : { phase: "starting" };
  }
};

/** Starts the desktop through Core and says whether it can stream. */
const checkDesktop = async (
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<"ready" | DesktopStatus> => {
  const availability = await requestDesktop(threadId, signal);
  if (availability.kind === "ready") return "ready";
  if (availability.kind === "unsupported") return { phase: "unsupported" };
  return { phase: "failed", message: availability.message };
};

interface DesktopViewerProps {
  /** The Desktop tab is shown; the viewer connects only then. */
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly loadClient?: typeof loadWaymote;
}

interface DesktopInput {
  /** Any input on the desktop, including pointer movement. */
  lastInput: number;
  /** A key press or click. */
  lastGesture: number;
}

function DesktopSession({
  threadId,
  loadClient,
  onRetry,
  onIdle,
}: {
  readonly threadId: ThreadId;
  readonly loadClient: typeof loadWaymote;
  readonly onRetry: () => void;
  readonly onIdle: () => void;
}) {
  const [status, setStatus] = React.useState<DesktopStatus>({
    phase: "starting",
  });
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const input = React.useRef<DesktopInput>({
    lastInput: Date.now(),
    lastGesture: Number.NEGATIVE_INFINITY,
  });
  const attach = React.useCallback(
    (surface: HTMLDivElement | null) => {
      const display = canvas.current;
      if (surface === null || display === null) return;
      const controller = new AbortController();
      const disposed = () => controller.signal.aborted;
      let session: WaymoteSession | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      // Set once the viewer gives up; the SDK's own states no longer show.
      let halted = false;
      const stop = (next: DesktopStatus) => {
        if (disposed()) return;
        halted = true;
        clearTimeout(idleTimer);
        session?.disconnect();
        setStatus(next);
      };
      // Unmounting (the paused state replaces this session) disposes it.
      const watchIdle = (delay: number) => {
        idleTimer = setTimeout(() => {
          const idle = Date.now() - input.current.lastInput;
          if (idle >= DESKTOP_IDLE_PAUSE_MS) onIdle();
          else watchIdle(DESKTOP_IDLE_PAUSE_MS - idle);
        }, delay);
      };

      const start = async () => {
        if (!("VideoDecoder" in window)) {
          setStatus({
            phase: "failed",
            message:
              "This browser can't decode the desktop: it lacks the WebCodecs VideoDecoder API.",
          });
          return;
        }
        // Load the viewer while Core starts the desktop.
        const client = loadClient().then(
          (module) => module,
          () => undefined,
        );
        const desktop = await checkDesktop(threadId, controller.signal);
        if (disposed()) return;
        if (desktop !== "ready") {
          setStatus(desktop);
          return;
        }
        const waymote = await client;
        if (disposed()) return;
        if (waymote === undefined) {
          setStatus({
            phase: "failed",
            message: "Desktop viewer failed to load.",
            reload: true,
          });
          return;
        }

        // Core answers a refused upgrade (desktop or workspace unavailable)
        // with an error status, which the SDK sees as a dropped socket and
        // retries forever. Count sockets that never open; after a run of
        // them, ask Core again and stop unless the desktop is ready.
        let failures = 0;
        let recoveries = 0;
        let recovering = false;
        const recover = async () => {
          recovering = true;
          session?.disconnect();
          setStatus({ phase: "reconnecting" });
          const again = await checkDesktop(threadId, controller.signal);
          if (disposed()) return;
          if (again !== "ready") return stop(again);
          if (recoveries >= RECOVERY_LIMIT)
            return stop({
              phase: "failed",
              message: "The desktop stopped responding.",
            });
          recoveries += 1;
          failures = 0;
          recovering = false;
          session?.connect();
        };
        const socketFor = (channel: DesktopChannel) => {
          const socket = new WebSocket(desktopChannelUrl(threadId, channel));
          let openedAt: number | undefined;
          socket.addEventListener("open", () => {
            openedAt = Date.now();
            failures = 0;
          });
          socket.addEventListener("close", () => {
            if (disposed() || recovering) return;
            if (openedAt !== undefined) {
              if (Date.now() - openedAt >= STABLE_SOCKET_MS) recoveries = 0;
              return;
            }
            failures += 1;
            if (failures >= SOCKET_FAILURE_LIMIT) void recover();
          });
          return socket;
        };

        let connectedOnce = false;
        session = new waymote.WaymoteSession({
          audio: false,
          remoteDisplay: remoteDisplay(),
          createWebSocket: (path) => socketFor(path.slice(1) as DesktopChannel),
        });
        const current = session;
        current.on("state", (state) => {
          if (recovering || halted) return;
          if (state.video.state === "connected") connectedOnce = true;
          setStatus(nextStatus(state, connectedOnce));
        });
        // The SDK's automatic sync writes every remote clipboard change to
        // the local clipboard while the page has focus, so guest code could
        // replace what the person pastes next. Copy only what follows their
        // own key press or click on the desktop while they hold control.
        // Pasting (local to remote) is the SDK's native paste handling.
        current.on("clipboard", ({ text, status: clipboard }) => {
          if (
            clipboard !== "Remote clipboard ready" ||
            !text ||
            current.state.input.state !== "active" ||
            Date.now() - input.current.lastGesture > CLIPBOARD_GESTURE_MS ||
            document.hidden ||
            !document.hasFocus()
          )
            return;
          navigator.clipboard?.writeText(text).catch(() => undefined);
        });
        current.attachSurface({
          canvas: display,
          inputElement: surface,
          controlOnFocus: true,
          clipboardAutoSync: false,
        });
        input.current.lastInput = Date.now();
        watchIdle(DESKTOP_IDLE_PAUSE_MS);
        current.connect();
      };
      void start();
      return () => {
        controller.abort();
        clearTimeout(idleTimer);
        void session?.dispose();
      };
    },
    [loadClient, onIdle, threadId],
  );
  const noteInput = () => {
    input.current.lastInput = Date.now();
  };
  const noteGesture = () => {
    const now = Date.now();
    input.current.lastInput = now;
    input.current.lastGesture = now;
  };
  return (
    <>
      <div
        className="thread-desktop-surface"
        ref={attach}
        role="application"
        aria-label="Remote desktop"
        aria-roledescription="remote desktop"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the remote desktop takes keyboard focus to receive input.
        tabIndex={0}
        // Double-click belongs to the remote desktop, not the SDK's
        // pointer-lock shortcut: stop it before it reaches the surface.
        onDoubleClickCapture={(event) => event.stopPropagation()}
        onPointerMoveCapture={noteInput}
        onWheelCapture={noteInput}
        onPointerDownCapture={noteGesture}
        onKeyDownCapture={noteGesture}
      >
        <canvas className="thread-desktop-canvas" ref={canvas} />
      </div>
      {status.phase === "starting" ? (
        <div
          className="thread-desktop-loading"
          role="status"
          aria-live="polite"
        >
          <Monitor className="workspace-loading-glyph" aria-hidden="true" />
          <span className="sr-only">Starting desktop…</span>
        </div>
      ) : null}
      {status.phase === "reconnecting" ? (
        <span className="thread-desktop-notice" role="status">
          Reconnecting…
        </span>
      ) : null}
      {status.phase === "live" && status.inputBusy ? (
        <span className="thread-desktop-notice" role="status">
          Another viewer has control
        </span>
      ) : null}
      {status.phase === "unsupported" ? (
        <div className="thread-desktop-state" role="status">
          <div className="thread-desktop-state-content">
            <Monitor className="thread-desktop-state-icon" aria-hidden="true" />
            <p>Desktop isn't available in this workspace.</p>
          </div>
        </div>
      ) : null}
      {status.phase === "failed" ? (
        <div className="thread-desktop-state" role="alert">
          <div className="thread-desktop-state-content">
            <Monitor className="thread-desktop-state-icon" aria-hidden="true" />
            <p>{status.message}</p>
            <button
              className="thread-desktop-retry"
              type="button"
              onClick={
                // A failed dynamic import stays failed for this page (and a
                // new deployment renames the chunk): reload to fetch it.
                status.reload ? () => window.location.reload() : onRetry
              }
            >
              <RefreshCw aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Ends one grace period after `DESKTOP_HIDDEN_GRACE_MS`. */
function HiddenGrace({
  generation,
  onExpire,
}: {
  readonly generation: number;
  readonly onExpire: (generation: number) => void;
}) {
  useMountEffect(() => {
    const timer = setTimeout(
      () => onExpire(generation),
      DESKTOP_HIDDEN_GRACE_MS,
    );
    return () => clearTimeout(timer);
  });
  return null;
}

export function DesktopViewer({
  active = true,
  threadId,
  loadClient = loadWaymote,
}: DesktopViewerProps) {
  const visible = React.useSyncExternalStore(
    subscribeVisibility,
    documentVisible,
    serverVisible,
  );
  const [attempt, setAttempt] = React.useState(0);
  const [pausedSession, setPausedSession] = React.useState<string>();
  const sessionKey = `${threadId}:${attempt}`;
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  const pause = React.useCallback(
    () => setPausedSession(sessionKey),
    [sessionKey],
  );
  const shown = active && visible;
  // Each time the Desktop leaves the screen starts a grace period; the
  // stream disconnects only once that period's timer runs out.
  const [previouslyShown, setPreviouslyShown] = React.useState(shown);
  const [hidden, setHidden] = React.useState(0);
  const [expired, setExpired] = React.useState(0);
  if (shown !== previouslyShown) {
    setPreviouslyShown(shown);
    if (!shown) setHidden((value) => value + 1);
  }
  const expire = React.useCallback(
    (generation: number) => setExpired(generation),
    [],
  );
  if (!shown && expired === hidden)
    return <div className="thread-desktop-shell" />;
  return (
    <div className="thread-desktop-shell">
      {shown ? null : (
        <HiddenGrace key={hidden} generation={hidden} onExpire={expire} />
      )}
      {pausedSession === sessionKey ? (
        <div className="thread-desktop-state" role="status">
          <div className="thread-desktop-state-content">
            <Monitor className="thread-desktop-state-icon" aria-hidden="true" />
            <p>Paused to let the workspace sleep.</p>
            <button
              className="thread-desktop-retry"
              type="button"
              onClick={retry}
            >
              <Play aria-hidden="true" />
              <span>Resume</span>
            </button>
          </div>
        </div>
      ) : (
        <DesktopSession
          key={sessionKey}
          threadId={threadId}
          loadClient={loadClient}
          onRetry={retry}
          onIdle={pause}
        />
      )}
    </div>
  );
}
