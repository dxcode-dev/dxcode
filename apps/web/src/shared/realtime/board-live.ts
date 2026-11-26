import type { BoardLivePayload } from "@dx/api";
import type { BoardLiveEvent, PresenceScope } from "@dx/client";
import * as React from "react";

/**
 * Live presence on an artifact, between the realtime client (which owns the
 * socket) and the editors: on a board, the viewer's pointer and the shapes
 * they are changing; in a document, their caret. The viewer's go out,
 * everyone else's come in. Nothing here is stored; the save is what keeps a
 * change.
 */

export type { BoardLiveEvent };

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
  /** The connections (client IDs) that have the scope open now. */
  readonly present: (
    threadId: PresenceScope,
  ) => ReadonlySet<string> | undefined;
  /** Calls `listener` whenever who has the scope open changes. */
  readonly observePresent: (
    threadId: PresenceScope,
    listener: () => void,
  ) => () => void;
}

/** One artifact's side of the hub. */
export interface BoardLiveChannel {
  readonly send: (payload: BoardLivePayload) => boolean;
  readonly observe: (listener: (event: BoardLiveEvent) => void) => () => void;
  /** Who has it open; undefined until the hub says. */
  readonly present: () => ReadonlySet<string> | undefined;
  readonly observePresent: (listener: () => void) => () => void;
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
    present: () => hub?.present(threadId),
    observePresent: (listener) =>
      hub?.observePresent(threadId, listener) ?? (() => undefined),
  };
};
