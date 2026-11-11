import type {
  DesktopApp,
  DesktopWindow,
  ThreadDesktopWindowsAction,
  ThreadDesktopWindowsData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Globe, LoaderCircle, SquareTerminal } from "lucide-react";
import type * as React from "react";
import { toast } from "sonner";
import {
  desktopWindowsActionMutation,
  desktopWindowsQueryOptions,
} from "./desktop-queries.js";
import "./desktop-apps.css";

// The Desktop has no panel of its own (deploy/orb/desktop: Xvfb and openbox),
// so a window closed or minimized there had no way back. This row lists the
// apps a person uses on it and every other open window: a click brings the
// app's window to the front, restoring it when minimized, or starts the app
// when it is closed.

const APPS = [
  { app: "terminal", label: "Terminal", Icon: SquareTerminal },
  { app: "browser", label: "Chromium", Icon: Globe },
] as const satisfies ReadonlyArray<{
  readonly app: DesktopApp;
  readonly label: string;
  readonly Icon: typeof Globe;
}>;

const actionKey = (action: ThreadDesktopWindowsAction) =>
  "app" in action ? `app:${action.app}` : `window:${String(action.window)}`;

/**
 * The row above a live desktop: hidden until the Orb lists its windows (an
 * Orb whose daemon predates the row never does). `onDone` runs after a
 * window comes forward, so typing goes on to it.
 */
export function DesktopAppRow({
  threadId,
  live,
  onDone,
}: {
  readonly threadId: ThreadId;
  readonly live: boolean;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery(desktopWindowsQueryOptions(threadId, live));
  const mutation = useMutation(
    desktopWindowsActionMutation(queryClient, threadId),
  );
  if (!live || query.data?.desktop !== "ready") return null;
  return (
    <DesktopApps
      data={query.data}
      pending={mutation.isPending ? mutation.variables : undefined}
      onAct={(action, label) => {
        mutation.mutateAsync(action).then(
          (data) => {
            if (data.desktop === "ready") onDone();
          },
          () => toast.error(`Couldn't open ${label}. Try again.`),
        );
      }}
    />
  );
}

const windowState = (windows: ReadonlyArray<DesktopWindow>) => {
  if (windows.length === 0) return "closed" as const;
  if (windows.some((window) => window.focused)) return "focused" as const;
  if (windows.every((window) => window.minimized)) return "minimized" as const;
  return "open" as const;
};

const appHint = (
  label: string,
  state: ReturnType<typeof windowState>,
  count: number,
) => {
  if (state === "closed") return `Open ${label}`;
  if (state === "minimized") return `Restore ${label}`;
  return count > 1
    ? `Show ${label} (${String(count)} windows)`
    : `Show ${label}`;
};

/** Keeps keyboard focus on the desktop when a button is pressed. */
const keepFocus = (event: React.PointerEvent | React.MouseEvent) =>
  event.preventDefault();

function DesktopApps({
  data,
  pending,
  onAct,
}: {
  readonly data: ThreadDesktopWindowsData;
  readonly pending: ThreadDesktopWindowsAction | undefined;
  readonly onAct: (action: ThreadDesktopWindowsAction, label: string) => void;
}) {
  const others = data.windows.filter((window) => window.app === undefined);
  const busy = pending === undefined ? undefined : actionKey(pending);
  return (
    <div
      className="desktop-apps"
      role="toolbar"
      aria-label="Desktop apps"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      {APPS.map(({ app, label, Icon }) => {
        const windows = data.windows.filter((window) => window.app === app);
        const state = windowState(windows);
        const hint = appHint(label, state, windows.length);
        const starting = busy === `app:${app}`;
        return (
          <button
            key={app}
            type="button"
            className="desktop-app"
            data-state={state}
            aria-label={hint}
            aria-pressed={state === "focused"}
            title={hint}
            disabled={busy !== undefined}
            onClick={() => onAct({ app }, label)}
          >
            {starting ? (
              <LoaderCircle
                className="desktop-app-spinner"
                aria-hidden="true"
              />
            ) : (
              <Icon aria-hidden="true" />
            )}
            <span>{label}</span>
            <span className="desktop-app-dot" aria-hidden="true" />
          </button>
        );
      })}
      {others.length > 0 ? (
        <span className="desktop-apps-divider" aria-hidden="true" />
      ) : null}
      {others.map((window) => {
        const title = window.title || "Untitled window";
        const state = window.focused
          ? "focused"
          : window.minimized
            ? "minimized"
            : "open";
        const hint = window.minimized ? `Restore ${title}` : `Show ${title}`;
        return (
          <button
            key={window.id}
            type="button"
            className="desktop-app desktop-app-window"
            data-state={state}
            aria-label={hint}
            aria-pressed={window.focused}
            title={hint}
            disabled={busy !== undefined}
            onClick={() => onAct({ window: window.id }, title)}
          >
            {busy === `window:${String(window.id)}` ? (
              <LoaderCircle
                className="desktop-app-spinner"
                aria-hidden="true"
              />
            ) : (
              <AppWindow aria-hidden="true" />
            )}
            <span>{title}</span>
          </button>
        );
      })}
    </div>
  );
}
