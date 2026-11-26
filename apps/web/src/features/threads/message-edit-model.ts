// The Thread page's side of editing and deleting messages: the requests it
// sends and the context the transcript reads. What a message allows is in
// `message-edit-model.ts` in `@dx/client`.
import type { ThreadQueuedMessage } from "@dx/api";
import type { MessageEditing } from "@dx/client";
import * as React from "react";
import type { EditThreadMessageInput } from "./message-edit-mutations.js";
import type {
  DeleteThreadMessageInput,
  EditQueuedThreadMessageInput,
} from "./message-queue-queries.js";

/**
 * Editing and deleting the viewer's messages, which the Thread page offers
 * in ordinary Threads the viewer can write to: never in a Space, an
 * archived Thread, or to a viewer. `send` edits a read message, `editQueued`
 * one that waits for the agent, and `remove` deletes either; `pending` and
 * `removing` are their states. `onQueueChanged` reads the queue again.
 */
export interface MessageEditOptions {
  readonly viewerId: string;
  readonly send: (input: EditThreadMessageInput) => Promise<unknown>;
  readonly editQueued?: (input: EditQueuedThreadMessageInput) => Promise<{
    readonly outcome: "replaced" | "restarted";
  }>;
  readonly remove?: (input: DeleteThreadMessageInput) => Promise<unknown>;
  readonly pending: boolean;
  readonly removing?: boolean;
  /**
   * The viewer's own messages that wait for the agent, as the server read
   * them, including ones sent from another tab or device.
   */
  readonly queuedMessages?: ReadonlyArray<ThreadQueuedMessage>;
  /** Changes the queue as shown until the server's next read of it. */
  readonly updateQueued?: (
    update: (
      messages: ReadonlyArray<ThreadQueuedMessage>,
    ) => ReadonlyArray<ThreadQueuedMessage>,
  ) => void;
  readonly onQueueChanged?: () => void;
}

export const MessageEditContext = React.createContext<
  MessageEditing | undefined
>(undefined);
