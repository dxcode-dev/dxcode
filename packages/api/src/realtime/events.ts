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
