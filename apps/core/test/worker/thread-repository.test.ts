import { env } from "cloudflare:test";
import {
  PersonalAgentInstructionsSnapshot,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Encoding, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { threadPersistenceLogger } from "../../src/logging.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("owner-a");
const otherOwner = Schema.decodeUnknownSync(UserId)("owner-b");

describe("ThreadRepository D1", () => {
  it("pins the Thread's Orb in the same write, and only once", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-0000000000b4",
      owner,
      "Orb pin",
    );
    const pinned = thread(
      "thr_00000000-0000-4000-8000-0000000000b4",
      entity.id,
      owner,
      "2026-10-04T12:00:00.000Z",
    );
    const invalid = thread(
      "thr_00000000-0000-4000-8000-0000000000b5",
      entity.id,
      owner,
      "2026-10-04T12:00:00.000Z",
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(pinned, undefined, {
          provider: "e2b",
          runnerProfileId: "a1.small",
          credentialScope: "personal",
          credentialOwnerId: owner,
          credentialAccount: "team-a",
          providerTemplate: "dx-orb-0123456789abcdef-a1-small",
        });
        // A personal pin without its account fails the whole write.
        const failed = yield* Effect.flip(
          threads.insert(invalid, undefined, {
            provider: "e2b",
            runnerProfileId: "a1.small",
            credentialScope: "personal",
            credentialOwnerId: owner,
            credentialAccount: null,
            providerTemplate: null,
          }),
        );
        expect(failed._tag).toBe("PersistenceUnavailable");
      }),
    );
    expect(
      await env.DB.prepare(
        `SELECT provider, state, runner_profile_id, account_scope,
                account_owner_id, provider_account, provider_template
           FROM execution_workspace WHERE thread_id = ?`,
      )
        .bind(pinned.id)
        .first(),
    ).toEqual({
      provider: "e2b",
      state: "uninitialized",
      runner_profile_id: "a1.small",
      account_scope: "personal",
      account_owner_id: owner,
      provider_account: "team-a",
      provider_template: "dx-orb-0123456789abcdef-a1-small",
    });
    expect(
      await env.DB.prepare("SELECT id FROM threads WHERE id = ?")
        .bind(invalid.id)
        .first(),
    ).toBeNull();
  });

  it("filters lifecycle before pagination for global and project lists", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000091",
      owner,
      "Archive filter",
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        const rows = [1, 2, 3, 4].map((value) =>
          thread(
            `thr_00000000-0000-4000-8000-00000000009${value}`,
            entity.id,
            owner,
            `2026-08-2${value}T12:00:00.000Z`,
          ),
        );
        for (const row of rows) yield* threads.insert(row);
        for (const row of [rows[0], rows[2]]) {
          if (row)
            yield* threads.setLifecycleStateOwned(row.id, owner, "archived");
        }
        for (const projectId of [undefined, entity.id]) {
          for (const lifecycleState of ["active", "archived"] as const) {
            const first = yield* threads.listOwned(owner, projectId, {
              limit: 1,
              lifecycleState,
            });
            expect(first.items).toHaveLength(1);
            expect(first.items[0]?.lifecycleState).toBe(lifecycleState);
            expect(first.nextCursor).toBeDefined();
            const second = yield* threads.listOwned(owner, projectId, {
              limit: 1,
              lifecycleState,
              cursor: first.nextCursor,
            });
            expect(second.items).toHaveLength(1);
            expect(second.items[0]?.lifecycleState).toBe(lifecycleState);
            expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
            expect(second.nextCursor).toBeUndefined();
          }
        }
        expect(
          (yield* threads.listOwned(otherOwner, undefined, {
            lifecycleState: "archived",
          })).items,
        ).toEqual([]);
        expect(
          (yield* threads.listOwned(owner, entity.id, {})).items,
        ).toHaveLength(4);

        const activePage = yield* threads.listOwned(owner, undefined, {
          limit: 1,
          lifecycleState: "active",
        });
        const mismatchedCursor = yield* Effect.flip(
          threads.listOwned(owner, undefined, {
            limit: 1,
            lifecycleState: "archived",
            cursor: activePage.nextCursor,
          }),
        );
        expect(mismatchedCursor._tag).toBe("InvalidPageCursor");
      }),
    );
  });

  it("persists the resolved instruction snapshot without logging its content", async () => {
    const privateContent = "PRIVATE-THREAD-SNAPSHOT";
    const infoLog = vi
      .spyOn(threadPersistenceLogger, "info")
      .mockImplementation(() => {});
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000014",
      owner,
      "Snapshot",
    );
    const snapshot = Schema.decodeUnknownSync(
      PersonalAgentInstructionsSnapshot,
    )({ content: privateContent, revision: 8, version: 1 });
    const entityThread = thread(
      "thr_00000000-0000-4000-8000-000000000024",
      entity.id,
      owner,
      "2026-08-20T12:00:00.000Z",
      snapshot,
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(entityThread);
        expect(
          yield* threads.findOwnedById(entityThread.id, owner),
        ).toMatchObject({
          title: "Test thread",
          agentInstructions: snapshot,
          selection: {
            kind: "mode",
            profileId: "default",
            mode: "medium",
          },
        });
      }),
    );

    expect(JSON.stringify(infoLog.mock.calls)).not.toContain(privateContent);
    expect(JSON.stringify(entityThread.selection)).not.toMatch(
      /credentialReference|secret|apiKey/i,
    );
    infoLog.mockRestore();
  });

  it("isolates owners and keeps project filters server-side", async () => {
    const errorLog = vi
      .spyOn(threadPersistenceLogger, "error")
      .mockImplementation(() => {});
    const alpha = project(
      "prj_00000000-0000-4000-8000-000000000011",
      owner,
      "Alpha",
    );
    const beta = project(
      "prj_00000000-0000-4000-8000-000000000012",
      owner,
      "Beta",
    );
    const alphaThread = thread(
      "thr_00000000-0000-4000-8000-000000000021",
      alpha.id,
      owner,
    );
    const betaThread = thread(
      "thr_00000000-0000-4000-8000-000000000022",
      beta.id,
      owner,
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(alpha);
        yield* projects.insert(beta);
        yield* threads.insert(alphaThread);
        yield* threads.insert(betaThread);

        expect(
          (yield* threads.listOwned(owner, alpha.id, {})).items.map(
            ({ id }) => id,
          ),
        ).toEqual([alphaThread.id]);
        expect(
          (yield* threads.listOwned(otherOwner, undefined, {})).items,
        ).toEqual([]);
        expect(
          (yield* Effect.flip(
            threads.findOwnedById(alphaThread.id, otherOwner),
          ))._tag,
        ).toBe("ThreadNotFound");
      }),
    );
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("persists pin and unpin mutations and returns the authoritative row", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000015",
      owner,
      "Pinned",
    );
    const target = thread(
      "thr_00000000-0000-4000-8000-000000000025",
      entity.id,
      owner,
    );
    const pinnedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T13:00:00.000Z",
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(target);

        const pinned = yield* threads.setPinnedAtOwned(
          target.id,
          owner,
          pinnedAt,
        );
        expect(pinned.pinnedAt).toEqual(pinnedAt);
        expect(
          (yield* threads.findOwnedById(target.id, owner)).pinnedAt,
        ).toEqual(pinnedAt);

        const unpinned = yield* threads.setPinnedAtOwned(
          target.id,
          owner,
          undefined,
        );
        expect(unpinned.pinnedAt).toBeUndefined();
        expect(
          (yield* threads.findOwnedById(target.id, owner)).pinnedAt,
        ).toBeUndefined();
      }),
    );
  });

  it("does not mutate deleted threads when rejecting pin writes", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000020",
      owner,
      "Deleted",
    );
    const target = thread(
      "thr_00000000-0000-4000-8000-000000000060",
      entity.id,
      owner,
    );
    const deletedAt = "2026-08-20T18:00:00.000Z";
    const pinnedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T19:00:00.000Z",
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(target);
      }),
    );
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'deleted', pinned_at = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(deletedAt, target.id)
      .run();

    const error = await runRepositories(
      Effect.gen(function* () {
        const threads = yield* ThreadRepository;
        return yield* Effect.flip(
          threads.setPinnedAtOwned(target.id, owner, pinnedAt),
        );
      }),
    );

    expect(error._tag).toBe("ThreadNotFound");
    await expect(
      env.DB.prepare(
        "SELECT lifecycle_state, pinned_at, updated_at FROM threads WHERE id = ?",
      )
        .bind(target.id)
        .first(),
    ).resolves.toEqual({
      lifecycle_state: "deleted",
      pinned_at: null,
      updated_at: deletedAt,
    });
  });

  it("archives authoritatively, clears pinning, remains readable, and unarchives", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000019",
      owner,
      "Archived",
    );
    const target = thread(
      "thr_00000000-0000-4000-8000-000000000059",
      entity.id,
      owner,
    );
    const pinnedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T17:00:00.000Z",
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* threads.insert(target);
        yield* threads.setPinnedAtOwned(target.id, owner, pinnedAt);

        const archived = yield* threads.setLifecycleStateOwned(
          target.id,
          owner,
          "archived",
        );
        expect(archived.lifecycleState).toBe("archived");
        expect(archived.pinnedAt).toBeUndefined();
        expect(yield* threads.findOwnedById(target.id, owner)).toMatchObject({
          lifecycleState: "archived",
          pinnedAt: undefined,
        });
        expect(
          (yield* threads.listOwned(owner, entity.id, {})).items,
        ).toMatchObject([{ id: target.id, lifecycleState: "archived" }]);

        const pinError = yield* Effect.flip(
          threads.setPinnedAtOwned(target.id, owner, pinnedAt),
        );
        expect(pinError._tag).toBe("ThreadNotFound");
        expect(yield* threads.findOwnedById(target.id, owner)).toMatchObject({
          lifecycleState: "archived",
          pinnedAt: undefined,
          updatedAt: archived.updatedAt,
        });

        const active = yield* threads.setLifecycleStateOwned(
          target.id,
          owner,
          "active",
        );
        expect(active.lifecycleState).toBe("active");
        expect(active.pinnedAt).toBeUndefined();
      }),
    );
  });

  it("reports invalid cursors without classifying them as storage failures", async () => {
    const errorLog = vi
      .spyOn(threadPersistenceLogger, "error")
      .mockImplementation(() => {});
    const warnLog = vi
      .spyOn(threadPersistenceLogger, "warn")
      .mockImplementation(() => {});

    const error = await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository;
        return yield* Effect.flip(
          repository.listOwned(owner, undefined, { cursor: "not-a-cursor" }),
        );
      }),
    );

    expect(error._tag).toBe("InvalidPageCursor");
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      "Thread persistence rejected invalid input.",
      expect.objectContaining({ outcome: "InvalidPageCursor" }),
    );
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  it("paginates equal timestamps by descending ID", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000013",
      owner,
      "Paged",
    );
    const threads = [3, 1, 2].map((suffix) =>
      thread(
        `thr_00000000-0000-4000-8000-00000000002${suffix}`,
        entity.id,
        owner,
      ),
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const repository = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* Effect.all(threads.map((item) => repository.insert(item)));
        const first = yield* repository.listOwned(owner, entity.id, {
          limit: 2,
        });
        expect(first.items.map(({ id }) => id)).toEqual([
          threads[0]?.id,
          threads[2]?.id,
        ]);
        const second = yield* repository.listOwned(owner, entity.id, {
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(second.items.map(({ id }) => id)).toEqual([threads[1]?.id]);
      }),
    );
  });

  it("orders pinned threads by pin time, then activity and ID, and traverses the unpinned boundary", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000016",
      owner,
      "Pin order",
    );
    const targets = [1, 2, 3, 4, 5].map((suffix) =>
      thread(
        `thr_00000000-0000-4000-8000-00000000003${suffix}`,
        entity.id,
        owner,
        suffix === 1 ? "2026-08-20T14:00:00.000Z" : "2026-08-20T12:00:00.000Z",
      ),
    );
    const earlierPin = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T15:00:00.000Z",
    );
    const laterPin = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T16:00:00.000Z",
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const repository = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* Effect.all(targets.map((item) => repository.insert(item)));
        yield* repository.setPinnedAtOwned(targets[1]!.id, owner, earlierPin);
        yield* repository.setPinnedAtOwned(targets[2]!.id, owner, earlierPin);
        yield* repository.setPinnedAtOwned(targets[3]!.id, owner, laterPin);

        const ids: Array<string> = [];
        let cursor: string | undefined;
        do {
          const page = yield* repository.listOwned(owner, entity.id, {
            limit: 2,
            cursor,
          });
          ids.push(...page.items.map(({ id }) => id));
          cursor = page.nextCursor;
        } while (cursor !== undefined);

        expect(ids).toEqual([
          targets[3]!.id,
          targets[2]!.id,
          targets[1]!.id,
          targets[0]!.id,
          targets[4]!.id,
        ]);
      }),
    );
  });

  it("keeps pin ordering stable for the lifetime of a page cursor", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000017",
      owner,
      "Pin snapshot",
    );
    const targets = [1, 2, 3].map((suffix) =>
      thread(
        `thr_00000000-0000-4000-8000-00000000004${suffix}`,
        entity.id,
        owner,
      ),
    );
    const pinnedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T16:00:00.000Z",
    );
    const [firstTarget, secondTarget, thirdTarget] = targets;
    if (
      firstTarget === undefined ||
      secondTarget === undefined ||
      thirdTarget === undefined
    )
      throw new Error("Expected three pin snapshot fixtures.");

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const repository = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* Effect.all(targets.map((item) => repository.insert(item)));
        const first = yield* repository.listOwned(owner, entity.id, {
          limit: 1,
        });
        yield* repository.setPinnedAtOwned(firstTarget.id, owner, pinnedAt);
        const second = yield* repository.listOwned(owner, entity.id, {
          limit: 2,
          cursor: first.nextCursor,
        });
        expect([
          ...first.items.map(({ id }) => id),
          ...second.items.map(({ id }) => id),
        ]).toEqual([thirdTarget.id, secondTarget.id, firstTarget.id]);
      }),
    );
  });

  it("continues deployed v2 cursors with their activity-only ordering", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000018",
      owner,
      "Legacy cursor",
    );
    const targets = [1, 2, 3].map((suffix) =>
      thread(
        `thr_00000000-0000-4000-8000-00000000005${suffix}`,
        entity.id,
        owner,
      ),
    );
    const [firstTarget, secondTarget, thirdTarget] = targets;
    if (
      firstTarget === undefined ||
      secondTarget === undefined ||
      thirdTarget === undefined
    )
      throw new Error("Expected three legacy cursor fixtures.");
    const pinnedAt = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
      "2026-08-20T16:00:00.000Z",
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const repository = yield* ThreadRepository;
        yield* projects.insert(entity);
        yield* Effect.all(targets.map((item) => repository.insert(item)));
        const first = yield* repository.listOwned(owner, entity.id, {
          limit: 1,
        });
        const position = first.items[0];
        if (position === undefined) throw new Error("Expected a first page.");
        const legacyCursor = Encoding.encodeBase64Url(
          JSON.stringify({
            v: 2,
            snapshotSequence: Number.MAX_SAFE_INTEGER,
            lastActivityAt: Schema.encodeSync(Schema.DateTimeUtcFromString)(
              position.lastActivityAt,
            ),
            id: position.id,
          }),
        );
        yield* repository.setPinnedAtOwned(firstTarget.id, owner, pinnedAt);
        const second = yield* repository.listOwned(owner, entity.id, {
          limit: 1,
          cursor: legacyCursor as never,
        });

        expect(first.items.map(({ id }) => id)).toEqual([thirdTarget.id]);
        expect(second.items.map(({ id }) => id)).toEqual([secondTarget.id]);
        const continued = yield* repository.listOwned(owner, entity.id, {
          limit: 1,
          cursor: second.nextCursor,
        });
        expect(continued.items.map(({ id }) => id)).toEqual([firstTarget.id]);
      }),
    );
  });
});
