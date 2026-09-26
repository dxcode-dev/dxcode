import { env } from "cloudflare:test";
import { ProjectRepository, ThreadRepository } from "@dx/domain";
import type { FlueObservation } from "@flue/runtime";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import { project, thread } from "./fixtures.js";
import { owner } from "./product-route-fixture.js";
import { runRepositories } from "./runtime.js";

const event = (value: Record<string, unknown>) =>
  value as unknown as FlueObservation;

const observe = (value: Record<string, unknown>) =>
  recordFlueThreadActivity(event(value), {
    id: "fixture",
    agentName: "dx",
    env: { DB: env.DB },
  } as never);

describe("Thread activity projection", () => {
  it("tracks only admission and settlement with retry-safe status semantics", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000071",
      owner,
      "Activity",
    );
    const target = thread(
      "thr_00000000-0000-4000-8000-000000000071",
      entity.id,
      owner,
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(target);
      }),
    );

    await observe({
      type: "submission_queued",
      instanceId: target.id,
      submissionId: "sub-1",
      timestamp: "2026-08-20T12:01:00.000Z",
    });
    await observe({
      type: "submission_running",
      instanceId: target.id,
      submissionId: "sub-1",
      timestamp: "2026-08-20T12:02:00.000Z",
    });
    await observe({
      type: "submission_queued",
      instanceId: target.id,
      submissionId: "sub-2",
      timestamp: "2026-08-20T12:03:00.000Z",
    });
    await observe({
      type: "turn",
      instanceId: target.id,
      submissionId: "sub-2",
      timestamp: "2026-08-20T12:04:00.000Z",
    });

    const working = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.findOwnedById(target.id, owner);
      }),
    );
    expect(working.activityStatus).toBe("working");
    expect(DateTime.formatIso(working.lastActivityAt)).toBe(
      "2026-08-20T12:03:00.000Z",
    );

    await observe({
      type: "submission_settled",
      instanceId: target.id,
      submissionId: "sub-1",
      timestamp: "2026-08-20T12:05:00.000Z",
    });
    let current = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.findOwnedById(target.id, owner);
      }),
    );
    expect(current.activityStatus).toBe("working");

    await observe({
      type: "submission_settled",
      instanceId: target.id,
      submissionId: "sub-2",
      timestamp: "2026-08-20T12:06:00.000Z",
    });
    await observe({
      type: "submission_queued",
      instanceId: target.id,
      submissionId: "sub-1",
      timestamp: "2026-08-20T12:07:00.000Z",
    });
    current = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.findOwnedById(target.id, owner);
      }),
    );
    expect(current.activityStatus).toBe("idle");
    expect(DateTime.formatIso(current.lastActivityAt)).toBe(
      "2026-08-20T12:06:00.000Z",
    );
  });

  it("keeps a cursor snapshot complete when an unseen thread becomes active", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000072",
      owner,
      "Snapshot",
    );
    const targets = [0, 1, 2].map((offset) =>
      thread(
        `thr_00000000-0000-4000-8000-00000000007${offset + 2}`,
        entity.id,
        owner,
        `2026-08-20T12:0${2 - offset}:00.000Z`,
      ),
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* Effect.all(targets.map((target) => threads.insert(target)));
      }),
    );
    const first = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.listOwned(owner, entity.id, { limit: 1 });
      }),
    );
    expect(first.items.map(({ id }) => id)).toEqual([targets[0]?.id]);

    await observe({
      type: "submission_queued",
      instanceId: targets[2]?.id,
      submissionId: "sub-reordered",
      timestamp: "2026-08-20T13:00:00.000Z",
    });
    const second = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.listOwned(owner, entity.id, {
          limit: 1,
          cursor: first.nextCursor,
        });
      }),
    );
    const third = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.listOwned(owner, entity.id, {
          limit: 1,
          cursor: second.nextCursor,
        });
      }),
    );
    expect([second.items[0]?.id, third.items[0]?.id]).toEqual([
      targets[1]?.id,
      targets[2]?.id,
    ]);
    const continuedItem = third.items[0];
    if (continuedItem === undefined)
      throw new Error("Missing continuation item.");
    expect(continuedItem.activityStatus).toBe("working");
    expect(DateTime.formatIso(continuedItem.lastActivityAt)).toBe(
      "2026-08-20T12:00:00.000Z",
    );

    const refreshed = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* threads.listOwned(owner, entity.id, { limit: 1 });
      }),
    );
    const refreshedItem = refreshed.items[0];
    if (refreshedItem === undefined) throw new Error("Missing refreshed item.");
    expect(refreshedItem.id).toBe(targets[2]?.id);
    expect(refreshedItem.activityStatus).toBe("working");
    expect(DateTime.formatIso(refreshedItem.lastActivityAt)).toBe(
      "2026-08-20T13:00:00.000Z",
    );
  });
});
