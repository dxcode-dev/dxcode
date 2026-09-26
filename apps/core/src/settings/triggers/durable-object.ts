import { DurableObject } from "cloudflare:workers";
import {
  MAX_TRIGGER_DELIVERY_ATTEMPTS,
  MAX_TRIGGER_EVENTS_PER_MINUTE,
  MAX_TRIGGER_PENDING_DELIVERIES,
  TRIGGER_DELIVERY_LEASE_MS,
  TRIGGER_HISTORY_LIMIT,
} from "@dx/domain";
import { Effect, Result } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  invokePluginTrigger,
  PluginExecutionForbidden,
  PluginExecutionLimited,
  PluginIsolationLive,
} from "../plugins/execution.js";
import {
  loadAuthorizedTriggerDelivery,
  TriggerDeliveryForbidden,
} from "./authorization.js";

interface DeliveryRow {
  readonly [key: string]: SqlStorageValue;
  readonly id: string;
  readonly event_id: string;
  readonly idempotency_key: string;
  readonly payload_json: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly idempotent: number;
  readonly available_at: number;
  readonly lease_token: string | null;
  readonly lease_expires_at: number | null;
  readonly failure_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

const stableHash = (value: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

export const triggerDeliveryBackoffMs = (
  deliveryId: string,
  attempt: number,
): number => {
  const base = Math.min(300_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + (stableHash(`${deliveryId}:${attempt}`) % 401) / 1_000;
  return Math.min(300_000, Math.max(800, Math.round(base * jitter)));
};

const TRIGGER_AUTHORIZATION_RETRY_MS = 5_000;

const timestamp = (epoch: number) => new Date(epoch).toISOString();

export class PluginTriggerDeliveryObject extends DurableObject<Bindings> {
  readonly #sql: SqlStorage;

  constructor(state: DurableObjectState, env: Bindings) {
    super(state, env);
    this.#sql = state.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS trigger_metadata (
        trigger_id TEXT NOT NULL PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS trigger_delivery (
        id TEXT NOT NULL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'in-flight', 'succeeded', 'dead-letter', 'cancelled')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
        available_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at INTEGER,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trigger_delivery_schedule_idx
        ON trigger_delivery (status, available_at, lease_expires_at, created_at, id);
    `);
  }

  async #triggerId(input?: string): Promise<string | undefined> {
    const stored = this.#sql
      .exec<{ trigger_id: string }>(
        "SELECT trigger_id FROM trigger_metadata LIMIT 1",
      )
      .toArray()[0]?.trigger_id;
    if (input === undefined) return stored;
    if (stored !== undefined && stored !== input) return undefined;
    if (stored === undefined) {
      this.#sql.exec(
        "INSERT INTO trigger_metadata (trigger_id) VALUES (?)",
        input,
      );
    }
    return input;
  }

  async #authorization(triggerId: string) {
    return Effect.runPromise(
      Effect.result(
        loadAuthorizedTriggerDelivery(this.env.DB as D1Database, triggerId),
      ),
    );
  }

  #delivery(id: string): DeliveryRow | undefined {
    return this.#sql
      .exec<DeliveryRow>(
        `SELECT id, event_id, idempotency_key, payload_json, status, attempts, idempotent,
                available_at, lease_token, lease_expires_at, failure_code, created_at,
                updated_at
           FROM trigger_delivery WHERE id = ? LIMIT 1`,
        id,
      )
      .toArray()[0];
  }

  #scheduleTime(): number | undefined {
    const row = this.#sql
      .exec<{ scheduled_at: number | null }>(
        `SELECT MIN(scheduled_at) AS scheduled_at FROM (
           SELECT available_at AS scheduled_at
             FROM trigger_delivery WHERE status = 'pending'
           UNION ALL
           SELECT lease_expires_at AS scheduled_at
             FROM trigger_delivery WHERE status = 'in-flight'
         )`,
      )
      .toArray()[0];
    return row?.scheduled_at ?? undefined;
  }

  async #schedule(): Promise<void> {
    const scheduled = this.#scheduleTime();
    if (scheduled === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now(), scheduled));
  }

  #cancelQueued(): void {
    const now = Date.now();
    this.#sql.exec(
      `UPDATE trigger_delivery
          SET status = 'cancelled', payload_json = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              failure_code = 'plugin-disabled',
              updated_at = ?
        WHERE status = 'pending'`,
      now,
    );
  }

  #view(row: DeliveryRow) {
    return {
      id: row.id,
      eventId: row.event_id,
      status: row.status,
      attempts: row.attempts,
      idempotent: row.idempotent === 1,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      ...((row.status === "pending" || row.status === "in-flight") &&
      (row.lease_expires_at ?? row.available_at) > Date.now()
        ? {
            nextAttemptAt: timestamp(row.lease_expires_at ?? row.available_at),
          }
        : {}),
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    };
  }

  #status() {
    const counts = new Map(
      this.#sql
        .exec<{ status: string; count: number }>(
          "SELECT status, COUNT(*) AS count FROM trigger_delivery GROUP BY status",
        )
        .toArray()
        .map(({ status, count }) => [status, count]),
    );
    const deliveries = this.#sql
      .exec<DeliveryRow>(
        `SELECT id, event_id, idempotency_key, payload_json, status, attempts, idempotent,
                available_at, lease_token, lease_expires_at, failure_code, created_at,
                updated_at
           FROM trigger_delivery
          ORDER BY created_at DESC, id DESC LIMIT ?`,
        TRIGGER_HISTORY_LIMIT,
      )
      .toArray()
      .map((row) => this.#view(row));
    return {
      deliverySummary: {
        pending: counts.get("pending") ?? 0,
        inFlight: counts.get("in-flight") ?? 0,
        succeeded: counts.get("succeeded") ?? 0,
        deadLetter: counts.get("dead-letter") ?? 0,
        cancelled: counts.get("cancelled") ?? 0,
      },
      deliveries,
    };
  }

  async #enqueue(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => undefined)) as
      | {
          readonly triggerId?: unknown;
          readonly eventId?: unknown;
          readonly idempotencyKey?: unknown;
          readonly payload?: unknown;
        }
      | undefined;
    if (
      body === undefined ||
      typeof body.triggerId !== "string" ||
      typeof body.eventId !== "string" ||
      typeof body.idempotencyKey !== "string"
    ) {
      return json({ code: "invalid" }, 400);
    }
    const triggerId = await this.#triggerId(body.triggerId);
    if (triggerId === undefined) return json({ code: "invalid" }, 400);
    const authorization = await this.#authorization(triggerId);
    if (Result.isFailure(authorization)) {
      const forbidden =
        authorization.failure instanceof TriggerDeliveryForbidden;
      return json(
        {
          code: forbidden ? authorization.failure.reason : "unavailable",
        },
        forbidden
          ? authorization.failure.reason === "paused"
            ? 409
            : 403
          : 503,
      );
    }
    const payloadJson = JSON.stringify(body.payload);
    const now = Date.now();
    const outcome = this.ctx.storage.transactionSync(() => {
      const duplicate = this.#sql
        .exec<{ id: string }>(
          `SELECT id FROM trigger_delivery
            WHERE event_id = ? OR idempotency_key = ? LIMIT 1`,
          body.eventId as string,
          body.idempotencyKey as string,
        )
        .toArray()[0];
      if (duplicate !== undefined) {
        return { id: duplicate.id, duplicate: true as const };
      }
      const recent = this.#sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM trigger_delivery WHERE created_at >= ?",
          now - 60_000,
        )
        .one().count;
      const pending = this.#sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM trigger_delivery WHERE status IN ('pending', 'in-flight')",
        )
        .one().count;
      if (
        recent >= MAX_TRIGGER_EVENTS_PER_MINUTE ||
        pending >= MAX_TRIGGER_PENDING_DELIVERIES
      ) {
        return { quota: true as const };
      }
      const id = `tdl_${crypto.randomUUID()}`;
      this.#sql.exec(
        `INSERT INTO trigger_delivery (
           id, event_id, idempotency_key, payload_json, status, attempts, idempotent,
           available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        id,
        body.eventId,
        body.idempotencyKey,
        payloadJson,
        authorization.success.trigger.idempotent ? 1 : 0,
        now,
        now,
        now,
      );
      this.#sql.exec(
        `DELETE FROM trigger_delivery WHERE id IN (
           SELECT id FROM trigger_delivery
            WHERE status IN ('succeeded', 'dead-letter', 'cancelled')
            ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET 1000
         )`,
      );
      return { id, duplicate: false as const };
    });
    if ("quota" in outcome) return json({ code: "quota" }, 429);
    await this.#schedule();
    return json(outcome, outcome.duplicate ? 200 : 202);
  }

  async #control(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => undefined)) as
      | { readonly operation?: unknown }
      | undefined;
    if (body?.operation === "pause") {
      await this.ctx.storage.deleteAlarm();
    } else if (body?.operation === "resume") {
      await this.#schedule();
    } else if (body?.operation === "revoke") {
      this.ctx.storage.transactionSync(() => this.#cancelQueued());
      await this.ctx.storage.deleteAlarm();
    } else {
      return json({ code: "invalid" }, 400);
    }
    return json(this.#status());
  }

  async #retry(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => undefined)) as
      | { readonly deliveryId?: unknown }
      | undefined;
    if (typeof body?.deliveryId !== "string")
      return json({ code: "invalid" }, 400);
    const triggerId = await this.#triggerId();
    if (triggerId === undefined) return json({ code: "not-found" }, 404);
    const authorization = await this.#authorization(triggerId);
    if (Result.isFailure(authorization)) {
      return authorization.failure instanceof TriggerDeliveryForbidden
        ? json({ code: "forbidden" }, 409)
        : json({ code: "unavailable" }, 503);
    }
    const retried = this.ctx.storage.transactionSync(() => {
      const current = this.#delivery(body.deliveryId as string);
      if (
        current === undefined ||
        current.status !== "dead-letter" ||
        current.idempotent !== 1 ||
        current.payload_json === null
      ) {
        return false;
      }
      const now = Date.now();
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = 'pending', attempts = 0, available_at = ?,
                lease_token = NULL, lease_expires_at = NULL,
                failure_code = NULL, updated_at = ?
          WHERE id = ?`,
        now,
        now,
        current.id,
      );
      return true;
    });
    if (!retried) return json({ code: "conflict" }, 409);
    await this.#schedule();
    return json(this.#status());
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/enqueue")
      return this.#enqueue(request);
    if (request.method === "GET" && path === "/status")
      return json(this.#status());
    if (request.method === "POST" && path === "/control")
      return this.#control(request);
    if (request.method === "POST" && path === "/retry")
      return this.#retry(request);
    return json({ code: "not-found" }, 404);
  }

  #claim(idempotent: boolean): DeliveryRow | undefined {
    const now = Date.now();
    const maximumAttempts = idempotent ? MAX_TRIGGER_DELIVERY_ATTEMPTS : 1;
    return this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = CASE WHEN attempts >= ? THEN 'dead-letter' ELSE 'pending' END,
                available_at = ?, lease_token = NULL, lease_expires_at = NULL,
                failure_code = 'lease-expired', updated_at = ?
          WHERE status = 'in-flight' AND lease_expires_at <= ?`,
        maximumAttempts,
        now,
        now,
        now,
      );
      const next = this.#sql
        .exec<{ id: string }>(
          `SELECT id FROM trigger_delivery
            WHERE status = 'pending' AND available_at <= ?
            ORDER BY available_at, created_at, id LIMIT 1`,
          now,
        )
        .toArray()[0];
      if (next === undefined) return undefined;
      const leaseToken = crypto.randomUUID();
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = 'in-flight', attempts = attempts + 1,
                lease_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        leaseToken,
        now + TRIGGER_DELIVERY_LEASE_MS,
        now,
        next.id,
      );
      return this.#delivery(next.id);
    });
  }

  async #recordDeliveryAudit(
    triggerId: string,
    ownerUserId: string,
    action: string,
    deliveryId: string,
  ): Promise<void> {
    await this.env.DB?.prepare(
      `INSERT INTO plugin_trigger_audit (
         audit_id, trigger_id, owner_user_id, action, outcome, request_id,
         created_at
       ) VALUES (?, ?, ?, ?, 'success', ?, ?)`,
    )
      .bind(
        `taud_${crypto.randomUUID()}`,
        triggerId,
        ownerUserId,
        action,
        deliveryId,
        new Date().toISOString(),
      )
      .run();
  }

  async alarm(): Promise<void> {
    const triggerId = await this.#triggerId();
    if (triggerId === undefined) return;
    const authorization = await this.#authorization(triggerId);
    if (Result.isFailure(authorization)) {
      if (!(authorization.failure instanceof TriggerDeliveryForbidden)) {
        await this.ctx.storage.setAlarm(
          Date.now() + TRIGGER_AUTHORIZATION_RETRY_MS,
        );
        return;
      }
      if (authorization.failure.reason === "paused") {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      this.ctx.storage.transactionSync(() => this.#cancelQueued());
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const delivery = this.#claim(authorization.success.trigger.idempotent);
    if (delivery === undefined || delivery.payload_json === null) {
      await this.#schedule();
      return;
    }
    if (delivery.lease_expires_at !== null) {
      await this.ctx.storage.setAlarm(delivery.lease_expires_at);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(delivery.payload_json);
    } catch {
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = 'dead-letter', payload_json = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                failure_code = 'execution-limited', updated_at = ?
          WHERE id = ? AND status = 'in-flight' AND lease_token = ?`,
        Date.now(),
        delivery.id,
        delivery.lease_token,
      );
      await this.#schedule();
      return;
    }
    const outcome = await Effect.runPromise(
      Effect.result(
        invokePluginTrigger(
          this.env,
          triggerId,
          delivery.id,
          delivery.event_id,
          delivery.idempotency_key,
          delivery.attempts,
          payload,
        ).pipe(Effect.provide(PluginIsolationLive(this.env))),
      ),
    );
    const currentAuthorization = await this.#authorization(triggerId);
    const now = Date.now();
    let action: string;
    if (Result.isSuccess(outcome)) {
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = 'succeeded', payload_json = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                failure_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'in-flight' AND lease_token = ?`,
        now,
        delivery.id,
        delivery.lease_token,
      );
      action = "plugin_trigger.delivery_succeeded";
    } else if (
      (Result.isFailure(currentAuthorization) &&
        currentAuthorization.failure instanceof TriggerDeliveryForbidden &&
        currentAuthorization.failure.reason !== "paused") ||
      outcome.failure instanceof PluginExecutionForbidden
    ) {
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = 'cancelled', payload_json = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                failure_code = 'plugin-disabled', updated_at = ?
          WHERE id = ? AND status = 'in-flight' AND lease_token = ?`,
        now,
        delivery.id,
        delivery.lease_token,
      );
      action = "plugin_trigger.delivery_cancelled";
    } else {
      const limited = outcome.failure instanceof PluginExecutionLimited;
      const maximumAttempts = delivery.idempotent
        ? MAX_TRIGGER_DELIVERY_ATTEMPTS
        : 1;
      const terminal = delivery.attempts >= maximumAttempts;
      const next =
        now + triggerDeliveryBackoffMs(delivery.id, delivery.attempts);
      this.#sql.exec(
        `UPDATE trigger_delivery
            SET status = ?, available_at = ?, lease_token = NULL,
                lease_expires_at = NULL, failure_code = ?, updated_at = ?
          WHERE id = ? AND status = 'in-flight' AND lease_token = ?`,
        terminal ? "dead-letter" : "pending",
        next,
        limited ? "execution-limited" : "execution-unavailable",
        now,
        delivery.id,
        delivery.lease_token,
      );
      action = terminal
        ? "plugin_trigger.delivery_dead_lettered"
        : "plugin_trigger.delivery_retry_scheduled";
    }
    await this.#recordDeliveryAudit(
      triggerId,
      authorization.success.trigger.ownerUserId,
      action,
      delivery.id,
    ).catch(() => undefined);
    if (
      Result.isSuccess(currentAuthorization) ||
      !(currentAuthorization.failure instanceof TriggerDeliveryForbidden)
    )
      await this.#schedule();
    else await this.ctx.storage.deleteAlarm();
  }
}
