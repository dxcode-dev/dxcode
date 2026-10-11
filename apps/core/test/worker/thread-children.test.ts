import { env } from "cloudflare:test";
import type { CreateThreadResponse } from "@dx/api";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import type { AppEnv } from "../../src/http/types.js";
import { createThreadRoutes } from "../../src/threads/routes.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

interface ListedThread {
  readonly id: string;
  readonly parentThreadId?: string;
  readonly childCount?: number;
  readonly color?: string;
}

const createChild = (
  projectId: string,
  parentThreadId: string,
  app = createProductApp(),
) =>
  app.request(
    "/threads",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ projectId, title: "Child", parentThreadId }),
    },
    bindings,
  );

const list = async (query: string) => {
  const response = await createProductApp().request(
    `/threads?${query}`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ data: { items: ListedThread[] } }>();
  return body.data.items;
};

// The archive route also stops the Orb, which these tests do not run.
const archive = (threadId: string) =>
  env.DB.prepare(
    "UPDATE threads SET lifecycle_state = 'archived', pinned_at = NULL WHERE id = ?",
  )
    .bind(threadId)
    .run();

describe("Child Threads", () => {
  it("records a child's parent and makes a child's child its sibling", async () => {
    const project = await createProjectViaApi("children-nesting");
    const parent = await createThreadViaApi(project.data.id);
    const child = await createChild(project.data.id, parent.data.id);
    expect(child.status).toBe(201);
    const childBody = await child.json<CreateThreadResponse>();
    expect(childBody.data.parentThreadId).toBe(parent.data.id);

    const grandchild = await createChild(project.data.id, childBody.data.id);
    expect(grandchild.status).toBe(201);
    await expect(grandchild.json()).resolves.toMatchObject({
      data: { parentThreadId: parent.data.id },
    });
  });

  it("refuses a parent the requester does not own", async () => {
    const project = await createProjectViaApi("children-owner");
    const parent = await createThreadViaApi(project.data.id);
    const otherProject = await createProductApp(otherPrincipal).request(
      "/projects",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ name: "Other" }),
      },
      bindings,
    );
    const otherProjectId = (await otherProject.json<{ data: { id: string } }>())
      .data.id;
    const response = await createChild(
      otherProjectId,
      parent.data.id,
      createProductApp(otherPrincipal),
    );
    expect(response.status).toBe(400);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE parent_thread_id = ?",
    )
      .bind(parent.data.id)
      .first<number>("count");
    expect(count).toBe(0);
  });

  it("lists roots with child counts and children under their parent while both share a lifecycle state", async () => {
    const project = await createProjectViaApi("children-listing");
    const parent = await createThreadViaApi(project.data.id);
    const first = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const second = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();

    const roots = await list("lifecycleState=active&roots=true");
    expect(roots.map(({ id }) => id)).toEqual([parent.data.id]);
    expect(roots[0]?.childCount).toBe(2);

    const children = await list(
      `lifecycleState=active&parentThreadId=${parent.data.id}`,
    );
    expect(children.map(({ id }) => id).sort()).toEqual(
      [first.data.id, second.data.id].sort(),
    );
    expect(children.every((child) => child.childCount === undefined)).toBe(
      true,
    );

    // Without a tree filter every Thread lists, each naming its parent.
    const flat = await list("lifecycleState=active");
    expect(flat).toHaveLength(3);
    expect(flat.find(({ id }) => id === first.data.id)?.parentThreadId).toBe(
      parent.data.id,
    );

    // An archived child lists as an archived root; its active parent no
    // longer counts it.
    await archive(first.data.id);
    expect((await list("lifecycleState=active&roots=true"))[0]).toMatchObject({
      id: parent.data.id,
      childCount: 1,
    });
    expect(
      (await list("lifecycleState=archived&roots=true")).map(({ id }) => id),
    ).toEqual([first.data.id]);

    // Archiving the parent too nests the archived child under it again,
    // and the active child lists as an active root.
    await archive(parent.data.id);
    expect(await list("lifecycleState=archived&roots=true")).toEqual([
      expect.objectContaining({ id: parent.data.id, childCount: 1 }),
    ]);
    expect(
      (await list("lifecycleState=active&roots=true")).map(({ id }) => id),
    ).toEqual([second.data.id]);
  });

  it("rejects roots combined with a parent filter", async () => {
    const response = await createProductApp().request(
      `/threads?roots=true&parentThreadId=thr_${crypto.randomUUID()}`,
      {},
      bindings,
    );
    expect(response.status).toBe(400);
  });

  it("keeps an explicit title when generateTitle is false", async () => {
    const project = await createProjectViaApi("children-title");
    const titleAgent = vi.fn(async () => undefined);
    const app = new Hono<AppEnv>();
    app.use("*", async (context, next) => {
      context.set("requestId", "children-title");
      context.set("principal", principal);
      await next();
    });
    app.route(
      "/threads",
      createThreadRoutes(
        async () => ({ submissionId: "initial-submission" }),
        titleAgent,
      ),
    );
    app.onError(errorHandler);
    const response = await app.request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          threadId: `thr_${crypto.randomUUID()}`,
          projectId: project.data.id,
          title: "Review the migration",
          generateTitle: false,
          initialMessage: {
            body: "Review the migration for destructive steps",
            attachments: [],
          },
        }),
      },
      {
        ...bindings,
        BYOK_CREDENTIAL_COORDINATOR: env.BYOK_CREDENTIAL_COORDINATOR,
      },
      { waitUntil: vi.fn(), passThroughOnException: () => {}, props: {} },
    );
    expect(response.status).toBe(201);
    const body = await response.json<CreateThreadResponse>();
    expect(body.data.title).toBe("Review the migration");
    expect(body.data).not.toHaveProperty("titlePending");
    expect(titleAgent).not.toHaveBeenCalled();
  });

  it("archives a parent with its children and restores them together", async () => {
    const project = await createProjectViaApi("children-archive-all");
    const parent = await createThreadViaApi(project.data.id);
    const children = await Promise.all(
      [0, 1].map(async () =>
        (
          await createChild(project.data.id, parent.data.id)
        ).json<CreateThreadResponse>(),
      ),
    );
    const archive = (archived: boolean) =>
      createProductApp().request(
        `/threads/${parent.data.id}/archive`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ archived, includeChildren: true }),
        },
        bindings,
      );
    const states = async () =>
      (
        await env.DB.prepare(
          "SELECT id, lifecycle_state FROM threads WHERE id = ? OR parent_thread_id = ? ORDER BY id",
        )
          .bind(parent.data.id, parent.data.id)
          .all<{ id: string; lifecycle_state: string }>()
      ).results.map(({ lifecycle_state }) => lifecycle_state);

    // These tests run no Orbs, so stopping them reports unavailable after
    // every Thread is archived, as for a single Thread.
    expect((await archive(true)).status).toBe(503);
    expect(await states()).toEqual(["archived", "archived", "archived"]);
    expect(await list("lifecycleState=archived&roots=true")).toEqual([
      expect.objectContaining({ id: parent.data.id, childCount: 2 }),
    ]);

    expect((await archive(false)).status).toBe(200);
    expect(await states()).toEqual(["active", "active", "active"]);
    expect(children).toHaveLength(2);
  });

  it("renames and recolors a child through the owner's update route", async () => {
    const project = await createProjectViaApi("children-update");
    const parent = await createThreadViaApi(project.data.id);
    const child = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const response = await createProductApp().request(
      `/threads/${child.data.id}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ title: "Renamed child", color: "green" }),
      },
      bindings,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        title: "Renamed child",
        color: "green",
        parentThreadId: parent.data.id,
      },
    });
    expect(
      await list(`lifecycleState=active&parentThreadId=${parent.data.id}`),
    ).toEqual([
      expect.objectContaining({
        id: child.data.id,
        color: "green",
        parentThreadId: parent.data.id,
      }),
    ]);
  });

  it("lists a pinned child with the pinned roots, out of its parent's list and count", async () => {
    const project = await createProjectViaApi("children-pinned");
    const parent = await createThreadViaApi(project.data.id);
    const child = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const pin = (pinned: boolean) =>
      createProductApp().request(
        `/threads/${child.data.id}/pin`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify({ pinned }),
        },
        bindings,
      );

    expect((await pin(true)).status).toBe(200);
    const roots = await list("lifecycleState=active&roots=true");
    expect(roots.map(({ id }) => id).sort()).toEqual(
      [parent.data.id, child.data.id].sort(),
    );
    expect(roots.find(({ id }) => id === parent.data.id)).not.toHaveProperty(
      "childCount",
    );
    expect(
      await list(`lifecycleState=active&parentThreadId=${parent.data.id}`),
    ).toEqual([]);

    expect((await pin(false)).status).toBe(200);
    expect(
      (await list("lifecycleState=active&roots=true")).map(({ id }) => id),
    ).toEqual([parent.data.id]);
    expect(
      (
        await list(`lifecycleState=active&parentThreadId=${parent.data.id}`)
      ).map(({ id }) => id),
    ).toEqual([child.data.id]);
  });

  it("gives a child its parent's chosen color until it has its own", async () => {
    const project = await createProjectViaApi("children-color");
    const parent = await createThreadViaApi(project.data.id);
    const child = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    expect(child.data).not.toHaveProperty("parentColor");
    await createProductApp().request(
      `/threads/${parent.data.id}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ color: "orange" }),
      },
      bindings,
    );
    const children = await list(
      `lifecycleState=active&parentThreadId=${parent.data.id}`,
    );
    expect(children[0]).toMatchObject({ parentColor: "orange" });
    expect(children[0]).not.toHaveProperty("color");
    const detail = await createProductApp().request(
      `/threads/${child.data.id}`,
      {},
      bindings,
    );
    await expect(detail.json()).resolves.toMatchObject({
      data: { parentColor: "orange", parentThreadId: parent.data.id },
    });
  });

  it("returns the sources of unsettled messages other Threads sent while it worked", async () => {
    const project = await createProjectViaApi("children-inbound");
    const parent = await createThreadViaApi(project.data.id);
    const child = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const now = Date.now();
    await env.DB.batch(
      (
        [
          ["sub_recent", "working", now - 60_000, parent.data.id],
          ["sub_settled", "settled", now - 60_000, parent.data.id],
          ["sub_stale", "working", now - 60 * 60_000, parent.data.id],
          ["sub_owner", "working", now - 60_000, null],
        ] as const
      ).map(([submissionId, state, at, source]) =>
        env.DB.prepare(
          `INSERT INTO thread_activity_submission
             (thread_id, submission_id, state, observed_at, source_thread_id)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          child.data.id,
          submissionId,
          state,
          new Date(at).toISOString(),
          source,
        ),
      ),
    );
    const detail = await createProductApp().request(
      `/threads/${child.data.id}`,
      {},
      bindings,
    );
    const body = await detail.json<{
      data: { inboundMessages?: Array<Record<string, string>> };
    }>();
    expect(body.data.inboundMessages).toEqual([
      {
        submissionId: "sub_recent",
        sourceThreadId: parent.data.id,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("reports the children an archive changed and restores exactly those on undo", async () => {
    const project = await createProjectViaApi("children-archive-undo");
    const parent = await createThreadViaApi(project.data.id);
    const [first, second, earlier] = await Promise.all(
      [0, 1, 2].map(async () =>
        (
          await createChild(project.data.id, parent.data.id)
        ).json<CreateThreadResponse>(),
      ),
    );
    // Archived on its own before the parent's archive.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(earlier?.data.id)
      .run();
    const archive = (body: Record<string, unknown>) =>
      createProductApp().request(
        `/threads/${parent.data.id}/archive`,
        {
          method: "PATCH",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        },
        bindings,
      );
    const archived = await archive({ archived: true, includeChildren: true });
    // These tests run no Orbs, so stopping them reports unavailable after
    // every Thread is archived.
    expect(archived.status).toBe(503);

    const restored = await archive({
      archived: false,
      includeChildren: true,
      childThreadIds: [first?.data.id, second?.data.id],
    });
    expect(restored.status).toBe(200);
    const body = await restored.json<{ changedChildThreadIds: string[] }>();
    expect(body.changedChildThreadIds.sort()).toEqual(
      [first?.data.id, second?.data.id].sort(),
    );
    const state = async (id: string | undefined) =>
      env.DB.prepare("SELECT lifecycle_state FROM threads WHERE id = ?")
        .bind(id)
        .first<string>("lifecycle_state");
    expect(await state(parent.data.id)).toBe("active");
    expect(await state(first?.data.id)).toBe("active");
    expect(await state(second?.data.id)).toBe("active");
    expect(await state(earlier?.data.id)).toBe("archived");
  });

  it("counts and lists only children in projects the owner reaches, and lists a child of an unreachable parent as a root", async () => {
    const project = await createProjectViaApi("children-reach");
    const elsewhere = await createProjectViaApi("children-reach-other");
    const parent = await createThreadViaApi(project.data.id);
    const near = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const far = await (
      await createChild(elsewhere.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    expect(
      (await list("lifecycleState=active&roots=true")).find(
        ({ id }) => id === parent.data.id,
      )?.childCount,
    ).toBe(2);

    // The owner no longer reaches the child's project: it belongs to a
    // workspace they are not an active member of.
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    )
      .bind("org_left", "Left workspace", "left-workspace", 1)
      .run();
    const moveProject = (id: string, workspaceId: string | null) =>
      env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?")
        .bind(workspaceId, id)
        .run();
    await moveProject(elsewhere.data.id, "org_left");
    expect(
      (await list("lifecycleState=active&roots=true")).find(
        ({ id }) => id === parent.data.id,
      )?.childCount,
    ).toBe(1);
    expect(
      (
        await list(`lifecycleState=active&parentThreadId=${parent.data.id}`)
      ).map(({ id }) => id),
    ).toEqual([near.data.id]);

    // The owner reaches the child but no longer its parent's project.
    await moveProject(elsewhere.data.id, null);
    await moveProject(project.data.id, "org_left");
    expect(
      (await list("lifecycleState=active&roots=true")).map(({ id }) => id),
    ).toEqual([far.data.id]);
  });

  it("keeps a child pinned between pages out of later root pages, judged by the pin snapshot", async () => {
    const project = await createProjectViaApi("children-pin-pages");
    const parent = await createThreadViaApi(project.data.id);
    const other = await createThreadViaApi(project.data.id);
    const child = await (
      await createChild(project.data.id, parent.data.id)
    ).json<CreateThreadResponse>();
    const page = async (cursor?: string) => {
      const response = await createProductApp().request(
        `/threads?lifecycleState=active&roots=true&limit=1${
          cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`,
        {},
        bindings,
      );
      expect(response.status).toBe(200);
      return (
        await response.json<{
          data: { items: ListedThread[]; nextCursor?: string };
        }>()
      ).data;
    };
    const first = await page();
    expect(first.nextCursor).toBeDefined();
    await createProductApp().request(
      `/threads/${child.data.id}/pin`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ pinned: true }),
      },
      bindings,
    );
    const second = await page(first.nextCursor);
    const listed = [...first.items, ...second.items].map(({ id }) => id);
    expect(listed.sort()).toEqual([parent.data.id, other.data.id].sort());
  });
});
