import type { BoardLivePayload } from "@dx/api";
import type { UserId } from "@dx/domain";
import * as React from "react";
import type { PresenceScope } from "./presence-scope.js";

/**
 * Live drawing on a board, between the realtime client (which owns the
 * socket) and the board editor (which draws): the viewer's pointer and the
 * shapes they are changing go out, everyone else's come in. Nothing here is
 * stored; the board's save is what keeps a change.
 */

/** Someone drawing on a board, as the hub relays it. */
export interface BoardLiveEvent {
  readonly userId: UserId;
  readonly clientId: string;
  readonly payload: BoardLivePayload;
}

export interface BoardLiveHub {
  readonly send: (
    threadId: PresenceScope,
    artifactId: string,
    payload: BoardLivePayload,
  ) => boolean;
  readonly observe: (
    threadId: PresenceScope,
    artifactId: string,
    listener: (event: BoardLiveEvent) => void,
  ) => () => void;
}

/** One board's side of the hub. */
export interface BoardLiveChannel {
  readonly send: (payload: BoardLivePayload) => boolean;
  readonly observe: (listener: (event: BoardLiveEvent) => void) => () => void;
}

/** Given by the realtime provider; absent, boards still save and merge. */
export const BoardLiveContext = React.createContext<BoardLiveHub | undefined>(
  undefined,
);

export const useBoardLiveChannel = (
  threadId: PresenceScope,
  artifactId: string,
): BoardLiveChannel => {
  const hub = React.use(BoardLiveContext);
  return {
    send: (payload) => hub?.send(threadId, artifactId, payload) ?? false,
    observe: (listener) =>
      hub?.observe(threadId, artifactId, listener) ?? (() => undefined),
  };
};
