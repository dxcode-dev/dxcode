import { env } from "cloudflare:test";
import type { ThreadId } from "@dx/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

/**
 * Snooze through Core's routes and real D1. The ways it could fail:
 *
 * 1. A wake time in the past, now, or over a year out is stored.
 * 2. An archived Thread, or a child Thread (which follows its parent), snoozes.
 * 3. Someone other than the owner snoozes or wakes the Thread.
 * 4. The snooze is missing from the sidebar's list, its one-row refresh, or
 *    Thread detail, so clients cannot place the Thread.
 * 5. Waking leaves the snooze behind, or does not record when it ended (the
 *    sidebar's Inactive rule counts from then).
 * 6. Pinning leaves a Thread asleep; unpinning wakes it.
 * 7. Archiving keeps the snooze, so unarchiving brings back a hidden Thread.
 * 8. A message someone sends leaves the Thread asleep, or a message another
 *    Thread's agent sends wakes it.
 */

const HOUR_MS = 60 * 60 * 1_000;

const patch = (threadId: string, path: string, body: unknown, as = principal) =>
  createProductApp(as).request(
    `/threads/${threadId}${path}`,
    { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) },
    bindings,
  );

const snooze = (
  threadId: string,
  snoozedUntil: string | null,
  as = principal,
) => patch(threadId, "/snooze", { snoozedUntil }, as);

const row = (threadId: string) =>
  env.DB.prepare(
    "SELECT snoozed_until, snoozed_at, snooze_woke_at, pinned_at FROM threads WHERE id = ?",
  )
    .bind(threadId)
    .first<{
      snoozed_until: string | null;
      snoozed_at: string | null;
      snooze_woke_at: string | null;
      pinned_at: string | null;
    }>();

const json = async (response: Response) =>
  (await response.json()) as {
    status: string;
    data: Record<string, unknown> & {
      items?: Array<Record<string, unknown>>;
      code?: string;
    };
  };

/** The agent route behind dx's admission, with Flue answering 202. */
const agentApp = (sourceThreadId?: ThreadId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", principal);
    if (sourceThreadId !== undefined)
      context.set("messageSourceThreadId", sourceThreadId);
    await next();
  });
  const flue = new Hono<AppEnv>();
  flue.post("/:threadId", (context) =>
    context.json({ submissionId: "sub-1" }, 202),
  );
  routes.route(
    "/v1/agents/dx",
    useAgentAdmission(new Hono<AppEnv>()).route("/", flue),
  );
  routes.onError(errorHandler);
  return routes;
};

const sendMessage = (threadId: string, sourceThreadId?: ThreadId) =>
  agentApp(sourceThreadId).request(
    `/v1/agents/dx/${threadId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user",
        body: "Any update?",
        idempotencyKey: crypto.randomUUID(),
      }),
    },
    bindings,
  );

describe("Thread snooze in workerd with real D1", () => {
  it("refuses wake times that are not ahead, within a year", async () => {
    const project = await createProjectViaApi("snooze-times");
    const thread = await createThreadViaApi(project.data.id);
    const now = Date.now();
    for (const at of [now - HOUR_MS, now, now + 367 * 24 * HOUR_MS]) {
      const response = await snooze(thread.data.id, new Date(at).toISOString());
      expect(response.status).toBe(400);
      expect((await json(response)).data.code).toBe("INVALID_SNOOZE_TIME");
    }
    expect((await snooze(thread.data.id, "tomorrow")).status).toBe(400);
    expect((await row(thread.data.id))?.snoozed_until).toBeNull();
  });

  it("refuses archived and child Threads and other people", async () => {
    const project = await createProjectViaApi("snooze-refusals");
    const parent = await createThreadViaApi(project.data.id);
    const child = await createThreadViaApi(project.data.id);
    await env.DB.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?")
      .bind(parent.data.id, child.data.id)
      .run();
    const wakeAt = new Date(Date.now() + HOUR_MS).toISOString();

    const childSnooze = await snooze(child.data.id, wakeAt);
    expect(childSnooze.status).toBe(409);
    expect((await json(childSnooze)).data.code).toBe(
      "THREAD_SNOOZE_UNAVAILABLE",
    );

    const stranger = await snooze(parent.data.id, wakeAt, otherPrincipal);
    expect(stranger.status).toBe(404);
    expect((await row(parent.data.id))?.snoozed_until).toBeNull();

    // In tests the Orb cannot be paused (503), but the archive commits.
    await patch(parent.data.id, "/archive", { archived: true });
    const archived = await snooze(parent.data.id, wakeAt);
    expect(archived.status).toBe(409);
    expect((await row(parent.data.id))?.snoozed_until).toBeNull();
  });

  it("stores the snooze, returns it everywhere the sidebar reads, and wakes", async () => {
    const project = await createProjectViaApi("snooze-round-trip");
    const thread = await createThreadViaApi(project.data.id);
    const wakeAt = new Date(Date.now() + 3 * HOUR_MS).toISOString();

    const snoozed = await snooze(thread.data.id, wakeAt);
    expect(snoozed.status).toBe(200);
    expect((await json(snoozed)).data).toMatchObject({
      id: thread.data.id,
      snoozedUntil: wakeAt,
    });
    const stored = await row(thread.data.id);
    expect(stored?.snoozed_until).toBe(wakeAt);
    expect(stored?.snoozed_at).not.toBeNull();

    const list = await json(
      await createProductApp().request(
        `/threads?projectId=${project.data.id}&lifecycleState=active&roots=true`,
        {},
        bindings,
      ),
    );
    expect(
      list.data.items?.find(({ id }) => id === thread.data.id),
    ).toMatchObject({ snoozedUntil: wakeAt });
    const listItem = await json(
      await createProductApp().request(
        `/threads/${thread.data.id}/list-item`,
        {},
        bindings,
      ),
    );
    expect(listItem.data).toMatchObject({ snoozedUntil: wakeAt });
    const detail = await json(
      await createProductApp().request(
        `/threads/${thread.data.id}`,
        {},
        bindings,
      ),
    );
    expect(detail.data).toMatchObject({ snoozedUntil: wakeAt });

    const before = Date.now();
    const woken = await snooze(thread.data.id, null);
    expect(woken.status).toBe(200);
    const wokenData = (await json(woken)).data;
    expect(wokenData.snoozedUntil).toBeUndefined();
    expect(Date.parse(String(wokenData.snoozeWokeAt))).toBeGreaterThanOrEqual(
      before - 1_000,
    );
    expect(await row(thread.data.id)).toMatchObject({
      snoozed_until: null,
      snoozed_at: null,
    });
  });

  it("wakes on pin but not unpin, and archiving drops the snooze", async () => {
    const project = await createProjectViaApi("snooze-pin-archive");
    const thread = await createThreadViaApi(project.data.id);
    const wakeAt = () => new Date(Date.now() + HOUR_MS).toISOString();

    await patch(thread.data.id, "/pin", { pinned: true });
    await snooze(thread.data.id, wakeAt());
    // A snooze keeps the pin for when the Thread wakes.
    expect((await row(thread.data.id))?.pinned_at).not.toBeNull();
    await patch(thread.data.id, "/pin", { pinned: false });
    expect((await row(thread.data.id))?.snoozed_until).not.toBeNull();
    await patch(thread.data.id, "/pin", { pinned: true });
    expect(await row(thread.data.id)).toMatchObject({ snoozed_until: null });
    expect((await row(thread.data.id))?.snooze_woke_at).not.toBeNull();

    await snooze(thread.data.id, wakeAt());
    await patch(thread.data.id, "/archive", { archived: true });
    await patch(thread.data.id, "/archive", { archived: false });
    expect(await row(thread.data.id)).toMatchObject({
      snoozed_until: null,
      snoozed_at: null,
    });
  });

  it("wakes when someone sends a message, not when another Thread's agent does", async () => {
    const project = await createProjectViaApi("snooze-messages");
    const thread = await createThreadViaApi(project.data.id);
    const sender = await createThreadViaApi(project.data.id);
    const wakeAt = new Date(Date.now() + HOUR_MS).toISOString();
    await snooze(thread.data.id, wakeAt);

    expect((await sendMessage(thread.data.id, sender.data.id)).status).toBe(
      202,
    );
    expect((await row(thread.data.id))?.snoozed_until).toBe(wakeAt);

    expect((await sendMessage(thread.data.id)).status).toBe(202);
    expect(await row(thread.data.id)).toMatchObject({ snoozed_until: null });
    expect((await row(thread.data.id))?.snooze_woke_at).not.toBeNull();
  });
});
