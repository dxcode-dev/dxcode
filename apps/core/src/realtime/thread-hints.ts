import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { realtimeLogger } from "../logging.js";
import {
  AUDIENCE_HEADER,
  CLIENT_HEADER,
  homeAudienceForUser,
  PARTICIPANT_HEADER,
} from "./publication.js";

const READY_TIMEOUT_MS = 5_000;

export type ThreadHintWake = "hint" | "timeout" | "closed";

/**
 * One owner's `thread.invalidated` hints for some of their Threads, read from
 * the Realtime Hub as a browser would. A hint only says a Thread's row
 * changed; callers read D1 after every wake.
 */
export interface ThreadHintListener {
  /**
   * Resolves `hint` once a hint arrived since the previous call, `timeout`
   * after `milliseconds` without one, and `closed` once the hub connection
   * is gone and no more hints will arrive.
   */
  readonly next: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<ThreadHintWake>;
  readonly close: () => void;
}

/**
 * Subscribes to the owner's home Realtime Hub and resolves once the hub has
 * registered the subscription, so a change committed after this returns
 * wakes the listener. Undefined when the hub is not bound or cannot be
 * reached; callers then poll D1.
 */
export const listenForThreadHints = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  ownerUserId: UserId,
  threadIds: ReadonlyArray<string>,
): Promise<ThreadHintListener | undefined> => {
  if (bindings.DB === undefined || bindings.REALTIME_HUB === undefined)
    return undefined;
  const watched = new Set(threadIds);
  let socket: WebSocket | null = null;
  try {
    const audience = await homeAudienceForUser(bindings.DB, ownerUserId);
    const response = await bindings.REALTIME_HUB.getByName(audience).fetch(
      "https://realtime.internal/subscribe",
      {
        headers: {
          upgrade: "websocket",
          [AUDIENCE_HEADER]: audience,
          [PARTICIPANT_HEADER]: ownerUserId,
          [CLIENT_HEADER]: crypto.randomUUID(),
        },
      },
    );
    socket = response.webSocket;
    if (socket === null) throw new Error(`Hub returned ${response.status}.`);
  } catch (cause) {
    realtimeLogger.warn("Thread hint subscription failed.", {
      event: "realtime_thread_hint_subscription_failed",
      cause,
    });
    return undefined;
  }

  const hub = socket;
  let ready = false;
  let hinted = false;
  let closed = false;
  let wake: (() => void) | undefined;
  let readyWake: ((ready: boolean) => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  hub.addEventListener("message", (event) => {
    let frame: { readonly type?: unknown; readonly threadId?: unknown };
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame.type === "ready") {
      ready = true;
      readyWake?.(true);
    } else if (
      frame.type === "thread.invalidated" &&
      typeof frame.threadId === "string" &&
      watched.has(frame.threadId)
    ) {
      hinted = true;
      notify();
    }
  });
  const onClosed = () => {
    closed = true;
    readyWake?.(false);
    notify();
  };
  hub.addEventListener("close", onClosed);
  hub.addEventListener("error", onClosed);
  hub.accept();

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      hub.close(1000, "done");
    } catch {
      // Already closing.
    }
  };

  const registered = await new Promise<boolean>((resolve) => {
    if (ready || closed) return resolve(ready);
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    readyWake = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
  });
  readyWake = undefined;
  if (!registered) {
    close();
    return undefined;
  }

  return {
    next: (milliseconds, signal) =>
      new Promise<ThreadHintWake>((resolve, reject) => {
        signal?.throwIfAborted();
        if (hinted) {
          hinted = false;
          return resolve("hint");
        }
        if (closed) return resolve("closed");
        const settle = (wakeKind: ThreadHintWake) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          wake = undefined;
          resolve(wakeKind);
        };
        const abort = () => {
          clearTimeout(timer);
          wake = undefined;
          reject(signal?.reason);
        };
        const timer = setTimeout(() => settle("timeout"), milliseconds);
        signal?.addEventListener("abort", abort, { once: true });
        wake = () => {
          if (hinted) {
            hinted = false;
            settle("hint");
          } else settle("closed");
        };
      }),
    close,
  };
};
