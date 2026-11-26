import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  pauseConnectionOrbs,
  sweepIdleDeadlines,
} from "../../src/execution/idle-deadlines.js";
import type { Bindings } from "../../src/http/types.js";
import { sweepPluginServices } from "../../src/plugins/services/lifecycle.js";
import { createTestBindings } from "../../src/testing/bindings.js";

/**
 * Every job that finds Orbs to stop, sleep, or remove, given a plugin Orb
 * (an Orb with no Thread). A gap here leaves an Orb running and billed with
 * nothing pointing at it. Billing settlement, the stop when credit runs
 * out, and a deployment admin's account removal are in a private test;
 * retention, orphan cleanup, and idle stops
 * are the plugin lifecycle sweep here.
 *
 * Ways it could fail: a job's query joins `threads` and skips the plugin
 * Orb; the sweep stops an Orb that still runs a service; it stops one whose
 * payer left without saying why; an Orb whose install is gone keeps
 * running; one no service used for two weeks is kept forever.
 */

const bindings: Bindings = { ...createTestBindings(), DB: env.DB };
/** Each Orb has its own payer, so each is the payer's one shared Orb. */
const payerOf = (n: number) => `usr-sweep-payer-${n}`;
const now = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const orb = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A plugin Orb with a running sandbox pinned to the payer's own key. */
const seedOrb = async (
  n: number,
  fields: {
    readonly state?: string;
    readonly scope?: "personal" | "workspace";
    readonly targetId?: string;
    readonly pluginId?: string | null;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  } = {},
) => {
  const id = orb(n);
  const payer = payerOf(n);
  const created = iso(fields.createdAt ?? now - DAY);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(payer, payer, `${payer}@example.com`),
    env.DB.prepare(
      `INSERT INTO plugin_orb
         (id, scope, target_id, plugin_id, payer_user_id, runner_profile_id,
          chosen_by, keep_running, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'lz.small', 'personal', 0, ?, ?, ?)`,
    ).bind(
      id,
      fields.scope ?? "personal",
      fields.targetId ?? payer,
      fields.pluginId ?? null,
      payer,
      fields.state ?? "active",
      created,
      iso(fields.updatedAt ?? now - DAY),
    ),
    env.DB.prepare(
      `INSERT INTO execution_workspace (thread_id, provider, state, created_at, updated_at)
       VALUES (?, 'lizard', 'uninitialized', ?, ?)`,
    ).bind(id, created, created),
    env.DB.prepare(
      `UPDATE execution_workspace
          SET runner_profile_id = 'lz.small', account_scope = 'personal',
              account_owner_id = ?, provider_account = 'project-1',
              provider_template = 'snap-1'
        WHERE thread_id = ?`,
    ).bind(payer, id),
    env.DB.prepare(
      `UPDATE execution_workspace SET state = 'provisioning', initialization_attempt_id = 'a' WHERE thread_id = ?`,
    ).bind(id),
    env.DB.prepare(
      `UPDATE execution_workspace SET state = 'initialized', provider_sandbox_id = ?, initialization_attempt_id = NULL WHERE thread_id = ?`,
    ).bind(`sbx-${n}`, id),
  ]);
  return id;
};

const state = async (id: string) =>
  (await env.DB.prepare(
    "SELECT state, stopped_reason FROM plugin_orb WHERE id = ?",
  )
    .bind(id)
    .first<{ state: string; stopped_reason: string | null }>()) ?? null;

describe("Orb jobs over a plugin Orb", () => {
  it("the idle-deadline sweep pauses a plugin Orb past its deadline", async () => {
    const id = await seedOrb(1);
    await env.DB.prepare(
      "INSERT INTO orb_idle_deadline (provider_id, sandbox_id, thread_id, deadline_at) VALUES ('lizard', 'sbx-1', ?, ?)",
    )
      .bind(id, now - 1_000)
      .run();
    const pause = vi.fn(async () => undefined);
    expect(await sweepIdleDeadlines(bindings, { lizard: pause }, now)).toBe(1);
    expect(pause).toHaveBeenCalledWith(bindings, "sbx-1", id);
  });

  it("removing a provider key sleeps the plugin Orbs running on it", async () => {
    const id = await seedOrb(2);
    await env.DB.prepare(
      "INSERT INTO orb_idle_deadline (provider_id, sandbox_id, thread_id, deadline_at) VALUES ('lizard', 'sbx-2', ?, ?)",
    )
      .bind(id, now + 60_000)
      .run();
    const pause = vi.fn(async () => undefined);
    expect(
      await pauseConnectionOrbs(
        env.DB,
        { scope: "personal", targetId: payerOf(2), providerId: "lizard" },
        pause,
      ),
    ).toBe(1);
    expect(pause).toHaveBeenCalledWith("sbx-2");
  });

  it("the plugin lifecycle stops, says why, and removes Orbs nothing uses", async () => {
    // 3: no service runs on it: stopped and released, state kept in dx.
    const idle = await seedOrb(3);
    // 4: a workspace Orb whose payer is no longer a member: stopped, saying
    // why (not "nothing runs here", though nothing does either).
    const left = await seedOrb(4, {
      scope: "workspace",
      targetId: "wks-sweep-gone",
    });
    // 5: its own install is gone: removed.
    const orphan = await seedOrb(5, { pluginId: "plg_gone" });
    // 6: no service used it for two weeks: removed (retention).
    const unused = await seedOrb(6, { createdAt: now - 20 * DAY });
    // 7: still runs a service: left alone.
    const busy = await seedOrb(7);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('wks-sweep-gone', 'Sweep', 'sweep', 1)",
      ),
      ...[unused, busy].map((_orb, index) =>
        env.DB.prepare(
          `INSERT INTO trusted_plugin (id, scope, target_id, name, enabled, active_version, health_status, created_at, updated_at, kind)
           VALUES (?, 'personal', ?, ?, 1, '1.0.0', 'unchecked', ?, ?, 'bundle')`,
        ).bind(
          `plg_sweep_${index}`,
          payerOf(index === 0 ? 6 : 7),
          `com.example.sweep-${index}`,
          iso(now),
          iso(now),
        ),
      ),
      env.DB.prepare(
        `INSERT INTO plugin_service (plugin_id, orb_id, status, updated_at)
         VALUES ('plg_sweep_0', ?, 'running', ?), ('plg_sweep_1', ?, 'running', ?)`,
      ).bind(unused, iso(now - 20 * DAY), busy, iso(now - 60_000)),
    ]);
    const work: Array<Promise<unknown>> = [];
    await sweepPluginServices(bindings, new Date(now), (promise) =>
      work.push(promise),
    );
    await Promise.allSettled(work);

    expect(await state(idle)).toEqual({
      state: "stopped",
      stopped_reason: "services-off",
    });
    expect(await state(left)).toEqual({
      state: "stopped",
      stopped_reason: "payer-left",
    });
    // Marked for removal before the provider is called; a removal the
    // provider confirms also deletes the row, one it doesn't is retried.
    for (const id of [orphan, unused])
      expect((await state(id))?.state ?? "removed").toMatch(/removing|removed/);
    expect(await state(busy)).toEqual({
      state: "active",
      stopped_reason: null,
    });
  });
});
