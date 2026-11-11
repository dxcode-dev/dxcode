// The Desktop's windows inside the Thread execution Durable Object, for the
// viewer's app row. dxd reads them from the Desktop's window manager; this
// object relays a listing, an open, or a focus to a live daemon only, so the
// row never wakes a paused workspace.
//
// Contract (Thread execution object), after Thread authorization:
//   GET  https://thread-execution/desktop/windows   list
//   POST https://thread-execution/desktop/windows   {"app": ...} | {"window": n}
// with x-dx-thread-id. Both answer 200 with `ThreadDesktopWindowsData` JSON.

import {
  ThreadDesktopWindowsActionSchema,
  type ThreadDesktopWindowsData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import {
  DxdDesktopWindowsResult,
  type DxdOperation,
} from "../execution/dxd/protocol.js";

/** A listing or a focus answers within a few X11 round trips. */
const WINDOWS_TIMEOUT_MS = 5_000;
/**
 * Starting an app waits for its first window (dxd gives Chromium 12 s on a
 * cold Orb), plus the relay.
 */
const OPEN_TIMEOUT_MS = 20_000;

export interface DesktopWindowsDaemon {
  /** The Thread this object's daemon serves, if it ever activated. */
  readonly threadId: string | undefined;
  /** A live, heartbeating daemon: nothing here may wake the workspace. */
  readonly running: boolean;
  /** The daemon registered the `desktop` capability. */
  readonly desktop: boolean;
  readonly dispatch: (
    operation: DxdOperation,
    timeoutMs: number,
  ) => Promise<Response>;
}

const UNAVAILABLE: ThreadDesktopWindowsData = {
  desktop: "unavailable",
  windows: [],
};

const relay = (data: ThreadDesktopWindowsData) =>
  Response.json(data, { headers: { "cache-control": "no-store" } });

/** Serves `/desktop/windows` for an authorized caller. */
export const serveDesktopWindows = async (
  request: Request,
  threadId: ThreadId,
  daemon: DesktopWindowsDaemon,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405 });
  let operation: DxdOperation = { operation: "desktop.windows" };
  if (request.method === "POST") {
    const action = Schema.decodeUnknownOption(ThreadDesktopWindowsActionSchema)(
      await request.json().catch(() => undefined),
      {
        onExcessProperty: "error",
      },
    );
    if (Option.isNone(action)) return new Response(null, { status: 400 });
    operation =
      "app" in action.value
        ? { operation: "desktop.open", app: action.value.app }
        : { operation: "desktop.focus", window: action.value.window };
  }
  if (daemon.threadId !== threadId || !daemon.running || !daemon.desktop)
    return relay(UNAVAILABLE);
  const response = await daemon.dispatch(
    operation,
    operation.operation === "desktop.open"
      ? OPEN_TIMEOUT_MS
      : WINDOWS_TIMEOUT_MS,
  );
  if (!response.ok) return relay(UNAVAILABLE);
  const result = Schema.decodeUnknownOption(DxdDesktopWindowsResult)(
    await response.json().catch(() => undefined),
    { onExcessProperty: "error" },
  );
  if (Option.isNone(result)) return relay(UNAVAILABLE);
  if (result.value.kind === "unavailable")
    return relay({
      desktop:
        result.value.reason === "unsupported" ? "unsupported" : "unavailable",
      windows: [],
    });
  return relay({ desktop: "ready", windows: result.value.windows });
};
