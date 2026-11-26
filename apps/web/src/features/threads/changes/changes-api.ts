import {
  GetThreadChangesDiffEndpoint,
  GetThreadChangesEndpoint,
  GetThreadShipPlanEndpoint,
  PushThreadChangesEndpoint,
  type PushThreadChangesResponse,
  type ThreadChangesCaptureId,
  type ThreadChangesData,
  type ThreadChangesDiffData,
  ThreadChangesEventsEndpoint,
  type ThreadChangesPath,
  type ThreadChangesRange,
  type ThreadChangesWorktreeId,
  type ThreadShipPlan,
} from "@dx/api";
import { ApiError, createDxClient, endpointPath } from "@dx/client";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import {
  isSessionEndedClose,
  reportSessionEnded,
} from "../../../shared/auth/session-ended.js";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";

export class ChangesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChangesApiError";
  }
}

export type ChangesData = ThreadChangesData | { readonly kind: "missing" };

export interface ChangesTransport {
  readonly getChanges: (
    threadId: ThreadId,
    range: ThreadChangesRange,
    signal?: AbortSignal,
  ) => Promise<ChangesData>;
  readonly getDiff: (
    threadId: ThreadId,
    path: ThreadChangesPath,
    range: ThreadChangesRange,
    captureId: ThreadChangesCaptureId,
    signal?: AbortSignal,
    worktree?: ThreadChangesWorktreeId,
  ) => Promise<ThreadChangesDiffData>;
  readonly subscribe?: (
    threadId: ThreadId,
    onChangesUpdated: () => void,
  ) => () => void;
  readonly push: (
    threadId: ThreadId,
    input: {
      readonly expectedCaptureId: ThreadChangesCaptureId;
      readonly idempotencyKey: string;
    },
    signal?: AbortSignal,
  ) => Promise<PushThreadChangesResponse["data"]>;
  /** The project's Ship Behavior for the main action; absent hides it. */
  readonly getShipPlan?: (
    threadId: ThreadId,
    signal?: AbortSignal,
  ) => Promise<ThreadShipPlan>;
  /** Sends the Ship prompt as the person's own message to the agent. */
  readonly ship?: (
    threadId: ThreadId,
    input: { readonly prompt: string; readonly idempotencyKey: string },
  ) => Promise<void>;
}

export const serializeChangesRange = (range: ThreadChangesRange) =>
  range.kind === "commit" ? `commit:${range.sha}` : range.kind;

export interface ChangesEventSocket {
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: Event) => void,
  ): void;
  close(): void;
}

export interface ChangesSubscriptionFactories {
  readonly createSocket: (url: string, protocol: string) => ChangesEventSocket;
  readonly setTimer?: typeof globalThis.setTimeout;
  readonly clearTimer?: typeof globalThis.clearTimeout;
  readonly random?: () => number;
  readonly origin?: string;
}

export const subscribeToChanges = (
  threadId: ThreadId,
  onChangesUpdated: () => void,
  factories: ChangesSubscriptionFactories,
): (() => void) => {
  const setTimer = factories.setTimer ?? globalThis.setTimeout;
  const clearTimer = factories.clearTimer ?? globalThis.clearTimeout;
  const random = factories.random ?? Math.random;
  let disposed = false;
  let attempt = 0;
  let socket: ChangesEventSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (disposed) return;
    const base = new URL(factories.origin ?? window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = endpointPath(ThreadChangesEventsEndpoint, {
      params: { threadId },
    });
    base.search = "";
    base.hash = "";
    socket = factories.createSocket(base.toString(), "dx-changes-v1");
    socket.addEventListener("open", () => {
      if (disposed) return;
      attempt = 0;
      // The server sends an initial hint after accepting the subscription.
      // Invalidating here too causes a duplicate read on every connection.
    });
    socket.addEventListener("message", (event) => {
      if (disposed || !(event instanceof MessageEvent)) return;
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "changes-updated"
        )
          onChangesUpdated();
      } catch {
        // Invalid hints are safe to ignore. The polling fallback remains active.
      }
    });
    socket.addEventListener("close", (event) => {
      if (disposed) return;
      if (isSessionEndedClose((event as Partial<CloseEvent>).code)) {
        reportSessionEnded();
        return;
      }
      const delay = Math.min(1_000 * 2 ** attempt, 30_000);
      attempt = Math.min(attempt + 1, 5);
      timer = setTimer(connect, delay * (0.75 + random() * 0.5));
    });
  };
  connect();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimer(timer);
    socket?.close();
  };
};

/**
 * Runs one Changes call as a ChangesApiError: the route's own message for
 * an error it sends on purpose, else a generic one.
 */
const changesCall = async <A>(
  run: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> => {
  try {
    const answer = await run();
    signal?.throwIfAborted();
    return answer;
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    if (cause instanceof ApiError)
      throw new ChangesApiError(
        cause.status,
        cause.hasValidatedPayload ? cause.message : "Changes request failed.",
      );
    if (Schema.isSchemaError(cause))
      throw new ChangesApiError(200, "Changes response was invalid.");
    throw cause;
  }
};

export const createChangesTransport = (
  fetchImpl: typeof fetch = sameOriginFetch,
  subscriptionFactories?: ChangesSubscriptionFactories,
): ChangesTransport => {
  const client = createDxClient({
    fetch: (path, init) =>
      fetchImpl(path, { ...init, credentials: "same-origin" }),
  });
  const options = (signal: AbortSignal | undefined) =>
    signal === undefined ? {} : { signal };
  return {
    getChanges: (threadId, range, signal) =>
      changesCall(
        () =>
          client.call(
            GetThreadChangesEndpoint,
            {
              params: { threadId },
              query: { range: serializeChangesRange(range) },
            },
            options(signal),
          ),
        signal,
      ).then((response) => response.data),
    getDiff: (threadId, path, range, captureId, signal, worktree) =>
      changesCall(
        () =>
          client.call(
            GetThreadChangesDiffEndpoint,
            {
              params: { threadId },
              query: {
                path,
                range: serializeChangesRange(range),
                captureId,
                worktree: worktree ?? ("primary" as ThreadChangesWorktreeId),
              },
            },
            options(signal),
          ),
        signal,
      ).then((response) => response.data),
    push: (threadId, input, signal) =>
      changesCall(
        () =>
          client.call(
            PushThreadChangesEndpoint,
            {
              params: { threadId },
              body: { ...input, confirmation: "push" },
            },
            options(signal),
          ),
        signal,
      ).then((response) => response.data),
    getShipPlan: (threadId, signal) =>
      changesCall(
        () =>
          client.call(
            GetThreadShipPlanEndpoint,
            { params: { threadId } },
            options(signal),
          ),
        signal,
      ).then((response) => response.data),
    // The same message the composer sends, so it runs as a typed one would.
    ship: async (threadId, { prompt, idempotencyKey }) => {
      const response = await fetchImpl(
        `/v1/agents/dx/${encodeURIComponent(threadId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey, kind: "user", body: prompt }),
        },
      );
      if (response.ok) return;
      const body = (await response.json().catch(() => undefined)) as
        | { data?: { message?: unknown }; error?: { message?: unknown } }
        | undefined;
      const message = body?.data?.message ?? body?.error?.message;
      throw new ChangesApiError(
        response.status,
        typeof message === "string" && message !== ""
          ? message
          : "The Ship message was not sent.",
      );
    },
    subscribe: (threadId, onChangesUpdated) =>
      subscribeToChanges(
        threadId,
        onChangesUpdated,
        subscriptionFactories ?? {
          createSocket: (url, protocol) => new WebSocket(url, protocol),
        },
      ),
  };
};

export const defaultChangesTransport = createChangesTransport();
