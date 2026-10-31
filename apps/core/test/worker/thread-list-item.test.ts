import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import {
  sharedThreadRoutes,
  threadMemberRoutes,
  threadSharingRoutes,
} from "../../src/thread-sharing/routes.js";
import { threadRoutes } from "../../src/threads/routes.js";

const owner = "row-owner" as UserId;
const member = "row-member" as UserId;
const outsider = "row-outsider" as UserId;
const workspaceId = "row-workspace";

/** Every D1 statement a request prepares, so a test can count them. */
const counted = { statements: 0 };
const countingDb = new Proxy(env.DB, {
  get(target, property) {
    if (property === "prepare")
      return (query: string) => {
        counted.statements += 1;
        return target.prepare(query);
      };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const bindings: Bindings = {
  DB: countingDb,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const createApp = (userId: UserId) => {
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
  app.route("/projects", projectRoutes);
  app.route("/shared-threads", sharedThreadRoutes);
  app.route("/threads", threadRoutes);
  app.route("/threads", threadSharingRoutes);
  app.use("/threads/:threadId/follow", authorizeThread);
  app.route("/threads", threadMemberRoutes);
  app.onError(errorHandler);
  return app;
};

const send = async (
  userId: UserId,
  path: string,
  method = "GET",
  body?: unknown,
) => {
  const response = await createApp(userId).request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as { data: Record<string, unknown> },
  };
};

type Row = Record<string, unknown> & { readonly id: string };

const roots = async (lifecycleState: "active" | "archived") => {
  const { body } = await send(
    owner,
    `/threads?roots=true&lifecycleState=${lifecycleState}&limit=100`,
  );
  return body.data as { items: Row[]; children: Row[] };
};

/** The row endpoint's answer for one Thread, and the statements it ran. */
const row = async (userId: UserId, threadId: string) => {
  counted.statements = 0;
  const response = await send(userId, `/threads/${threadId}/list-item`);
  return { ...response, statements: counted.statements };
};

const create = async (
  projectId: string,
  body: Record<string, unknown> = {},
) => {
  const response = await send(owner, "/threads", "POST", {
    projectId,
    title: "Row fixture",
    ...body,
  });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
};

beforeEach(async () => {
  const user = (id: string, name: string) =>
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(id, name, `${id}@example.com`);
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Rows', 'rows', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('r-owner', ?1, ?2, 'owner', 1), ('r-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
  ]);
});

describe("Thread list item", () => {
  it("returns each Thread's row exactly as the lists return it, in one statement unless shared", async () => {
    const project = await send(owner, "/projects", "POST", { name: "Rows" });
    const projectId = project.body.data.id as string;
    const parent = await create(projectId);
    const child = await create(projectId, { parentThreadId: parent });
    const archivedParent = await create(projectId);
    const archivedChild = await create(projectId, {
      parentThreadId: archivedParent,
    });
    expect(
      (await send(owner, `/threads/${parent}`, "PATCH", { color: "blue" }))
        .status,
    ).toBe(200);
    // Complete Changes totals for the parent.
    await env.DB.prepare(
      `INSERT INTO thread_changes_state (
         thread_id, mutation_generation, latest_capture_id,
         latest_capture_generation, latest_fingerprint, latest_captured_at,
         dirty_since, updated_at, summary_additions, summary_deletions,
         summary_files
       ) VALUES (?, 1, 'chg_row_fixture', 1, ?, ?, NULL, ?, 12, 4, 2)`,
    )
      .bind(
        parent,
        "a".repeat(64),
        "2026-10-19T12:00:00.000Z",
        "2026-10-19T12:00:00.000Z",
      )
      .run();
    // The archive route also stops the Orb, which this test does not run.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id IN (?, ?)",
    )
      .bind(archivedParent, archivedChild)
      .run();

    const active = await roots("active");
    const listedParent = active.items.find(({ id }) => id === parent);
    const listedChild = active.children.find(({ id }) => id === child);
    expect(listedParent).toMatchObject({
      childCount: 1,
      color: "blue",
      changes: { additions: 12, deletions: 4, files: 2 },
    });
    expect(listedChild).toMatchObject({ parentColor: "blue" });

    const parentRow = await row(owner, parent);
    expect(parentRow.status).toBe(200);
    expect(parentRow.body.data).toEqual(listedParent);
    expect(parentRow.statements).toBe(1);
    // A child's row carries no count: children never list children.
    expect((await row(owner, child)).body.data).toEqual(listedChild);

    const archived = await roots("archived");
    expect((await row(owner, archivedParent)).body.data).toEqual(
      archived.items.find(({ id }) => id === archivedParent),
    );
    expect((await row(owner, archivedChild)).body.data).toEqual(
      archived.children.find(({ id }) => id === archivedChild),
    );

    // A member reads a shared Thread's row only while it is in their
    // shared list: after following it.
    expect(
      (
        await send(owner, `/threads/${parent}/sharing`, "PUT", {
          workspaceAccess: "view",
        })
      ).status,
    ).toBe(200);
    expect((await row(member, parent)).status).toBe(404);
    expect(
      (await send(member, `/threads/${parent}/follow`, "PUT")).status,
    ).toBe(200);
    const shared = (await send(member, "/shared-threads")).body.data
      .items as Row[];
    const memberRow = await row(member, parent);
    expect(memberRow.body.data).toEqual(shared.find(({ id }) => id === parent));
    expect(memberRow.body.data).toMatchObject({ access: "view" });
    expect(memberRow.statements).toBe(2);

    const sharedOwnerRow = await row(owner, parent);
    expect(sharedOwnerRow.body.data).toEqual(
      (await roots("active")).items.find(({ id }) => id === parent),
    );
    expect(sharedOwnerRow.body.data).toMatchObject({
      sharing: { workspaceAccess: "view" },
    });
    expect(sharedOwnerRow.statements).toBe(2);

    expect((await row(outsider, parent)).status).toBe(404);
    expect((await row(member, child)).status).toBe(404);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'deleted' WHERE id = ?",
    )
      .bind(child)
      .run();
    expect((await row(owner, child)).status).toBe(404);

    // For comparison: one roots-list read of these Threads.
    counted.statements = 0;
    await roots("active");
    expect(counted.statements).toBeGreaterThan(5);
  });

  it("marks every No Project Thread, personal and workspace, in the lists and rows", async () => {
    const createProjectless = async () => {
      const response = await send(owner, "/threads", "POST", {
        title: "No Project fixture",
      });
      expect(response.status).toBe(201);
      return response.body.data as { id: string; projectId: string };
    };
    // Before joining the workspace: the owner's personal No Project.
    await env.DB.prepare("DELETE FROM member WHERE userId = ?")
      .bind(owner)
      .run();
    const personal = await createProjectless();
    await env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES ('r-owner', ?, ?, 'owner', 1)`,
    )
      .bind(workspaceId, owner)
      .run();
    const inWorkspace = await createProjectless();
    // Two hidden Projects, one per scope.
    expect(inWorkspace.projectId).not.toBe(personal.projectId);
    const named = await send(owner, "/projects", "POST", { name: "Named" });
    const namedThread = await create(named.body.data.id as string);

    const active = await roots("active");
    const listed = (id: string) => active.items.find((item) => item.id === id);
    expect(listed(personal.id)).toMatchObject({ projectless: true });
    expect(listed(inWorkspace.id)).toMatchObject({ projectless: true });
    expect(listed(namedThread)).not.toHaveProperty("projectless");
    for (const id of [personal.id, inWorkspace.id, namedThread])
      expect((await row(owner, id)).body.data).toEqual(listed(id));

    // A member following a shared No Project Thread sees it marked too.
    expect(
      (
        await send(owner, `/threads/${inWorkspace.id}/sharing`, "PUT", {
          workspaceAccess: "view",
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(member, `/threads/${inWorkspace.id}/follow`, "PUT")).status,
    ).toBe(200);
    const shared = (await send(member, "/shared-threads")).body.data
      .items as Row[];
    expect(shared.find(({ id }) => id === inWorkspace.id)).toMatchObject({
      projectless: true,
    });
    expect((await row(member, inWorkspace.id)).body.data).toEqual(
      shared.find(({ id }) => id === inWorkspace.id),
    );
  });

  it("measures the D1 statements one turn costs a viewer whose sidebar holds 100 roots", async () => {
    const project = await send(owner, "/projects", "POST", { name: "Wide" });
    const projectId = project.body.data.id as string;
    const id = (index: number) =>
      `thr_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const at = (index: number) =>
      new Date(Date.UTC(2026, 9, 19, 9, 0, index)).toISOString();
    const insert = (index: number, parent: string | null) =>
      env.DB.prepare(
        `INSERT INTO threads (id, project_id, owner_user_id, parent_thread_id,
           title, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Wide fixture', ?, ?)`,
      ).bind(id(index), projectId, owner, parent, at(index), at(index));
    await env.DB.batch(
      Array.from({ length: 100 }, (_, index) => insert(index + 1, null)),
    );
    await env.DB.batch(
      Array.from({ length: 100 }, (_, index) =>
        insert(index + 101, id(index + 1)),
      ),
    );

    const statements = async (path: string) => {
      counted.statements = 0;
      const response = await send(owner, path);
      expect(response.status).toBe(200);
      return { body: response.body, statements: counted.statements };
    };
    const list = await statements(
      "/threads?roots=true&lifecycleState=active&limit=100",
    );
    expect((list.body.data.items as Row[]).length).toBe(100);
    expect((list.body.data.children as Row[]).length).toBe(100);
    const shared = await statements("/shared-threads");
    const item = await statements(`/threads/${id(50)}/list-item`);
    // PR 913: two thread.invalidated hints per turn, each of which made
    // every viewer refetch their roots list and shared list.
    const hintsPerTurn = 2;
    await expect(
      `${JSON.stringify(
        {
          scenario:
            "One turn of a Thread, seen by a viewer whose sidebar holds 100 roots with one child each, plus the shared list",
          d1StatementsPerRead: {
            rootsList: list.statements,
            sharedList: shared.statements,
            listItem: item.statements,
          },
          perTurn: {
            hints: hintsPerTurn,
            before: {
              requests: hintsPerTurn * 2,
              d1Statements:
                hintsPerTurn * (list.statements + shared.statements),
              threadRowsReturned: hintsPerTurn * 200,
            },
            after: {
              requests: hintsPerTurn,
              d1Statements: hintsPerTurn * item.statements,
              threadRowsReturned: hintsPerTurn,
            },
          },
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      "../../../../artifacts/sidebar-row-patch/d1-per-turn.json",
    );
  });
});
