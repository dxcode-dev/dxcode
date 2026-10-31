import { env } from "cloudflare:test";
import type { CreateThreadResponse, GetThreadTreeResponse } from "@dx/api";
import { describe, expect, it } from "vitest";
import { tombstoneThreads } from "../../src/thread-deletion/tombstone.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
  owner,
} from "./product-route-fixture.js";

const createChild = async (projectId: string, parentThreadId: string) => {
  const response = await createProductApp().request(
    "/threads",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ projectId, title: "Child", parentThreadId }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return (await response.json<CreateThreadResponse>()).data;
};

const tree = (threadId: string, app = createProductApp()) =>
  app.request(`/threads/${threadId}/tree`, {}, bindings);

const treeOf = async (threadId: string) => {
  const response = await tree(threadId);
  expect(response.status).toBe(200);
  return (await response.json<GetThreadTreeResponse>()).data;
};

/** Each family member's starter, as the tree reports it. */
const startersOf = (data: GetThreadTreeResponse["data"]) =>
  Object.fromEntries(
    data.items.map((item) => [item.id, item.startedByThreadId ?? null]),
  );

const setLifecycle = async (
  threadIds: readonly string[],
  lifecycleState: "active" | "archived",
) => {
  for (const id of threadIds)
    await env.DB.prepare("UPDATE threads SET lifecycle_state = ? WHERE id = ?")
      .bind(lifecycleState, id)
      .run();
};

describe("Thread family tree", () => {
  it("records which Thread started each one while the family keeps its root", async () => {
    const project = await createProjectViaApi("tree-starter");
    const root = await createThreadViaApi(project.data.id);
    const child = await createChild(project.data.id, root.data.id);
    const grandchild = await createChild(project.data.id, child.id);
    const greatGrandchild = await createChild(project.data.id, grandchild.id);

    expect(root.data).not.toHaveProperty("startedByThreadId");
    expect(child).toMatchObject({
      parentThreadId: root.data.id,
      startedByThreadId: root.data.id,
    });
    expect(grandchild).toMatchObject({
      parentThreadId: root.data.id,
      startedByThreadId: child.id,
    });
    expect(greatGrandchild).toMatchObject({
      parentThreadId: root.data.id,
      startedByThreadId: grandchild.id,
    });
  });

  it("returns the whole family from any member, each with its starter", async () => {
    const project = await createProjectViaApi("tree-read");
    const root = await createThreadViaApi(project.data.id);
    const unrelated = await createThreadViaApi(project.data.id);
    const child = await createChild(project.data.id, root.data.id);
    const sibling = await createChild(project.data.id, root.data.id);
    const grandchild = await createChild(project.data.id, child.id);

    const expected = {
      [root.data.id]: null,
      [child.id]: root.data.id,
      [sibling.id]: root.data.id,
      [grandchild.id]: child.id,
    };
    for (const member of [root.data.id, child.id, grandchild.id]) {
      const data = await treeOf(member);
      expect(data.rootThreadId).toBe(root.data.id);
      expect(startersOf(data)).toEqual(expected);
      expect(data.items.map(({ id }) => id)).not.toContain(unrelated.data.id);
      expect(data).not.toHaveProperty("truncated");
    }

    // A Thread without children is a family of one.
    const lone = await treeOf(unrelated.data.id);
    expect(lone.rootThreadId).toBe(unrelated.data.id);
    expect(lone.items.map(({ id }) => id)).toEqual([unrelated.data.id]);
  });

  it("lists only active members besides the root and the viewed Thread, and drops deleted ones", async () => {
    const project = await createProjectViaApi("tree-lifecycle");
    const root = await createThreadViaApi(project.data.id);
    const lead = await createChild(project.data.id, root.data.id);
    const archived = await createChild(project.data.id, lead.id);
    const worker = await createChild(project.data.id, archived.id);
    const done = await createChild(project.data.id, root.data.id);
    await setLifecycle([archived.id, done.id], "archived");

    // Archived children leave the tree; what they started stays, naming its
    // starter, so the page lists it under the root.
    const active = await treeOf(root.data.id);
    expect(startersOf(active)).toEqual({
      [root.data.id]: null,
      [lead.id]: root.data.id,
      [worker.id]: archived.id,
    });
    // The sidebar counts only the active children too.
    const listed = await roots();
    expect(shape(listed.items)).toContainEqual({
      id: root.data.id,
      childCount: 2,
    });
    expect(shape(await childrenOf(root.data.id))).toEqual(
      shape([{ id: lead.id }, { id: worker.id }]),
    );

    // The Thread being viewed shows even when archived.
    expect(Object.keys(startersOf(await treeOf(archived.id))).sort()).toEqual(
      [root.data.id, lead.id, archived.id, worker.id].sort(),
    );

    // An archived root still heads its active children.
    await setLifecycle([root.data.id], "archived");
    const headless = await treeOf(lead.id);
    expect(headless.rootThreadId).toBe(root.data.id);
    expect(
      Object.fromEntries(
        headless.items.map(({ id, lifecycleState }) => [id, lifecycleState]),
      ),
    ).toEqual({
      [root.data.id]: "archived",
      [lead.id]: "active",
      [worker.id]: "active",
    });
    await setLifecycle([root.data.id], "active");

    expect(
      await tombstoneThreads(
        env.DB,
        [lead.id],
        owner,
        new Date().toISOString(),
      ),
    ).toEqual([lead.id]);
    expect(startersOf(await treeOf(root.data.id))).toEqual({
      [root.data.id]: null,
      [worker.id]: archived.id,
    });
    expect((await tree(lead.id)).status).toBe(404);
  });

  it("lists a Thread started before starters were recorded under its root", async () => {
    const project = await createProjectViaApi("tree-legacy");
    const root = await createThreadViaApi(project.data.id);
    const legacy = await createChild(project.data.id, root.data.id);
    await env.DB.prepare(
      "UPDATE threads SET started_by_thread_id = NULL WHERE id = ?",
    )
      .bind(legacy.id)
      .run();
    expect(startersOf(await treeOf(legacy.id))).toEqual({
      [root.data.id]: null,
      [legacy.id]: null,
    });
  });

  it("hides another owner's family and rejects a malformed id", async () => {
    const project = await createProjectViaApi("tree-access");
    const root = await createThreadViaApi(project.data.id);
    await createChild(project.data.id, root.data.id);
    const other = await tree(root.data.id, createProductApp(otherPrincipal));
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toMatchObject({
      data: { code: "THREAD_NOT_FOUND" },
    });
    expect((await tree(`thr_${crypto.randomUUID()}`)).status).toBe(404);
    expect((await tree("not-a-thread")).status).toBe(400);
  });
});

interface Row {
  readonly id: string;
  readonly childCount?: number;
  readonly startedCount?: number;
}

const roots = async () => {
  const response = await createProductApp().request(
    "/threads?lifecycleState=active&roots=true",
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: { items: Row[]; children: Row[] } }>())
    .data;
};

const childrenOf = async (parentThreadId: string) => {
  const response = await createProductApp().request(
    `/threads?lifecycleState=active&parentThreadId=${parentThreadId}`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: { items: Row[] } }>()).data.items;
};

const listItem = async (threadId: string) => {
  const response = await createProductApp().request(
    `/threads/${threadId}/list-item`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: Row }>()).data;
};

/** Each listed Thread's id with its counts, sorted by id. */
const shape = (rows: ReadonlyArray<Row>) =>
  rows
    .map(({ id, childCount, startedCount }) => ({
      id,
      ...(childCount === undefined ? {} : { childCount }),
      ...(startedCount === undefined ? {} : { startedCount }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

const setPinned = (threadId: string, pinned: boolean) =>
  createProductApp().request(
    `/threads/${threadId}/pin`,
    {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ pinned }),
    },
    bindings,
  );

describe("The sidebar lists a root's direct children", () => {
  /**
   * root ─ lead ─ owner ─ worker
   *      └ legacy (no starter recorded)
   */
  const family = async (name: string) => {
    const project = await createProjectViaApi(name);
    const root = (await createThreadViaApi(project.data.id)).data;
    const lead = await createChild(project.data.id, root.id);
    const issueOwner = await createChild(project.data.id, lead.id);
    const worker = await createChild(project.data.id, issueOwner.id);
    const legacy = await createChild(project.data.id, root.id);
    await env.DB.prepare(
      "UPDATE threads SET started_by_thread_id = NULL WHERE id = ?",
    )
      .bind(legacy.id)
      .run();
    return { root, lead, issueOwner, worker, legacy };
  };

  it("counts on each child the Threads below it that the sidebar does not list", async () => {
    const { root, lead, issueOwner, legacy } = await family("tree-sidebar");
    const listed = await roots();
    // The root counts its whole family: two listed, two under the lead.
    expect(shape(listed.items)).toEqual([{ id: root.id, childCount: 4 }]);
    expect(shape(listed.children)).toEqual(
      shape([{ id: lead.id, startedCount: 2 }, { id: legacy.id }]),
    );
    // Paging a root's children returns the same rows.
    expect(shape(await childrenOf(root.id))).toEqual(shape(listed.children));
    // A refreshed row carries the same count.
    expect(await listItem(lead.id)).toMatchObject({ startedCount: 2 });
    expect(await listItem(issueOwner.id)).toMatchObject({ startedCount: 1 });
    expect(await listItem(legacy.id)).not.toHaveProperty("startedCount");
  });

  it("lists a Thread under the root while its starter is pinned or in the other lifecycle state", async () => {
    const { root, lead, issueOwner, worker, legacy } =
      await family("tree-sidebar-moves");
    // A pinned lead lists with the pinned Threads; what it started moves up.
    expect((await setPinned(lead.id, true)).status).toBe(200);
    expect(shape((await roots()).children)).toEqual(
      shape([{ id: issueOwner.id, startedCount: 1 }, { id: legacy.id }]),
    );
    expect((await setPinned(lead.id, false)).status).toBe(200);

    // An archived issue owner lists in the archive; its worker moves up.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(issueOwner.id)
      .run();
    const listed = await roots();
    expect(shape(listed.items)).toEqual([{ id: root.id, childCount: 3 }]);
    expect(shape(listed.children)).toEqual(
      shape([{ id: lead.id }, { id: worker.id }, { id: legacy.id }]),
    );
  });
});
