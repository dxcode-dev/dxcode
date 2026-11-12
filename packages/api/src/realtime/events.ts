import { ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";

const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const ClientId = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
);
const PresenceTopic = Schema.TemplateLiteral(["thread:", ThreadId]);

export const RealtimeReadyEvent = Schema.Struct({
  type: Schema.Literal("ready"),
  revision: Revision,
});

export const RealtimeRevisionGapEvent = Schema.Struct({
  type: Schema.Literal("revision-gap"),
  cursor: Revision,
  revision: Revision,
  recovery: Schema.Literal("http-refetch"),
});

export const RealtimeInvalidationEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("readiness.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("changes.invalidated"),
    threadId: ThreadId,
    /**
     * The totals Thread lists show moved. Absent, only the Thread's own
     * Changes and files changed.
     */
    summaryChanged: Schema.optional(Schema.Literal(true)),
    revision: Revision,
  }),
  /** The Thread's Orb came under memory pressure; refetch its memory. */
  Schema.Struct({
    type: Schema.Literal("memory.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * A Thread's artifacts changed: one was created, saved, or deleted.
   * Content-free; refetch the list and any open artifact.
   */
  Schema.Struct({
    type: Schema.Literal("artifacts.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * Comments on a Space's messages changed. Content-free; refetch the
   * Space's commented messages and any open comments.
   */
  Schema.Struct({
    type: Schema.Literal("comments.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * A Space's posts changed: one was posted or edited, or its reactions
   * changed. Content-free; refetch the Space's posts.
   */
  Schema.Struct({
    type: Schema.Literal("space.posts.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * Reactions on a shared Thread's messages changed. Content-free; refetch
   * the Thread's message reactions.
   */
  Schema.Struct({
    type: Schema.Literal("reactions.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * Installed plugins' prompts, notices, or quick actions in the Thread
   * changed. Content-free; refetch them.
   */
  Schema.Struct({
    type: Schema.Literal("plugin-ui.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /**
   * A plugin posted to one of its panes in the Thread. Content-free;
   * open panes fetch their new messages.
   */
  Schema.Struct({
    type: Schema.Literal("plugin-pane.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
  /** The Thread's Orb disk is filling up; refetch its disk. */
  Schema.Struct({
    type: Schema.Literal("disk.invalidated"),
    threadId: ThreadId,
    revision: Revision,
  }),
]);

/** The user's notification inbox changed; refetch it. */
export const RealtimeNotificationsEvent = Schema.Struct({
  type: Schema.Literal("notifications.invalidated"),
  revision: Revision,
});

/** The user's sidebar layout changed on another device; refetch it. */
export const RealtimeSidebarLayoutEvent = Schema.Struct({
  type: Schema.Literal("sidebar.invalidated"),
  revision: Revision,
});

export const RealtimePresenceSnapshotEvent = Schema.Struct({
  type: Schema.Literal("presence.snapshot"),
  topic: PresenceTopic,
  participants: Schema.Array(
    Schema.Struct({ userId: UserId, clientId: ClientId }),
  ),
});

/**
 * Someone with the Thread open is typing a comment on one of its messages
 * (`scope`, the message's id). Ephemeral: never stored, never revisioned;
 * it lapses unless repeated.
 */
export const RealtimeTypingEvent = Schema.Struct({
  type: Schema.Literal("presence.typing"),
  topic: PresenceTopic,
  userId: UserId,
  clientId: ClientId,
  scope: Schema.String.check(Schema.isPattern(/^[\w.-]{1,160}$/)),
});

/**
 * Live drawing on a board (`scope` is the artifact's id): where the sender's
 * pointer is, what they have selected, and the elements they are changing
 * right now, before their save. Memory only, like typing: the next save
 * carries the same change, and the hub relays `elements` only from people
 * who can edit the Thread.
 */
export const BoardLivePayload = Schema.Struct({
  pointer: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        tool: Schema.optional(Schema.Literals(["pointer", "laser"])),
      }),
    ),
  ),
  button: Schema.optional(Schema.Literals(["up", "down"])),
  selected: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(500)),
  ),
  elements: Schema.optional(
    Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1000)),
  ),
});
export type BoardLivePayload = typeof BoardLivePayload.Type;

/** The most bytes one live board message carries; larger ones are dropped. */
export const BOARD_LIVE_MAX_BYTES = 256 * 1024;

export const RealtimeBoardEvent = Schema.Struct({
  type: Schema.Literal("presence.board"),
  topic: PresenceTopic,
  userId: UserId,
  clientId: ClientId,
  scope: Schema.String.check(Schema.isPattern(/^art_[0-9a-f]{32}$/)),
  payload: BoardLivePayload,
});

export const RealtimeWorkspaceStatusEvent = Schema.Struct({
  type: Schema.Literal("workspace.status"),
  threadId: ThreadId,
  status: Schema.Literals(["waking", "ready"]),
  revision: Revision,
});

export const RealtimeServerEvent = Schema.Union([
  RealtimeReadyEvent,
  RealtimeRevisionGapEvent,
  RealtimeInvalidationEvent,
  RealtimeWorkspaceStatusEvent,
  RealtimeNotificationsEvent,
  RealtimeSidebarLayoutEvent,
  RealtimePresenceSnapshotEvent,
  RealtimeTypingEvent,
  RealtimeBoardEvent,
  Schema.Struct({
    type: Schema.Literal("presence.heartbeat"),
    topic: PresenceTopic,
  }),
  Schema.Struct({
    type: Schema.Literal("presence.rejoin-required"),
    topic: PresenceTopic,
  }),
  /** The user may not join this Thread (now); do not retry until it changes. */
  Schema.Struct({
    type: Schema.Literal("presence.denied"),
    topic: PresenceTopic,
  }),
]);

export type RealtimeServerEvent = typeof RealtimeServerEvent.Type;
