import type { BoardLivePayload } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import * as React from "react";

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
    threadId: ThreadId,
    artifactId: string,
    payload: BoardLivePayload,
  ) => boolean;
  readonly observe: (
    threadId: ThreadId,
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
  threadId: ThreadId,
  artifactId: string,
): BoardLiveChannel => {
  const hub = React.use(BoardLiveContext);
  return {
    send: (payload) => hub?.send(threadId, artifactId, payload) ?? false,
    observe: (listener) =>
      hub?.observe(threadId, artifactId, listener) ?? (() => undefined),
  };
};
