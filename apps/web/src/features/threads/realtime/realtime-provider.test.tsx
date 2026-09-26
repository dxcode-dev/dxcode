// @vitest-environment happy-dom

import { ThreadId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RealtimeProvider, useThreadPresence } from "./realtime-provider.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];
  readonly close = vi.fn();

  send(data: string) {
    this.sent.push(data);
  }

  receive(value: unknown) {
    this.readyState = WebSocket.OPEN;
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

const userId = Schema.decodeUnknownSync(UserId)(
  "usr_00000000-0000-4000-8000-000000000001",
);
const threadA = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);
const threadB = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000002",
);

const Presence = ({ threadId }: { readonly threadId: ThreadId }) => {
  useThreadPresence(threadId);
  return null;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("moves presence and heartbeats to the next thread when a route is reused", () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends FakeSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;

      constructor() {
        super();
        sockets.push(this);
      }
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (threadId: ThreadId) => (
    <RealtimeProvider queryClient={new QueryClient()} userId={userId}>
      <Presence threadId={threadId} />
    </RealtimeProvider>
  );

  act(() => root.render(render(threadA)));
  act(() => sockets[0]?.receive({ type: "ready", revision: 0 }));
  act(() => root.render(render(threadB)));
  act(() => vi.advanceTimersByTime(10_000));

  expect(sockets[0]?.sent.map((message) => JSON.parse(message))).toEqual([
    { type: "presence.join", topic: `thread:${threadA}` },
    { type: "presence.leave", topic: `thread:${threadA}` },
    { type: "presence.join", topic: `thread:${threadB}` },
    { type: "presence.heartbeat", topic: `thread:${threadB}` },
  ]);
  act(() => root.unmount());
});
