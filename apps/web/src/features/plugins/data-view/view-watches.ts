import { Option, Schema } from "effect";
import type { ViewLiveHub } from "../../../shared/realtime/live.js";

/**
 * The browser's watches on plugin views' state, kept on top of the socket's
 * undecoded view messages. Each view watches with the token its state
 * request returned; the hub then sends every change to that view. After a
 * reconnect every watch is sent again and every view reads its state again,
 * since changes while the socket was down were not sent.
 */

/** What a watching view hears. */
export type ViewLiveEvent =
  | {
      readonly kind: "change";
      readonly version: number;
      /** The change itself, when it was small enough to send. */
      readonly patch?: { readonly path: string; readonly value?: unknown };
    }
  /** The socket reconnected or the watch was refused: read the state again. */
  | { readonly kind: "stale" };

/** A view's state changed; `patch` is the change when it is small. */
const ViewStateMessage = Schema.Struct({
  type: Schema.Literal("plugin-view.state"),
  key: Schema.String.check(Schema.isMaxLength(200)),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  patch: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  ),
});

type Listener = (event: ViewLiveEvent) => void;

interface Watches {
  readonly watch: (
    token: string,
    key: string,
    listener: Listener,
  ) => () => void;
}

const watchesFor = (hub: ViewLiveHub): Watches => {
  const watched = new Map<
    string,
    { token: string; readonly listeners: Set<Listener> }
  >();
  const notify = (key: string | undefined, event: ViewLiveEvent) => {
    for (const [watchedKey, entry] of watched)
      if (key === undefined || watchedKey === key)
        for (const listener of entry.listeners) listener(event);
  };
  hub.observe((message) => {
    if (message.type === "ready") {
      for (const entry of watched.values())
        hub.send({ type: "view.watch", token: entry.token } as {
          type: string;
        });
      notify(undefined, { kind: "stale" });
    } else if (message.type === "view.denied")
      notify(undefined, { kind: "stale" });
    else {
      const decoded = Schema.decodeUnknownOption(ViewStateMessage)(message);
      if (Option.isNone(decoded)) return;
      const { key, version, patch } = decoded.value;
      notify(key, {
        kind: "change",
        version,
        ...(patch === undefined ? {} : { patch }),
      });
    }
  });
  return {
    watch: (token, key, listener) => {
      const entry = watched.get(key) ?? {
        token,
        listeners: new Set<Listener>(),
      };
      entry.token = token;
      entry.listeners.add(listener);
      watched.set(key, entry);
      hub.send({ type: "view.watch", token } as { type: string });
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        watched.delete(key);
        hub.send({ type: "view.unwatch", key } as { type: string });
      };
    },
  };
};

const byHub = new WeakMap<ViewLiveHub, Watches>();

/** Hears every change to one view's state until the returned call. */
export const watchView = (
  hub: ViewLiveHub,
  token: string,
  key: string,
  listener: Listener,
) => {
  let watches = byHub.get(hub);
  if (watches === undefined) {
    watches = watchesFor(hub);
    byHub.set(hub, watches);
  }
  return watches.watch(token, key, listener);
};
