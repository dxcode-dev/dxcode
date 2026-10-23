import type { PushDeviceData } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { PushTarget } from "./channels/web-push.js";

/**
 * The browsers a person registered for push. A row holds the endpoint its
 * push service issued and the keys every message is encrypted to. The
 * endpoint is a bearer address for that browser, so it never leaves Core:
 * clients see only the device's id and label.
 */

const newPushSubscriptionId = () =>
  `psb_${crypto.randomUUID().replaceAll("-", "")}`;

/** At most this many devices per person; the oldest give way. */
const MAX_DEVICES = 20;

export interface PushSubscriptionInput {
  readonly userId: UserId;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly label: string;
}

/**
 * Records one browser. The same endpoint registered again keeps its row and
 * takes the new keys and owner, so signing in as someone else on a device
 * moves its push to that person instead of leaking the first person's
 * notifications to the second.
 */
export const registerPushSubscription = async (
  db: D1Database,
  input: PushSubscriptionInput,
  now = new Date(),
): Promise<string> => {
  const row = await db
    .prepare(
      `INSERT INTO push_subscription
         (id, user_id, endpoint, p256dh, auth, label, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         label = excluded.label,
         created_at = excluded.created_at,
         last_delivered_at = NULL
       RETURNING id`,
    )
    .bind(
      newPushSubscriptionId(),
      input.userId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.label.slice(0, 128),
      now.toISOString(),
    )
    .first<{ id: string }>();
  await db
    .prepare(
      `DELETE FROM push_subscription
        WHERE user_id = ?1
          AND id NOT IN (
            SELECT id FROM push_subscription
             WHERE user_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT ${MAX_DEVICES}
          )`,
    )
    .bind(input.userId)
    .run();
  return row?.id ?? "";
};

/** Removes one of the person's own devices, by endpoint or by its id. */
export const removePushSubscription = async (
  db: D1Database,
  userId: UserId,
  device: { readonly endpoint?: string; readonly deviceId?: string },
) => {
  await db
    .prepare(
      `DELETE FROM push_subscription
        WHERE user_id = ?1
          AND ((?2 IS NOT NULL AND endpoint = ?2)
            OR (?3 IS NOT NULL AND id = ?3))`,
    )
    .bind(userId, device.endpoint ?? null, device.deviceId ?? null)
    .run();
};

/** Drops a subscription its push service reported gone. */
export const forgetPushSubscription = async (
  db: D1Database,
  endpoint: string,
) => {
  await db
    .prepare("DELETE FROM push_subscription WHERE endpoint = ?1")
    .bind(endpoint)
    .run();
};

interface DeviceRow {
  readonly id: string;
  readonly label: string;
  readonly created_at: string;
  readonly last_delivered_at: string | null;
  readonly endpoint: string;
}

/**
 * How a browser recognises its own registration without dx handing any
 * endpoint back: the SHA-256 of the endpoint, which the browser computes
 * from the subscription it already holds.
 */
export const pushEndpointHash = async (endpoint: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const deviceData = async (row: DeviceRow): Promise<PushDeviceData> => ({
  id: row.id,
  label: row.label === "" ? "This browser" : row.label,
  endpointHash: await pushEndpointHash(row.endpoint),
  createdAt: row.created_at,
  ...(row.last_delivered_at === null
    ? {}
    : { lastDeliveredAt: row.last_delivered_at }),
});

/** A person's devices, newest first, without their endpoints. */
export const listPushDevices = async (
  db: D1Database,
  userId: UserId,
): Promise<ReadonlyArray<PushDeviceData>> => {
  const rows = await db
    .prepare(
      `SELECT id, label, created_at, last_delivered_at, endpoint
         FROM push_subscription
        WHERE user_id = ?1
        ORDER BY created_at DESC, rowid DESC`,
    )
    .bind(userId)
    .all<DeviceRow>();
  return Promise.all(rows.results.map(deviceData));
};

/** Where to send, and what to encrypt to, for one person. */
export const pushTargets = async (
  db: D1Database,
  userId: UserId,
): Promise<ReadonlyArray<PushTarget>> =>
  (
    await db
      .prepare(
        `SELECT endpoint, p256dh, auth FROM push_subscription
          WHERE user_id = ?1
          ORDER BY created_at DESC, rowid DESC`,
      )
      .bind(userId)
      .all<{ endpoint: string; p256dh: string; auth: string }>()
  ).results;

export const recordPushDelivery = async (
  db: D1Database,
  endpoints: ReadonlyArray<string>,
  now = new Date(),
) => {
  if (endpoints.length === 0) return;
  await db
    .prepare(
      `UPDATE push_subscription SET last_delivered_at = ?1
        WHERE endpoint IN (SELECT value FROM json_each(?2))`,
    )
    .bind(now.toISOString(), JSON.stringify(endpoints))
    .run();
};
