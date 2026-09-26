import {
  THREAD_TERMINAL_SUBPROTOCOL,
  type ThreadTerminalErrorCode,
  type ThreadTerminalServerControl,
  ThreadTerminalServerControlSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { RefreshCw, SquareTerminal } from "lucide-react";
import * as React from "react";
import { wakingExecutionEnvironmentMessage } from "../../shared/execution-environment-copy.js";
import { useTheme } from "../../shared/theme/theme-provider.js";
import { terminalThemeFor } from "./terminal-themes.js";

const terminalUrl = (threadId: ThreadId) => {
  const url = new URL(`/v1/threads/${threadId}/terminal`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
};

const terminalDimension = (value: number) =>
  Math.min(1_000, Math.max(1, Math.round(value)));

const reconnectDelays = [250, 1_000, 2_500] as const;
const terminalHeartbeatTimeoutMs = 5_000;

const decodeControl = (data: unknown) => {
  if (typeof data !== "string") return Option.none();
  try {
    return Schema.decodeUnknownOption(ThreadTerminalServerControlSchema)(
      JSON.parse(data),
      { onExcessProperty: "error" },
    );
  } catch {
    return Option.none();
  }
};

const errorMessage = (code: ThreadTerminalErrorCode) => {
  switch (code) {
    case "invalid-message":
      return "Terminal protocol was rejected.";
    case "attachment-limit":
      return "Terminal already has eight open views.";
    case "input-overflow":
      return "Terminal input exceeded capacity.";
    case "slow-consumer":
      return "Terminal output exceeded browser capacity.";
    case "resident-unavailable":
      return "Terminal is temporarily unavailable.";
    case "environment-unavailable":
      return "Terminal environment is unavailable.";
    case "protocol-incompatible":
      return "Terminal protocol is incompatible.";
    case "reconnect-required":
      return "Terminal disconnected.";
    case "workspace-paused":
      return "Terminal workspace is paused.";
    case "thread-archived":
      return "Terminal Thread is archived.";
    case "thread-deleted":
      return "Terminal Thread no longer exists.";
    case "workspace-lost":
      return "Terminal workspace no longer exists.";
    case "terminal-exited":
      return "Terminal exited.";
    case "terminal-overflow":
      return "Terminal output exceeded capacity.";
  }
};

const disconnected: ThreadTerminalServerControl = {
  v: 1,
  type: "error",
  code: "reconnect-required",
  retry: "manual",
};

const terminalPresentation = (status: ThreadTerminalServerControl) => {
  if (status.type === "progress") {
    if (status.phase === "waking")
      return { message: "Waking terminal…", action: undefined };
    if (status.phase === "replaying")
      return { message: "Restoring terminal…", action: undefined };
    return { message: "Starting terminal…", action: undefined };
  }
  if (
    status.type === "ready" ||
    status.type === "dimensions" ||
    status.type === "heartbeat"
  )
    return { message: "Terminal ready", action: undefined };
  if (status.type === "replay-start")
    return { message: "Restoring terminal…", action: undefined };
  if (status.type === "restart-required")
    return { message: "Terminal ready", action: undefined };
  return {
    message: errorMessage(status.code),
    action:
      status.retry === "manual" || status.retry === "immediate-once"
        ? status.code === "terminal-exited"
          ? "Open terminal"
          : "Retry terminal"
        : undefined,
  };
};

const terminalLoading = (status: ThreadTerminalServerControl) =>
  status.type === "progress" ||
  status.type === "replay-start" ||
  (status.type === "error" && status.retry === "on-focus");

function TerminalStatus({
  status,
  restartRequired,
  retry,
}: {
  readonly status: ThreadTerminalServerControl;
  readonly restartRequired: boolean;
  readonly retry: (restart: boolean) => void;
}) {
  const presentation = terminalPresentation(status);
  const loading = terminalLoading(status);
  const failed = status.type === "error" && status.retry !== "on-focus";
  return (
    <>
      {loading ? (
        <div
          className="thread-terminal-loading"
          role="status"
          aria-live="polite"
        >
          <SquareTerminal
            className="workspace-loading-glyph"
            aria-hidden="true"
          />
          <span className="sr-only">{presentation.message}</span>
        </div>
      ) : (
        <span className="sr-only" role="status" aria-live="polite">
          {presentation.message}
        </span>
      )}
      {!failed && !loading && restartRequired ? (
        <span className="thread-terminal-environment-notice" role="status">
          Environment changed. Use the Terminal tab menu to refresh and restart.
        </span>
      ) : null}
      {failed ? (
        <div className="thread-terminal-state">
          <div className="thread-terminal-state-content">
            <SquareTerminal
              className="thread-terminal-state-icon"
              aria-hidden="true"
            />
            <p>{presentation.message}</p>
            {presentation.action === undefined ? null : (
              <button
                className="thread-terminal-retry"
                type="button"
                onClick={() => retry(status !== disconnected)}
              >
                <RefreshCw aria-hidden="true" />
                <span>{presentation.action}</span>
              </button>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

const loadBrowserTerminal = () => import("./ghostty-browser-emulator.js");

interface ThreadTerminalProps {
  readonly active?: boolean;
  readonly threadId: ThreadId;
  readonly loadEmulator?: typeof loadBrowserTerminal;
  readonly onWorkspaceStatusChange?: (status?: string) => void;
}

interface ThreadTerminalSessionProps extends ThreadTerminalProps {
  readonly terminalTheme: ReturnType<typeof terminalThemeFor>;
}

const useTerminalConnection = ({
  threadId,
  loadEmulator = loadBrowserTerminal,
  onWorkspaceStatusChange,
  terminalTheme,
}: ThreadTerminalSessionProps) => {
  const [status, setStatus] = React.useState<ThreadTerminalServerControl>({
    v: 1,
    type: "progress",
    phase: "starting",
  });
  const [attempt, setAttempt] = React.useState(0);
  const [restartRequired, setRestartRequired] = React.useState(false);
  const nextRestartResident = React.useRef(false);
  const refreshEnvironment = React.useRef<() => void>(() => {});
  const immediateReconnectAvailable = React.useRef(true);
  const automaticReconnectAttempt = React.useRef(0);
  const recoverDisconnected = React.useRef<() => void>(() => {});
  const setActivity = React.useRef<(active: boolean) => void>(() => {});
  const activeRef = React.useRef(false);
  const mount = React.useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return;
      const abort = new AbortController();
      let dispose = () => {};
      let ready = false;
      void loadEmulator().then(
        async ({ mountBrowserTerminal }) => {
          if (abort.signal.aborted) return;
          const socket = new WebSocket(
            terminalUrl(threadId),
            THREAD_TERMINAL_SUBPROTOCOL,
          );
          socket.binaryType = "arraybuffer";
          const sendEnvironmentRefresh = () => {
            if (ready && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ v: 1, type: "restart" }));
          };
          refreshEnvironment.current = sendEnvironmentRefresh;
          const listeners = new AbortController();
          let emulator:
            | Awaited<ReturnType<typeof mountBrowserTerminal>>
            | undefined;
          let socketOpened = false;
          let attachSent = false;
          let safeCloseAnnounced = false;
          let unavailableObserved = false;
          let workspaceWakeActive = false;
          let applyingDimensions = false;
          let reconnecting = false;
          let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
          let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
          const browserPresent = () =>
            activeRef.current &&
            document.visibilityState === "visible" &&
            navigator.onLine;
          const clearHeartbeat = () => {
            if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
          };
          const reconnect = () => {
            if (
              abort.signal.aborted ||
              !unavailableObserved ||
              reconnecting ||
              !browserPresent() ||
              automaticReconnectAttempt.current >= reconnectDelays.length
            )
              return;
            reconnecting = true;
            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
            automaticReconnectAttempt.current += 1;
            nextRestartResident.current = false;
            setStatus({ v: 1, type: "progress", phase: "waking" });
            setAttempt((value) => value + 1);
          };
          const startReconnect = () => {
            if (unavailableObserved) return;
            unavailableObserved = true;
            ready = false;
            clearHeartbeat();
            setStatus(disconnected);
            const delay = reconnectDelays[automaticReconnectAttempt.current];
            if (delay !== undefined && browserPresent())
              reconnectTimer = setTimeout(reconnect, delay);
          };
          const expectHeartbeat = () => {
            clearHeartbeat();
            if (!ready || !browserPresent()) return;
            heartbeatTimer = setTimeout(
              startReconnect,
              terminalHeartbeatTimeoutMs,
            );
          };
          const resumeOnUserPresence = () => {
            if (!browserPresent()) {
              clearHeartbeat();
              return;
            }
            if (unavailableObserved) reconnect();
            else expectHeartbeat();
          };
          recoverDisconnected.current = resumeOnUserPresence;
          const updateActivity = (active: boolean) => {
            if (!active) {
              clearHeartbeat();
              return;
            }
            resumeOnUserPresence();
          };
          setActivity.current = updateActivity;
          document.addEventListener("visibilitychange", resumeOnUserPresence, {
            signal: listeners.signal,
          });
          window.addEventListener("focus", resumeOnUserPresence, {
            signal: listeners.signal,
          });
          window.addEventListener("online", resumeOnUserPresence, {
            signal: listeners.signal,
          });
          const sendAttach = () => {
            if (emulator === undefined || attachSent) return;
            attachSent = true;
            const restartResident = nextRestartResident.current;
            nextRestartResident.current = false;
            socket.send(
              JSON.stringify({
                v: 1,
                type: "attach",
                terminal: "default",
                dimensions: {
                  columns: terminalDimension(emulator.terminal.cols),
                  rows: terminalDimension(emulator.terminal.rows),
                },
                ...(restartResident ? { restartResident: true } : {}),
              }),
            );
          };
          socket.addEventListener(
            "open",
            () => {
              socketOpened = true;
              sendAttach();
            },
            { signal: listeners.signal },
          );
          emulator = await mountBrowserTerminal(
            element,
            (data) => {
              if (ready && socket.readyState === WebSocket.OPEN)
                socket.send(new TextEncoder().encode(data));
            },
            terminalTheme,
          ).catch(() => {
            listeners.abort();
            socket.close();
            return undefined;
          });
          if (emulator === undefined) return;
          if (socketOpened || socket.readyState === WebSocket.OPEN)
            sendAttach();
          const resize = emulator.terminal.onResize(({ cols, rows }) => {
            if (
              !applyingDimensions &&
              attachSent &&
              socket.readyState === WebSocket.OPEN
            )
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "resize",
                  dimensions: {
                    columns: terminalDimension(cols),
                    rows: terminalDimension(rows),
                  },
                }),
              );
          });
          socket.addEventListener(
            "message",
            (event) => {
              if (event.data instanceof ArrayBuffer) {
                emulator.terminal.write(new Uint8Array(event.data));
                return;
              }
              const decoded = decodeControl(event.data);
              if (Option.isNone(decoded)) return;
              const control = decoded.value;
              if (control.type === "heartbeat") {
                if (ready) expectHeartbeat();
                return;
              }
              if (
                ready &&
                control.type === "progress" &&
                control.phase === "resident-restarting"
              ) {
                startReconnect();
                return;
              }
              if (control.type === "progress" && control.phase === "waking") {
                workspaceWakeActive = true;
                onWorkspaceStatusChange?.(wakingExecutionEnvironmentMessage);
              } else if (control.type === "ready" || control.type === "error") {
                workspaceWakeActive = false;
                onWorkspaceStatusChange?.(undefined);
              }
              if (control.type === "replay-start") {
                ready = false;
                emulator.terminal.reset();
              } else if (control.type === "ready") {
                ready = true;
                expectHeartbeat();
                setRestartRequired(control.restartRequired);
                immediateReconnectAvailable.current = true;
                automaticReconnectAttempt.current = 0;
              } else if (control.type === "progress") ready = false;
              else if (control.type === "restart-required")
                setRestartRequired(true);
              else if (control.type === "error") {
                ready = false;
                safeCloseAnnounced = true;
                if (
                  control.retry === "on-focus" &&
                  document.hasFocus() &&
                  element.contains(document.activeElement)
                ) {
                  nextRestartResident.current = false;
                  setAttempt((value) => value + 1);
                } else if (
                  control.retry === "immediate-once" &&
                  document.visibilityState === "visible" &&
                  immediateReconnectAvailable.current
                ) {
                  immediateReconnectAvailable.current = false;
                  nextRestartResident.current = false;
                  setAttempt((value) => value + 1);
                }
              }
              if (control.type === "ready" || control.type === "dimensions") {
                applyingDimensions = true;
                emulator.terminal.resize(
                  control.dimensions.columns,
                  control.dimensions.rows,
                );
                applyingDimensions = false;
              }
              setStatus(control);
            },
            { signal: listeners.signal },
          );
          const clearWorkspaceWake = () => {
            if (!workspaceWakeActive) return;
            workspaceWakeActive = false;
            onWorkspaceStatusChange?.(undefined);
          };
          const unavailable = () => {
            if (abort.signal.aborted || safeCloseAnnounced) return;
            clearWorkspaceWake();
            startReconnect();
          };
          socket.addEventListener("close", unavailable, {
            signal: listeners.signal,
          });
          socket.addEventListener("error", unavailable, {
            signal: listeners.signal,
          });
          dispose = () => {
            listeners.abort();
            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
            clearHeartbeat();
            clearWorkspaceWake();
            resize.dispose();
            emulator.dispose();
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ v: 1, type: "detach" }));
            socket.close();
            if (refreshEnvironment.current === sendEnvironmentRefresh)
              refreshEnvironment.current = () => {};
            if (recoverDisconnected.current === resumeOnUserPresence)
              recoverDisconnected.current = () => {};
            if (setActivity.current === updateActivity)
              setActivity.current = () => {};
          };
          if (abort.signal.aborted) dispose();
        },
        () => {},
      );
      return () => {
        abort.abort();
        dispose();
      };
    },
    [loadEmulator, onWorkspaceStatusChange, terminalTheme, threadId],
  );
  const retry = (restart = true) => {
    nextRestartResident.current = restart;
    setStatus({ v: 1, type: "progress", phase: "waking" });
    setAttempt((value) => value + 1);
  };
  return {
    activeRef,
    attempt,
    mount,
    recoverDisconnected,
    refreshEnvironment,
    restartRequired,
    retry,
    setActivity,
    status,
  };
};

function ThreadTerminalSession(props: ThreadTerminalSessionProps) {
  const {
    activeRef,
    attempt,
    mount,
    recoverDisconnected,
    refreshEnvironment,
    restartRequired,
    retry,
    setActivity,
    status,
  } = useTerminalConnection(props);
  const active = props.active ?? true;
  const recoverOnActivation = React.useCallback(
    (element: HTMLSpanElement | null) => {
      activeRef.current = element !== null;
      setActivity.current(element !== null);
      if (element !== null) recoverDisconnected.current();
    },
    [activeRef, recoverDisconnected, setActivity],
  );
  const wakeOnFocus = () => {
    if (status === disconnected) recoverDisconnected.current();
    else if (
      status.type === "error" &&
      (status.retry === "on-focus" || status.retry === "after-unarchive")
    )
      retry(false);
  };
  const loading = terminalLoading(status);
  const failed = status.type === "error" && status.retry !== "on-focus";
  return (
    <form
      id="thread-terminal-environment"
      className="thread-terminal-shell"
      onSubmit={(event) => {
        event.preventDefault();
        if (loading || failed) return;
        if (
          window.confirm(
            restartRequired
              ? "Refresh and restart Terminal? Restarting ends the shared shell and any running command or process in every open Terminal view."
              : "Refresh Terminal environment? If values changed, dx restarts the shared shell and ends any running command or process in every open Terminal view.",
          )
        )
          refreshEnvironment.current();
      }}
      onFocusCapture={wakeOnFocus}
      onPointerDown={(event) => {
        if (status === disconnected) recoverDisconnected.current();
        else if (
          status.type === "error" &&
          (status.retry === "on-focus" || status.retry === "after-unarchive")
        )
          event.currentTarget.focus();
      }}
      tabIndex={-1}
    >
      {active ? <span hidden ref={recoverOnActivation} /> : null}
      <div className="thread-terminal-viewport">
        <div className="thread-terminal" key={attempt} ref={mount} />
      </div>
      <TerminalStatus
        status={status}
        restartRequired={restartRequired}
        retry={retry}
      />
    </form>
  );
}

export function ThreadTerminal(props: ThreadTerminalProps) {
  const { resolvedAppearance, terminalTheme } = useTheme();
  return (
    <ThreadTerminalSession
      key={`${terminalTheme}:${resolvedAppearance}`}
      {...props}
      terminalTheme={terminalThemeFor(terminalTheme, resolvedAppearance)}
    />
  );
}
