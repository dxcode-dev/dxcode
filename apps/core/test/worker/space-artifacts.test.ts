import { env } from "cloudflare:test";
import type { SpaceArtifactItem } from "@dx/api";
import {
  Principal,
  ProjectRepository,
  type ThreadId,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { recordNewSpace } from "../../src/spaces/repository-d1.js";
import { spaceRoutes } from "../../src/spaces/routes.js";
import {
  createArtifact,
  deleteArtifact,
} from "../../src/thread-artifacts/store.js";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";
import { turnSpacesOn } from "./spaces-flag.js";

/**
 * A Space's Artifacts tab lists the artifacts of the Space and of every
 * thread it started, in workerd with real D1 and R2.
 *
 * Ways it could go wrong: a child's artifacts never list (the bug this
 * fixes); an archived child's artifacts drop out; a deleted child's, or a
 * deleted artifact, still list; a grandchild, or a thread someone else owns
 * under the Space, lists; a member sees the artifacts of a child that is not
 * shared with them; someone outside the Space gets rows instead of 404; the
 * Space's own artifacts are not first, or children are not newest first.
 */

const owner = "space-artifacts-owner" as UserId;
const member = "space-artifacts-member" as UserId;
const outsider = "space-artifacts-outsider" as UserId;
const workspaceId = "space-artifacts-workspace";
const ownerProject = project(
  "prj_00000000-0000-4000-8000-00000000a171",
  owner,
  "storefront",
);
const id = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ThreadId;
const SPACE = id(171);
const ACTIVE_CHILD = id(172);
const ARCHIVED_CHILD = id(173);
const DELETED_CHILD = id(174);
const PRIVATE_CHILD = id(175);
const GRANDCHILD = id(176);
const MEMBERS_THREAD = id(177);
const OTHER_THREAD = id(178);

const bindings: Bindings = { DB: env.DB, DX_STORAGE: env.DX_STORAGE };

const list = async (userId: UserId, spaceId: ThreadId = SPACE) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/v1/spaces", spaceRoutes);
  app.onError(errorHandler);
  const response = await app.request(
    `/v1/spaces/${spaceId}/artifacts`,
    {},
    bindings,
  );
  const body = (await response.json()) as {
    data: { items?: ReadonlyArray<SpaceArtifactItem>; code?: string };
  };
  return { status: response.status, items: body.data.items ?? [] };
};

const write = async (threadId: ThreadId, title: string, now: number) => {
  const created = await createArtifact(bindings, {
    threadId,
    title,
    markdown: `# ${title}\n`,
    writer: { kind: "agent" },
    now,
  });
  if (created.kind !== "saved") throw new Error(`Not saved: ${created.kind}`);
  return created.value.artifact.id;
};

/** What the tab needs from each row, in order. */
const rows = (items: ReadonlyArray<SpaceArtifactItem>) =>
  items.map((item) => ({
    title: item.title,
    thread: item.thread.title,
    archived: item.thread.archived,
  }));

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?1, ?1, ?1 || '@example.com', 1, 1, 1), (?2, ?2, ?2 || '@example.com', 1, 1, 1), (?3, ?3, ?3 || '@example.com', 1, 1, 1)",
    ).bind(owner, member, outsider),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?1, 'Artifacts Team', 'artifacts-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('sa-owner', ?1, ?2, 'owner', 1), ('sa-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      const threads = yield* ThreadRepository;
      const at = (minute: number) =>
        `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
      yield* threads.insert(thread(SPACE, ownerProject.id, owner, at(0)));
      // Children in creation order: the newest lists first.
      yield* threads.insert(
        thread(ARCHIVED_CHILD, ownerProject.id, owner, at(1)),
      );
      yield* threads.insert(
        thread(DELETED_CHILD, ownerProject.id, owner, at(2)),
      );
      yield* threads.insert(
        thread(PRIVATE_CHILD, ownerProject.id, owner, at(3)),
      );
      yield* threads.insert(
        thread(ACTIVE_CHILD, ownerProject.id, owner, at(4)),
      );
      yield* threads.insert(thread(GRANDCHILD, ownerProject.id, owner, at(5)));
      yield* threads.insert(
        thread(MEMBERS_THREAD, ownerProject.id, member, at(6)),
      );
      yield* threads.insert(
        thread(OTHER_THREAD, ownerProject.id, owner, at(7)),
      );
    }),
  );
  // A workspace Space shares its whole family as it is created.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?1 WHERE id IN (?2, ?3, ?4, ?5, ?6)",
    ).bind(
      SPACE,
      ACTIVE_CHILD,
      ARCHIVED_CHILD,
      DELETED_CHILD,
      PRIVATE_CHILD,
      MEMBERS_THREAD,
    ),
    env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?1 WHERE id = ?2",
    ).bind(ACTIVE_CHILD, GRANDCHILD),
    env.DB.prepare(
      `UPDATE threads SET title = CASE id
         WHEN ?1 THEN 'Offsite' WHEN ?2 THEN 'Agenda'
         WHEN ?3 THEN 'Venues' WHEN ?4 THEN 'Budget'
         WHEN ?5 THEN 'Payroll' WHEN ?6 THEN 'Catering' WHEN ?7 THEN 'Mine'
         ELSE 'Elsewhere' END`,
    ).bind(
      SPACE,
      ACTIVE_CHILD,
      ARCHIVED_CHILD,
      DELETED_CHILD,
      PRIVATE_CHILD,
      GRANDCHILD,
      MEMBERS_THREAD,
    ),
  ]);
  await recordNewSpace(env.DB, {
    threadId: SPACE,
    ownerUserId: owner,
    goal: "Plan the offsite.",
    color: "blue",
    workspaceId,
    now: new Date("2026-11-10T10:00:00.000Z"),
  });
  // A workspace Space shares its whole family; the owner then made one
  // child private again.
  await env.DB.prepare(
    `UPDATE threads SET visibility = 'workspace', workspace_access = 'contribute',
            shared_workspace_id = ?1, contribute_until = '9999-12-31T23:59:59.999Z'
      WHERE project_id = ?3 AND id != ?2`,
  )
    .bind(workspaceId, PRIVATE_CHILD, ownerProject.id)
    .run();
});

beforeEach(() => turnSpacesOn([owner, member, outsider]));

describe("a Space's artifacts across its threads", () => {
  it("lists the Space's own and its children's, archived included, deleted never", async () => {
    await write(SPACE, "Offsite summary", 1_000);
    const removed = await write(SPACE, "Old draft", 2_000);
    await write(ACTIVE_CHILD, "Agenda v1", 3_000);
    await write(ACTIVE_CHILD, "Agenda v2", 4_000);
    await write(PRIVATE_CHILD, "Payroll doc", 4_500);
    await write(ARCHIVED_CHILD, "Venue shortlist", 5_000);
    await write(DELETED_CHILD, "Budget sheet", 6_000);
    await write(GRANDCHILD, "Menu", 7_000);
    await write(MEMBERS_THREAD, "My notes", 8_000);
    await write(OTHER_THREAD, "Unrelated", 9_000);
    expect(await deleteArtifact(bindings, SPACE, removed)).toBe(true);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', archived_at = 1 WHERE id = ?1",
    )
      .bind(ARCHIVED_CHILD)
      .run();
    expect(
      await tombstoneThreads(
        env.DB,
        [DELETED_CHILD],
        owner,
        new Date().toISOString(),
      ),
    ).toEqual([DELETED_CHILD]);
    // The tombstone drops the parent; a deleted row that kept it still
    // never lists.
    await env.DB.prepare(
      "UPDATE threads SET parent_thread_id = ?1 WHERE id = ?2",
    )
      .bind(SPACE, DELETED_CHILD)
      .run();

    const owned = await list(owner);
    expect(owned.status).toBe(200);
    expect(rows(owned.items)).toEqual([
      { title: "Offsite summary", thread: "Offsite", archived: false },
      { title: "Agenda v2", thread: "Agenda", archived: false },
      { title: "Agenda v1", thread: "Agenda", archived: false },
      { title: "Payroll doc", thread: "Payroll", archived: false },
      { title: "Venue shortlist", thread: "Venues", archived: true },
    ]);
    expect(owned.items[0]).toMatchObject({
      folder: "",
      updatedAt: 1_000,
      thread: { id: SPACE },
    });
  });

  it("shows a member only the threads shared with them, and refuses outsiders", async () => {
    await write(SPACE, "Offsite summary", 1_000);
    await write(ACTIVE_CHILD, "Agenda v1", 2_000);
    await write(PRIVATE_CHILD, "Payroll doc", 3_000);

    const shared = await list(member);
    expect(shared.status).toBe(200);
    expect(rows(shared.items)).toEqual([
      { title: "Offsite summary", thread: "Offsite", archived: false },
      { title: "Agenda v1", thread: "Agenda", archived: false },
    ]);
    expect((await list(owner)).items.map(({ title }) => title)).toContain(
      "Payroll doc",
    );
    expect(await list(outsider)).toEqual({ status: 404, items: [] });
    // A thread that is not a Space has no Space artifacts.
    expect((await list(owner, ACTIVE_CHILD)).status).toBe(404);
  });
});
