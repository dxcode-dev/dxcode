import {
  GetThreadChangesDiffResponseSchema,
  GetThreadChangesResponseSchema,
  type PushThreadChangesResponse,
  PushThreadChangesResponseSchema,
  type ThreadChangesCaptureId,
  type ThreadChangesData,
  type ThreadChangesDiffData,
  type ThreadChangesPath,
  type ThreadChangesRange,
  type ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
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
}

export const serializeChangesRange = (range: ThreadChangesRange) =>
  range.kind === "commit" ? `commit:${range.sha}` : range.kind;

const endpoint = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/changes`;

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
    base.pathname = `${endpoint(threadId)}/events`;
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
    socket.addEventListener("close", () => {
      if (disposed) return;
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

const request = async <S extends Schema.ConstraintDecoder<unknown>>(
  fetchImpl: typeof fetch,
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await fetchImpl(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "data" in body &&
      typeof body.data === "object" &&
      body.data !== null &&
      "message" in body.data &&
      typeof body.data.message === "string"
        ? body.data.message
        : "Changes request failed.";
    throw new ChangesApiError(response.status, message);
  }
  try {
    init?.signal?.throwIfAborted();
    return await Effect.runPromise(Schema.decodeUnknownEffect(schema)(body), {
      signal: init?.signal ?? undefined,
    });
  } catch (cause) {
    if (init?.signal?.aborted) throw init.signal.reason ?? cause;
    throw new ChangesApiError(response.status, "Changes response was invalid.");
  }
};

export const createChangesTransport = (
  fetchImpl: typeof fetch = sameOriginFetch,
  subscriptionFactories?: ChangesSubscriptionFactories,
): ChangesTransport => ({
  getChanges: (threadId, range, signal) => {
    const query = new URLSearchParams({
      range: serializeChangesRange(range),
    });
    return request(
      fetchImpl,
      `${endpoint(threadId)}?${query}`,
      GetThreadChangesResponseSchema,
      { signal },
    ).then((response) => response.data);
  },
  getDiff: (threadId, path, range, captureId, signal, worktree) => {
    const query = new URLSearchParams({
      path,
      range: serializeChangesRange(range),
      captureId,
      worktree: worktree ?? "primary",
    });
    return request(
      fetchImpl,
      `${endpoint(threadId)}/diff?${query}`,
      GetThreadChangesDiffResponseSchema,
      { signal },
    ).then((response) => response.data);
  },
  push: (threadId, input, signal) =>
    request(
      fetchImpl,
      `${endpoint(threadId)}/push`,
      PushThreadChangesResponseSchema,
      {
        method: "POST",
        signal,
        body: JSON.stringify({ ...input, confirmation: "push" }),
      },
    ).then((response) => response.data),
  subscribe: (threadId, onChangesUpdated) =>
    subscribeToChanges(
      threadId,
      onChangesUpdated,
      subscriptionFactories ?? {
        createSocket: (url, protocol) => new WebSocket(url, protocol),
      },
    ),
});

export const defaultChangesTransport = createChangesTransport();
