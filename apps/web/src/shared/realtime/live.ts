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

// ─── Plugin views ───

/**
 * The slot that draws a plugin's view described as data. The plugins
 * feature fills it (its renderer loads on first use), and every place a
 * view shows reads it: a Thread panel, a card in a message, a Thread's main
 * area, and a page.
 */

/** Where a view's state is read from: a page of the person's, or a Thread. */
export type DataViewSource =
  | { readonly kind: "page" }
  | { readonly kind: "thread"; readonly threadId: string };

export interface DataViewAddress {
  readonly source: DataViewSource;
  readonly plugin: string;
  readonly view: string;
  /** The install and the sha256 of the view file: the file's address. */
  readonly installId: string;
  readonly integrity: string;
}

export interface DataViewSlotProps {
  readonly address: DataViewAddress;
  /** Why actions are off here, such as a member viewing the owner's plugin. */
  readonly disabledReason?: string;
  /** Draws the view's own title above its parts. */
  readonly showTitle?: boolean;
  readonly className?: string;
}

export const DataViewSlot = React.createContext<
  React.ComponentType<DataViewSlotProps> | undefined
>(undefined);

/**
 * Plugin views' live state, between the realtime client (which owns the
 * socket) and the views that draw it. A view watches with the token its
 * state request returned; the hub then sends it every change to that view.
 */

/**
 * The socket's plugin view messages, undecoded, and a way to send one. The
 * views' lazy module keeps its watches on top of this, so the page's first
 * load carries none of it.
 */
export interface ViewLiveHub {
  readonly observe: (
    listener: (message: {
      readonly type: string;
      readonly [field: string]: unknown;
    }) => void,
  ) => () => void;
  readonly send: (message: { readonly type: string }) => void;
}

export const ViewLiveContext = React.createContext<ViewLiveHub | undefined>(
  undefined,
);
