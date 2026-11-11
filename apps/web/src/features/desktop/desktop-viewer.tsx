import type { ThreadId } from "@dx/domain";
import { useQueryClient } from "@tanstack/react-query";
import { Monitor, Play, RefreshCw } from "lucide-react";
import * as React from "react";
import {
  isSessionEndedClose,
  reportSessionEnded,
} from "../../shared/auth/session-ended.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { useMobile } from "../../shared/use-mobile.js";
import { DesktopAppRow } from "./desktop-apps.js";
import { followPaneSize, writeLocalClipboard } from "./desktop-display.js";
import {
  codeForCharacter,
  type DesktopModifier,
  pressChord,
} from "./desktop-keyboard.js";
import { DesktopKeys } from "./desktop-keys.js";
import {
  desktopPath,
  desktopWindowInputHandlers,
  refreshDesktopWindowsAfterStart,
  checkDesktop as requestDesktop,
} from "./desktop-queries.js";
import type { VoxlConnection, VoxlSession } from "./voxl/session.js";

// The Thread's Linux desktop, streamed by voxl from the sandbox. The browser
// reaches it only through dx Core's authenticated Thread routes: a status
// check that starts the desktop, then one WebSocket that Core relays to
// voxl on the sandbox's loopback (deploy/orb/README.md#desktop).

const loadVoxl = () => import("./voxl/session.js");

const desktopSocketUrl = (threadId: ThreadId) =>
  `${window.location.origin.replace(/^http/, "ws")}${desktopPath(threadId)}/ws`;

/**
 * Without input on the desktop for this long, the viewer disconnects. The
 * viewer acknowledges every frame and answers voxl's pings, and Core counts
 * every browser message as workspace activity, so a forgotten Desktop tab
 * would keep the sandbox awake forever. Five minutes, plus the workspace's own five-minute
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
 * voxl sends a new viewer a full picture at once, so a stream open this long
 * with nothing drawn is stuck: reconnect it to get the picture again.
 */
const DESKTOP_PICTURE_WAIT_MS = 5_000;
/** Stream reconnects without a picture before the viewer gives up. */
const BLANK_STREAM_LIMIT = 3;
/**
 * The remote clipboard reaches the local one only this soon after a key
 * press or click on the desktop by the person holding control, so guest
 * code cannot replace the local clipboard on its own.
 */
const CLIPBOARD_GESTURE_MS = 2_000;
/**
 * Kept in the text input so a phone keyboard's Backspace always has
 * something to delete, and so always reports it.
 */
const TEXT_INPUT_SENTINEL = " ";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const documentVisible = () => document.visibilityState === "visible";
const serverVisible = () => false;

type DesktopStatus =
  | { readonly phase: "starting" }
  | { readonly phase: "live" }
  | { readonly phase: "reconnecting" }
  | { readonly phase: "unsupported" }
  | {
      readonly phase: "failed";
      readonly message: string;
      /** The viewer's code failed to load: only a page reload fetches it. */
      readonly reload?: boolean;
    };

// The desktop is live only once a picture is drawn. Until then the starting
// cover hides the black canvas and keeps clicks off the unseen remote screen.
// After that, the last picture stays on the canvas while the stream
// reconnects.
const nextStatus = (
  connection: VoxlConnection,
  drawn: boolean,
): DesktopStatus => {
  if (!drawn) return { phase: "starting" };
  return connection === "open" ? { phase: "live" } : { phase: "reconnecting" };
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
  readonly loadClient?: typeof loadVoxl;
  /** Reloads the page, the only way to fetch a viewer chunk that failed. */
  readonly reloadPage?: () => void;
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
  reloadPage,
  onRetry,
  onIdle,
}: {
  readonly threadId: ThreadId;
  readonly loadClient: typeof loadVoxl;
  readonly reloadPage: () => void;
  readonly onRetry: () => void;
  readonly onIdle: () => void;
}) {
  const [status, setStatus] = React.useState<DesktopStatus>({
    phase: "starting",
  });
  const queryClient = useQueryClient();
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const inputRef = React.useRef<DesktopInput>({
    lastInput: Date.now(),
    lastGesture: Number.NEGATIVE_INFINITY,
  });
  const {
    remoteRef,
    textInputRef,
    open: keyboardOpen,
    modifiers,
    attachTextInput,
    press,
    toggle: toggleKeyboard,
    toggleModifier,
    onTextInputFocus,
    onTextInputBlur,
  } = usePhoneKeyboard(inputRef);
  const attach = (surface: HTMLDivElement | null) => {
    const display = canvas.current;
    if (surface === null || display === null) return;
    const controller = new AbortController();
    const disposed = () => controller.signal.aborted;
    let session: VoxlSession | undefined;
    let stopFollowing: (() => void) | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let pictureTimer: ReturnType<typeof setTimeout> | undefined;
    // Set once the viewer gives up; the session's own states no longer show.
    let halted = false;
    const stop = (next: DesktopStatus) => {
      if (disposed()) return;
      halted = true;
      clearTimeout(idleTimer);
      clearTimeout(pictureTimer);
      session?.disconnect();
      setStatus(next);
    };
    // Unmounting (the paused state replaces this session) disposes it.
    const watchIdle = (delay: number) => {
      idleTimer = setTimeout(() => {
        const idle = Date.now() - inputRef.current.lastInput;
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
      const voxl = await client;
      if (disposed()) return;
      if (voxl === undefined) {
        setStatus({
          phase: "failed",
          message: "Desktop viewer failed to load.",
          reload: true,
        });
        return;
      }

      // Core answers a refused upgrade (desktop or workspace unavailable)
      // with an error status, which the session sees as a dropped socket and
      // retries forever. Count sockets that never open; after a run of
      // them, ask Core again and stop unless the desktop is ready.
      let failures = 0;
      let recoveries = 0;
      let recovering = false;
      // Whether this session has drawn a picture, and stream sockets in a
      // row that opened and drew nothing.
      let drawn = false;
      let blankStreams = 0;
      let watchedStream: WebSocket | undefined;
      const awaitPicture = (stream: WebSocket) => {
        clearTimeout(pictureTimer);
        watchedStream = stream;
        pictureTimer = setTimeout(() => {
          if (watchedStream !== stream) return;
          // voxl sends no video to a hidden page: wait until it shows.
          if (document.hidden) return;
          blankStreams += 1;
          if (blankStreams > BLANK_STREAM_LIMIT)
            return stop({
              phase: "failed",
              message: "The desktop isn't sending a picture.",
            });
          // The relay may take long to finish the close handshake;
          // reconnecting the session opens a new socket at once.
          session?.disconnect();
          session?.connect();
        }, DESKTOP_PICTURE_WAIT_MS);
      };
      // The wait for a first picture starts over when the page shows again.
      const onVisible = () => {
        if (!document.hidden && watchedStream !== undefined)
          awaitPicture(watchedStream);
      };
      document.addEventListener("visibilitychange", onVisible);
      controller.signal.addEventListener("abort", () =>
        document.removeEventListener("visibilitychange", onVisible),
      );
      const recover = async () => {
        recovering = true;
        session?.disconnect();
        setStatus(drawn ? { phase: "reconnecting" } : { phase: "starting" });
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
      const openSocket = () => {
        const socket = new WebSocket(desktopSocketUrl(threadId));
        let openedAt: number | undefined;
        socket.addEventListener("open", () => {
          openedAt = Date.now();
          failures = 0;
          awaitPicture(socket);
        });
        socket.addEventListener("close", (event) => {
          if (socket === watchedStream) {
            clearTimeout(pictureTimer);
            watchedStream = undefined;
          }
          if (disposed() || recovering) return;
          if (isSessionEndedClose(event.code)) {
            session?.disconnect();
            reportSessionEnded();
            return;
          }
          if (openedAt !== undefined) {
            if (Date.now() - openedAt >= STABLE_SOCKET_MS) recoveries = 0;
            return;
          }
          failures += 1;
          if (failures >= SOCKET_FAILURE_LIMIT) void recover();
        });
        return socket;
      };

      let connection: VoxlConnection = "connecting";
      const current = new voxl.VoxlSession({
        canvas: display,
        surface,
        textInput: textInputRef.current ?? undefined,
        textInputRest: TEXT_INPUT_SENTINEL,
        createWebSocket: openSocket,
        onConnection: (state) => {
          connection = state;
          if (recovering || halted) return;
          setStatus(nextStatus(connection, drawn));
        },
        onPicture: () => {
          clearTimeout(pictureTimer);
          watchedStream = undefined;
          blankStreams = 0;
          if (drawn || recovering || halted) return;
          drawn = true;
          refreshDesktopWindowsAfterStart(queryClient, threadId);
          setStatus(nextStatus(connection, drawn));
        },
        // Guest code can change the remote clipboard at any time; copying
        // every change would let it replace what the person pastes next.
        // Copy only what follows their own key press or click on the
        // desktop while they hold control. Pasting (local to remote) is the
        // session's paste handling.
        onClipboard: (content) => {
          if (
            !current.controlled ||
            Date.now() - inputRef.current.lastGesture > CLIPBOARD_GESTURE_MS ||
            document.hidden ||
            !document.hasFocus()
          )
            return;
          writeLocalClipboard(content);
        },
      });
      session = current;
      stopFollowing = followPaneSize(surface, (w, h) => current.resize(w, h));
      remoteRef.current = current;
      inputRef.current.lastInput = Date.now();
      watchIdle(DESKTOP_IDLE_PAUSE_MS);
      current.connect();
    };
    void start();
    return () => {
      controller.abort();
      clearTimeout(idleTimer);
      clearTimeout(pictureTimer);
      stopFollowing?.();
      remoteRef.current = undefined;
      session?.dispose();
    };
  };
  const noteInput = () => {
    inputRef.current.lastInput = Date.now();
  };
  const noteGesture = () => {
    const now = Date.now();
    inputRef.current.lastInput = now;
    inputRef.current.lastGesture = now;
  };
  const mobile = useMobile();
  const windowInput = desktopWindowInputHandlers(queryClient, threadId);
  return (
    <>
      <DesktopAppRow
        threadId={threadId}
        live={status.phase === "live" || status.phase === "reconnecting"}
        onDone={() => remoteRef.current?.focus()}
      />
      {/* Before the surface, so it exists when the surface attaches. */}
      <textarea
        ref={attachTextInput}
        className="thread-desktop-text-input"
        aria-label="Type on the remote desktop"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={-1}
        onFocus={onTextInputFocus}
        onBlur={onTextInputBlur}
      />
      <div
        className="thread-desktop-surface"
        ref={attach}
        role="application"
        aria-label="Remote desktop"
        aria-roledescription="remote desktop"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the remote desktop takes keyboard focus to receive input.
        tabIndex={0}
        onPointerMoveCapture={noteInput}
        onWheelCapture={noteInput}
        onPointerDownCapture={noteGesture}
        onKeyDownCapture={noteGesture}
        {...windowInput}
      >
        <canvas className="thread-desktop-canvas" ref={canvas} />
      </div>
      {mobile &&
      (status.phase === "starting" ||
        status.phase === "live" ||
        status.phase === "reconnecting") ? (
        <DesktopKeys
          disabled={status.phase !== "live"}
          keyboardOpen={keyboardOpen}
          modifiers={modifiers}
          onToggleKeyboard={toggleKeyboard}
          onToggleModifier={toggleModifier}
          onPress={press}
        />
      ) : null}
      <DesktopStatusLayer
        status={status}
        onRetry={onRetry}
        reloadPage={reloadPage}
      />
    </>
  );
}

/** The cover, notice, or message that shows the viewer's status. */
function DesktopStatusLayer({
  status,
  onRetry,
  reloadPage,
}: {
  readonly status: DesktopStatus;
  readonly onRetry: () => void;
  readonly reloadPage: () => void;
}) {
  return (
    <>
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
                status.reload ? reloadPage : onRetry
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

/**
 * Typing on the desktop from a phone: the phone keyboard writes into the
 * session's text input, and on-screen keys press what a phone keyboard
 * lacks. A latched modifier applies to the next key from either.
 */
function usePhoneKeyboard(inputRef: React.RefObject<DesktopInput>) {
  const textInput = React.useRef<HTMLTextAreaElement | null>(null);
  const remote = React.useRef<VoxlSession | undefined>(undefined);
  const [open, setOpen] = React.useState(false);
  const [modifiers, setModifiers] = React.useState<
    ReadonlySet<DesktopModifier>
  >(() => new Set());
  // Read by the text input's listeners, which outlive a render.
  const latched = React.useRef<ReadonlySet<DesktopModifier>>(modifiers);
  const latch = (next: ReadonlySet<DesktopModifier>) => {
    latched.current = next;
    setModifiers(next);
  };
  // Keys reach the desktop only while this viewer holds control, which
  // focusing the surface takes.
  const withControl = (send: () => void) => {
    const session = remote.current;
    if (session === undefined) return;
    if (!session.controlled) session.focus();
    send();
  };
  const press = (codes: readonly string[]) => {
    const chord = [
      ...latched.current,
      ...codes.filter((code) => !latched.current.has(code as DesktopModifier)),
    ];
    if (latched.current.size > 0) latch(new Set());
    const now = Date.now();
    inputRef.current.lastInput = now;
    inputRef.current.lastGesture = now;
    withControl(() => {
      if (textInput.current !== null) pressChord(textInput.current, chord);
    });
  };
  const attachTextInput = (node: HTMLTextAreaElement | null) => {
    textInput.current = node;
    if (node === null) return;
    // A phone keyboard reports Backspace and Return without a key code;
    // press the real keys instead.
    const softKey = (event: KeyboardEvent) => {
      if (event.code !== "" || event.isComposing) return;
      if (event.key !== "Backspace" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      press([event.key]);
    };
    const beforeInput = (event: InputEvent) => {
      let codes: readonly string[] | undefined;
      if (event.inputType === "deleteContentBackward") codes = ["Backspace"];
      else if (
        event.inputType === "insertLineBreak" ||
        event.inputType === "insertParagraph"
      )
        codes = ["Enter"];
      else if (
        event.inputType === "insertText" &&
        latched.current.size > 0 &&
        event.data?.length === 1
      ) {
        const key = codeForCharacter(event.data);
        if (key !== undefined)
          codes = key.shift ? ["ShiftLeft", key.code] : [key.code];
      }
      if (codes === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      press(codes);
    };
    return listenAll(node, [
      ["keydown", softKey],
      ["beforeinput", beforeInput],
    ]);
  };
  return {
    textInputRef: textInput,
    remoteRef: remote,
    open,
    modifiers,
    attachTextInput,
    press,
    toggle: () => {
      if (open) textInput.current?.blur();
      else remote.current?.focusTextInput();
    },
    toggleModifier: (modifier: DesktopModifier) => {
      const next = new Set(latched.current);
      if (!next.delete(modifier)) next.add(modifier);
      latch(next);
    },
    onTextInputFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => {
      event.currentTarget.value = TEXT_INPUT_SENTINEL;
      setOpen(true);
    },
    onTextInputBlur: () => setOpen(false),
  };
}

/** Listens to each event until the returned function is called. */
const listenAll = (
  target: HTMLElement,
  listeners: ReadonlyArray<
    | readonly ["keydown", (event: KeyboardEvent) => void]
    | readonly ["beforeinput", (event: InputEvent) => void]
  >,
) => {
  for (const [type, listener] of listeners)
    target.addEventListener(type, listener as EventListener);
  return () => {
    for (const [type, listener] of listeners)
      target.removeEventListener(type, listener as EventListener);
  };
};

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

const reloadWindow = () => window.location.reload();

export function DesktopViewer({
  active = true,
  threadId,
  loadClient = loadVoxl,
  reloadPage = reloadWindow,
}: DesktopViewerProps) {
  const visible = React.useSyncExternalStore(
    subscribeVisibility,
    documentVisible,
    serverVisible,
  );
  const [attempt, setAttempt] = React.useState(0);
  const [pausedSession, setPausedSession] = React.useState<string>();
  const sessionKey = `${threadId}:${attempt}`;
  const retry = () => setAttempt((value) => value + 1);
  const pause = () => setPausedSession(sessionKey);
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
  const expire = (generation: number) => setExpired(generation);
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
          reloadPage={reloadPage}
          onRetry={retry}
          onIdle={pause}
        />
      )}
    </div>
  );
}
