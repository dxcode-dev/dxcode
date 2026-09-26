import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { triggerDeliveryBackoffMs } from "../../src/settings/triggers/durable-object.js";
import { setupPluginTrigger } from "./plugin-trigger-fixture.js";

const setup = (idempotent = true) => setupPluginTrigger({ idempotent });

const enqueue = (
  stub: DurableObjectStub,
  triggerId: string,
  eventId: string,
  idempotencyKey = eventId,
) =>
  stub.fetch("https://trigger.invalid/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      triggerId,
      eventId,
      idempotencyKey,
      payload: { accepted: true },
    }),
  });

const status = async (stub: DurableObjectStub) =>
  (await (await stub.fetch("https://trigger.invalid/status")).json()) as {
    deliverySummary: Record<string, number>;
    deliveries: Array<{
      id: string;
      status: string;
      attempts: number;
      failureCode?: string;
    }>;
  };

const seedDelivery = (
  stub: DurableObjectStub,
  triggerId: string,
  options: {
    readonly status?: "pending" | "in-flight";
    readonly attempts?: number;
    readonly leaseToken?: string;
    readonly leaseExpiresAt?: number;
    readonly idempotent?: boolean;
  } = {},
) => {
  const deliveryId = `tdl_${crypto.randomUUID()}`;
  const now = Date.now();
  return runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO trigger_metadata (trigger_id) VALUES (?)",
      triggerId,
    );
    state.storage.sql.exec(
      `INSERT INTO trigger_delivery (
         id, event_id, idempotency_key, payload_json, status, attempts,
         idempotent, available_at, lease_token, lease_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deliveryId,
      `event-${deliveryId}`,
      `intent-${deliveryId}`,
      JSON.stringify({ accepted: true }),
      options.status ?? "pending",
      options.attempts ?? 0,
      options.idempotent === false ? 0 : 1,
      now,
      options.leaseToken ?? null,
      options.leaseExpiresAt ?? null,
      now,
      now,
    );
    await state.storage.setAlarm(Date.now() + 60_000);
  }).then(() => deliveryId);
};

const deferDeliveryAlarm = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_instance, state) => {
    const availableAt = Date.now() + 60_000;
    await state.storage.deleteAlarm();
    state.storage.sql.exec(
      "UPDATE trigger_delivery SET available_at = ? WHERE status = 'pending'",
      availableAt,
    );
    await state.storage.setAlarm(availableAt);
  });

const makeDue = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE trigger_delivery SET available_at = 0 WHERE status = 'pending'",
    );
    await state.storage.setAlarm(Date.now() + 60_000);
  });

describe("plugin trigger durable delivery", () => {
  it("deduplicates either upstream identity and enforces the per-minute quota", async () => {
    const { triggerId, stub } = await setup();
    const first = await enqueue(stub, triggerId, "event-1", "intent-1");
    expect(first.status).toBe(202);
    const firstBody = await first.json<{ id: string }>();
    await deferDeliveryAlarm(stub);
    for (const [eventId, key] of [
      ["event-1", "intent-1"],
      ["event-2", "intent-1"],
      ["event-1", "intent-2"],
    ]) {
      const duplicate = await enqueue(stub, triggerId, eventId, key);
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({
        id: firstBody.id,
        duplicate: true,
      });
    }
    const accepted = await Promise.all(
      Array.from({ length: 59 }, (_, index) =>
        enqueue(stub, triggerId, `event-${index + 2}`, `intent-${index + 2}`),
      ),
    );
    for (const response of accepted) expect(response.status).toBe(202);
    await deferDeliveryAlarm(stub);
    expect(
      (await enqueue(stub, triggerId, "event-61", "intent-61")).status,
    ).toBe(429);
    expect((await status(stub)).deliverySummary.pending).toBe(60);
  });

  it("recovers an expired lease after eviction without losing the attempt", async () => {
    const { triggerId, stub } = await setup();
    await seedDelivery(stub, triggerId, {
      status: "in-flight",
      attempts: 1,
      leaseToken: "abandoned-lease",
      leaseExpiresAt: 0,
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await status(stub)).deliveries[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      failureCode: "execution-unavailable",
    });
  });

  it("backs off deterministically, dead-letters, and guards manual retry", async () => {
    const { triggerId, stub } = await setup();
    await seedDelivery(stub, triggerId);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await makeDue(stub);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    const [deadLetter] = (await status(stub)).deliveries;
    if (deadLetter === undefined) throw new Error("delivery not found");
    expect(deadLetter).toMatchObject({
      status: "dead-letter",
      attempts: 6,
      failureCode: "execution-unavailable",
    });
    const firstBackoff = triggerDeliveryBackoffMs(deadLetter.id, 1);
    const secondBackoff = triggerDeliveryBackoffMs(deadLetter.id, 2);
    const cappedBackoff = triggerDeliveryBackoffMs(deadLetter.id, 20);
    expect(firstBackoff).toBe(triggerDeliveryBackoffMs(deadLetter.id, 1));
    expect(firstBackoff).toBeGreaterThanOrEqual(800);
    expect(firstBackoff).toBeLessThanOrEqual(1_200);
    expect(secondBackoff).toBeGreaterThanOrEqual(1_600);
    expect(secondBackoff).toBeLessThanOrEqual(2_400);
    expect(cappedBackoff).toBeGreaterThanOrEqual(240_000);
    expect(cappedBackoff).toBeLessThanOrEqual(300_000);
    const retried = await stub.fetch("https://trigger.invalid/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: deadLetter.id }),
    });
    expect(retried.status).toBe(200);
    const retriedStatus = (await retried.json()) as Awaited<
      ReturnType<typeof status>
    >;
    expect(retriedStatus.deliveries[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    const nonIdempotent = await setup(false);
    await seedDelivery(nonIdempotent.stub, nonIdempotent.triggerId, {
      idempotent: false,
    });
    expect(await runDurableObjectAlarm(nonIdempotent.stub)).toBe(true);
    const [terminal] = (await status(nonIdempotent.stub)).deliveries;
    if (terminal === undefined) throw new Error("delivery not found");
    expect(terminal).toMatchObject({ status: "dead-letter", attempts: 1 });
    expect(
      (
        await nonIdempotent.stub.fetch("https://trigger.invalid/retry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deliveryId: terminal.id }),
        })
      ).status,
    ).toBe(409);
  });

  it("keeps in-flight state honest across pause and schedules on resume", async () => {
    const { triggerId, stub } = await setup();
    await enqueue(stub, triggerId, "pause-event");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE trigger_delivery
            SET status = 'in-flight', attempts = 1,
                lease_token = 'active-lease', lease_expires_at = ?`,
        Date.now() + 30_000,
      );
    });
    await env.DB.prepare(
      "UPDATE plugin_trigger SET status = 'paused' WHERE id = ?",
    )
      .bind(triggerId)
      .run();
    expect(
      (
        await stub.fetch("https://trigger.invalid/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "pause" }),
        })
      ).status,
    ).toBe(200);
    expect((await status(stub)).deliverySummary.inFlight).toBe(1);
    await env.DB.prepare(
      "UPDATE plugin_trigger SET status = 'active' WHERE id = ?",
    )
      .bind(triggerId)
      .run();
    await stub.fetch("https://trigger.invalid/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "resume" }),
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("cancels queued work after revoke or plugin disable", async () => {
    const revoked = await setup();
    await enqueue(revoked.stub, revoked.triggerId, "revoke-event");
    await revoked.stub.fetch("https://trigger.invalid/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "revoke" }),
    });
    expect((await status(revoked.stub)).deliverySummary.cancelled).toBe(1);

    const disabled = await setup();
    await seedDelivery(disabled.stub, disabled.triggerId);
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(disabled.pluginId)
      .run();
    expect(await runDurableObjectAlarm(disabled.stub)).toBe(true);
    expect((await status(disabled.stub)).deliveries[0]).toMatchObject({
      status: "cancelled",
      failureCode: "plugin-disabled",
    });

    const policyRestricted = await setupPluginTrigger({
      hmacReference: {
        version: 1,
        kind: "environment-variable",
        id: "plugin-trigger-policy-secret",
      },
    });
    await seedDelivery(policyRestricted.stub, policyRestricted.triggerId);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(
        "plugin-trigger-policy-workspace",
        "Trigger policy workspace",
        "trigger-policy",
        1,
      ),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind(
        "plugin-trigger-policy-membership",
        "plugin-trigger-policy-workspace",
        "plugin-trigger-owner",
        1,
      ),
      env.DB.prepare(
        "UPDATE workspace_policy SET allow_personal_secret_overrides = 0 WHERE workspace_id = ?",
      ).bind("plugin-trigger-policy-workspace"),
    ]);
    expect(await runDurableObjectAlarm(policyRestricted.stub)).toBe(true);
    expect((await status(policyRestricted.stub)).deliveries[0]).toMatchObject({
      status: "cancelled",
      failureCode: "plugin-disabled",
    });
  });

  it("retains queued payloads and backs off when authorization storage is unavailable", async () => {
    const { triggerId, stub } = await setup();
    const deliveryId = await seedDelivery(stub, triggerId);
    await env.DB.prepare(
      "ALTER TABLE plugin_trigger RENAME TO plugin_trigger_unavailable",
    ).run();

    try {
      expect((await enqueue(stub, triggerId, "unavailable-event")).status).toBe(
        503,
      );
      expect(
        (
          await stub.fetch("https://trigger.invalid/retry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deliveryId }),
          })
        ).status,
      ).toBe(503);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await status(stub)).deliveries[0]).toMatchObject({
        id: deliveryId,
        status: "pending",
        attempts: 0,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        const row = state.storage.sql
          .exec<{ payload_json: string | null }>(
            "SELECT payload_json FROM trigger_delivery WHERE id = ?",
            deliveryId,
          )
          .one();
        expect(row.payload_json).not.toBeNull();
        const alarm = await state.storage.getAlarm();
        expect(alarm).not.toBeNull();
        expect(alarm as number).toBeGreaterThan(Date.now());
        expect(alarm as number).toBeLessThanOrEqual(Date.now() + 30_000);
      });
    } finally {
      await env.DB.prepare(
        "ALTER TABLE plugin_trigger_unavailable RENAME TO plugin_trigger",
      ).run();
    }
  });
});
