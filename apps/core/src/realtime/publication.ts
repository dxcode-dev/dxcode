import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { realtimeLogger } from "../logging.js";

export const AUDIENCE_HEADER = "x-dx-realtime-audience";
export const PARTICIPANT_HEADER = "x-dx-realtime-participant";
export const CLIENT_HEADER = "x-dx-realtime-client";

export type AudienceKey = `user:${string}` | `workspace:${string}`;
export type RealtimeThreadEventType =
  | "thread.invalidated"
  | "readiness.invalidated"
  | "changes.invalidated"
  | "workspace.status";
export type InvalidationType = Exclude<
  RealtimeThreadEventType,
  "workspace.status"
>;
export type WorkspaceStatus = "waking" | "ready";

export const userAudienceKey = (userId: UserId): AudienceKey =>
  `user:${userId}`;
export const workspaceAudienceKey = (workspaceId: string): AudienceKey =>
  `workspace:${workspaceId}`;

export const homeAudienceForUser = async (
  db: D1Database,
  userId: UserId,
): Promise<AudienceKey> => {
  const membership = await db
    .prepare(
      `SELECT organizationId
         FROM member
        WHERE userId = ?
        LIMIT 1`,
    )
    .bind(userId)
    .first<{ organizationId: string }>();
  return membership === null
    ? userAudienceKey(userId)
    : workspaceAudienceKey(membership.organizationId);
};

const threadAudience = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<
  { readonly audience: AudienceKey; readonly ownerUserId: UserId } | undefined
> => {
  const row = await db
    .prepare(
      `SELECT threads.owner_user_id AS ownerUserId, member.organizationId
         FROM threads
         LEFT JOIN member ON member.userId = threads.owner_user_id
        WHERE threads.id = ?
        LIMIT 1`,
    )
    .bind(threadId)
    .first<{ ownerUserId: UserId; organizationId: string | null }>();
  if (row === null) return undefined;
  return {
    ownerUserId: row.ownerUserId,
    audience:
      row.organizationId === null
        ? userAudienceKey(row.ownerUserId)
        : workspaceAudienceKey(row.organizationId),
  };
};

export const publishRealtimeInvalidation = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: ThreadId,
  type: InvalidationType,
): Promise<void> => {
  await publishRealtimeThreadEvent(bindings, threadId, { type });
};

export const publishRealtimeWorkspaceStatus = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: ThreadId,
  status: WorkspaceStatus,
): Promise<void> => {
  await publishRealtimeThreadEvent(bindings, threadId, {
    type: "workspace.status",
    status,
  });
};

const publishRealtimeThreadEvent = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: ThreadId,
  event:
    | { readonly type: InvalidationType }
    | { readonly type: "workspace.status"; readonly status: WorkspaceStatus },
): Promise<void> => {
  if (bindings.DB === undefined || bindings.REALTIME_HUB === undefined) return;
  try {
    const target = await threadAudience(bindings.DB, threadId);
    if (target === undefined) return;
    const response = await bindings.REALTIME_HUB.getByName(
      target.audience,
    ).fetch("https://realtime.internal/invalidate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUDIENCE_HEADER]: target.audience,
        [PARTICIPANT_HEADER]: target.ownerUserId,
        [CLIENT_HEADER]: crypto.randomUUID(),
      },
      body: JSON.stringify({
        ...event,
        threadId,
        ownerUserId: target.ownerUserId,
      }),
    });
    if (!response.ok)
      throw new Error(`Realtime hub returned ${response.status}.`);
  } catch (cause) {
    realtimeLogger.warn("Realtime Thread event publication failed.", {
      event: "realtime_thread_event_publication_failed",
      threadId,
      type: event.type,
      cause,
    });
  }
};

const missingExecutionContextMessage = "This context has no ExecutionContext";

export const scheduleRealtimeInvalidation = async (
  executionContext: () => {
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: ThreadId,
  type: InvalidationType,
): Promise<void> => {
  const publication = publishRealtimeInvalidation(bindings, threadId, type);
  try {
    executionContext().waitUntil(publication);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === missingExecutionContextMessage
    )
      return publication;
    throw cause;
  }
};
