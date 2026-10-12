import type {
  NotificationChannel,
  NotificationData,
  NotificationTopic,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { sharedThreadVisibleSql } from "../thread-sharing/access.js";
import { displayNameSql } from "../thread-sharing/service.js";

const INBOX_LIMIT = 50;

const newNotificationId = () =>
  `ntf_${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * SQL predicate: the recipient can still open the notification's Thread,
 * as its owner or as a member it is shared with.
 */
const reachableSql = (recipient: string) => `
  thread.lifecycle_state != 'deleted'
  AND (
    (thread.owner_user_id = ${recipient}
      AND ${threadProjectReachableSql("project", recipient)})
    OR ${sharedThreadVisibleSql("thread", "project", recipient)}
  )`;

export interface NewNotification {
  readonly id: string;
  readonly recipientUserId: UserId;
}

/**
 * Records one notification per recipient. Returns only the rows this call
 * created: a recipient who already has the event's source key is skipped,
 * so a retried message notifies once.
 */
export const insertNotifications = async (
  db: D1Database,
  input: {
    readonly topic: NotificationTopic;
    readonly sourceKey: string;
    readonly recipients: ReadonlyArray<UserId>;
    readonly threadId: ThreadId;
    readonly messageId?: string;
    readonly actorUserId?: UserId;
    readonly excerpt: string;
  },
  now = new Date(),
): Promise<ReadonlyArray<NewNotification>> => {
  if (input.recipients.length === 0) return [];
  const results = await db.batch<{ id: string; recipient_user_id: string }>(
    input.recipients.map((recipient) =>
      db
        .prepare(
          `INSERT INTO notification
             (id, recipient_user_id, topic, source_key, thread_id, message_id,
              actor_user_id, excerpt, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT (recipient_user_id, source_key) DO NOTHING
           RETURNING id, recipient_user_id`,
        )
        .bind(
          newNotificationId(),
          recipient,
          input.topic,
          input.sourceKey,
          input.threadId,
          input.messageId ?? null,
          input.actorUserId ?? null,
          input.excerpt.slice(0, 512),
          now.toISOString(),
        ),
    ),
  );
  return results.flatMap((result) =>
    result.results.map((row) => ({
      id: row.id,
      recipientUserId: row.recipient_user_id as UserId,
    })),
  );
};

interface InboxRow {
  readonly id: string;
  readonly topic: NotificationTopic;
  readonly thread_id: string;
  readonly thread_title: string;
  readonly message_id: string | null;
  readonly excerpt: string;
  readonly created_at: string;
  readonly read_at: string | null;
  readonly actor_user_id: string | null;
  readonly actor_name: string | null;
  readonly actor_handle: string | null;
  readonly actor_image: string | null;
}

/** The newest notifications for Threads the recipient can still open. */
export const listNotifications = async (
  db: D1Database,
  recipient: UserId,
): Promise<ReadonlyArray<NotificationData>> =>
  (
    await db
      .prepare(
        `SELECT notification.id, notification.topic, notification.thread_id,
                thread.title AS thread_title, notification.message_id,
                notification.excerpt, notification.created_at,
                notification.read_at, notification.actor_user_id,
                ${displayNameSql("actor", "account")} AS actor_name,
                account.username AS actor_handle, actor.image AS actor_image
           FROM notification
           JOIN threads AS thread ON thread.id = notification.thread_id
           JOIN projects AS project ON project.id = thread.project_id
           LEFT JOIN "user" AS actor ON actor.id = notification.actor_user_id
           LEFT JOIN personal_account AS account
                  ON account.user_id = notification.actor_user_id
          WHERE notification.recipient_user_id = ?1
            AND ${reachableSql("?1")}
          ORDER BY notification.created_at DESC, notification.rowid DESC
          LIMIT ${INBOX_LIMIT}`,
      )
      .bind(recipient)
      .all<InboxRow>()
  ).results.map((row) => ({
    id: row.id,
    topic: row.topic,
    threadId: row.thread_id as ThreadId,
    threadTitle: row.thread_title.slice(0, 256),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    ...(row.actor_user_id === null
      ? {}
      : {
          actor: {
            userId: row.actor_user_id as UserId,
            name: (row.actor_name?.trim() || "Member").slice(0, 256),
            ...(row.actor_handle
              ? { handle: row.actor_handle.slice(0, 64) }
              : {}),
            ...(row.actor_image === null || row.actor_image.length > 2_048
              ? {}
              : { image: row.actor_image }),
          },
        }),
    excerpt: row.excerpt,
    createdAt: row.created_at,
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
  }));

/**
 * Unread notifications among the ones the inbox lists, so the count never
 * includes rows the person cannot see or open; older unread notifications
 * age out of the badge. Mark all read still clears them.
 */
export const unreadNotificationCount = async (
  db: D1Database,
  recipient: UserId,
) =>
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM (
             SELECT notification.read_at
               FROM notification
               JOIN threads AS thread ON thread.id = notification.thread_id
               JOIN projects AS project ON project.id = thread.project_id
              WHERE notification.recipient_user_id = ?1
                AND ${reachableSql("?1")}
              ORDER BY notification.created_at DESC, notification.rowid DESC
              LIMIT ${INBOX_LIMIT}
           )
          WHERE read_at IS NULL`,
      )
      .bind(recipient)
      .first<{ count: number }>()
  )?.count ?? 0;

/** Marks the recipient's own notifications read; others' ids are ignored. */
export const markNotificationsRead = async (
  db: D1Database,
  recipient: UserId,
  ids: ReadonlyArray<string> | "all",
  now = new Date(),
) => {
  if (ids === "all") {
    await db
      .prepare(
        `UPDATE notification SET read_at = ?2
          WHERE recipient_user_id = ?1 AND read_at IS NULL`,
      )
      .bind(recipient, now.toISOString())
      .run();
    return;
  }
  if (ids.length === 0) return;
  await db
    .prepare(
      `UPDATE notification SET read_at = ?2
        WHERE recipient_user_id = ?1 AND read_at IS NULL
          AND id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(recipient, now.toISOString(), JSON.stringify(ids))
    .run();
};

/** Stored choices; a missing topic and channel pair means its default. */
export const notificationPreferences = async (
  db: D1Database,
  userIds: ReadonlyArray<UserId>,
): Promise<ReadonlyMap<string, boolean>> => {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT user_id, topic, channel, enabled FROM notification_preference
        WHERE user_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(userIds))
    .all<{
      user_id: string;
      topic: string;
      channel: string;
      enabled: number;
    }>();
  return new Map(
    rows.results.map((row) => [
      preferenceKey(row.user_id as UserId, row.topic, row.channel),
      row.enabled === 1,
    ]),
  );
};

export const preferenceKey = (userId: UserId, topic: string, channel: string) =>
  `${userId}\n${topic}\n${channel}`;

export const setNotificationPreference = async (
  db: D1Database,
  input: {
    readonly userId: UserId;
    readonly topic: NotificationTopic;
    readonly channel: NotificationChannel;
    readonly enabled: boolean;
  },
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO notification_preference
         (user_id, topic, channel, enabled, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id, topic, channel)
       DO UPDATE SET enabled = excluded.enabled,
                     updated_at = excluded.updated_at`,
    )
    .bind(
      input.userId,
      input.topic,
      input.channel,
      input.enabled ? 1 : 0,
      now.toISOString(),
    )
    .run();
};

export const recordDelivery = async (
  db: D1Database,
  input: {
    readonly notificationId: string;
    readonly channel: NotificationChannel;
    readonly status: "sent" | "failed";
    readonly error?: string;
  },
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO notification_delivery
         (notification_id, channel, status, error, attempted_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (notification_id, channel)
       DO UPDATE SET status = excluded.status, error = excluded.error,
                     attempted_at = excluded.attempted_at`,
    )
    .bind(
      input.notificationId,
      input.channel,
      input.status,
      input.error?.slice(0, 64) ?? null,
      now.toISOString(),
    )
    .run();
};

/** Name and address of each recipient, for channels that need them. */
export const recipientContacts = async (
  db: D1Database,
  userIds: ReadonlyArray<UserId>,
): Promise<
  ReadonlyMap<UserId, { readonly name: string; readonly email: string }>
> => {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT "user".id, ${displayNameSql('"user"', "account")} AS name,
              "user".email
         FROM "user"
         LEFT JOIN personal_account AS account ON account.user_id = "user".id
        WHERE "user".id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(userIds))
    .all<{ id: string; name: string | null; email: string }>();
  return new Map(
    rows.results.map((row) => [
      row.id as UserId,
      { name: (row.name?.trim() || "Member").slice(0, 256), email: row.email },
    ]),
  );
};

export const threadTitle = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare("SELECT title FROM threads WHERE id = ?1")
      .bind(threadId)
      .first<{ title: string }>()
  )?.title ?? "Untitled thread";
