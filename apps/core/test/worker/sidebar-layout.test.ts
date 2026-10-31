import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { sidebarLayoutRoutes } from "../../src/sidebar-layout/routes.js";
import { bindings } from "./product-route-fixture.js";

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  routes.route("/sidebar-layout", sidebarLayoutRoutes);
  routes.onError(errorHandler);
  return routes;
};

interface Entry {
  readonly kind: "thread" | "section";
  readonly id: string;
  readonly open: boolean;
}

const layout = async (userId: UserId) => {
  const response = await app(userId).request("/sidebar-layout", {}, bindings);
  expect(response.status).toBe(200);
  return (await response.json<{ data: { entries: Entry[] } }>()).data.entries;
};

const choose = (userId: UserId, entry: unknown) =>
  app(userId).request(
    "/sidebar-layout",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    },
    bindings,
  );

const threadId = (n: number) =>
  `thr_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = "prj_00000000-0000-4000-8000-0000000005b1";
const byId = (left: Entry, right: Entry) => left.id.localeCompare(right.id);

describe("Sidebar layout", () => {
  it("keeps each person's open parents and sections, and nobody else's", async () => {
    const owner = "sidebar-owner" as UserId;
    const other = "sidebar-other" as UserId;
    expect(await layout(owner)).toEqual([]);

    const opened = await choose(owner, {
      kind: "thread",
      id: threadId(1),
      open: true,
    });
    expect(opened.status).toBe(200);
    // The response is the whole layout, so a client can replace its copy.
    await expect(opened.json()).resolves.toEqual({
      status: "success",
      data: { entries: [{ kind: "thread", id: threadId(1), open: true }] },
    });
    expect(
      (await choose(owner, { kind: "thread", id: threadId(2), open: true }))
        .status,
    ).toBe(200);
    expect(
      (await choose(owner, { kind: "section", id: "inactive", open: true }))
        .status,
    ).toBe(200);
    expect(
      (await choose(owner, { kind: "section", id: projectId, open: false }))
        .status,
    ).toBe(200);
    // Every scope's No Project Threads share one section.
    expect(
      (await choose(owner, { kind: "section", id: "no-project", open: false }))
        .status,
    ).toBe(200);

    expect((await layout(owner)).toSorted(byId)).toEqual(
      [
        { kind: "thread", id: threadId(1), open: true },
        { kind: "thread", id: threadId(2), open: true },
        { kind: "section", id: "inactive", open: true },
        { kind: "section", id: projectId, open: false },
        { kind: "section", id: "no-project", open: false },
      ].toSorted(byId),
    );
    expect(await layout(other)).toEqual([]);

    // Closing a parent returns it to the default; a section remembers
    // being closed, since Project sections default to open.
    expect(
      (await choose(owner, { kind: "thread", id: threadId(1), open: false }))
        .status,
    ).toBe(200);
    expect(
      (await choose(owner, { kind: "section", id: "inactive", open: false }))
        .status,
    ).toBe(200);
    expect((await layout(owner)).toSorted(byId)).toEqual(
      [
        { kind: "thread", id: threadId(2), open: true },
        { kind: "section", id: "inactive", open: false },
        { kind: "section", id: projectId, open: false },
        { kind: "section", id: "no-project", open: false },
      ].toSorted(byId),
    );
  });

  it("refuses an entry that names no Thread or known section", async () => {
    const owner = "sidebar-invalid" as UserId;
    for (const entry of [
      { kind: "thread", id: "not-a-thread", open: true },
      { kind: "section", id: "pinned", open: false },
      { kind: "section", id: threadId(3), open: false },
      { kind: "thread", id: threadId(3) },
      { kind: "project", id: projectId, open: true },
    ]) {
      const response = await choose(owner, entry);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        status: "error",
        data: { code: "INVALID_REQUEST" },
      });
    }
    expect(await layout(owner)).toEqual([]);
  });

  it("keeps each person's sidebar width beside their choices", async () => {
    const owner = "sidebar-width-owner" as UserId;
    const other = "sidebar-width-other" as UserId;
    const read = async (userId: UserId) => {
      const response = await app(userId).request(
        "/sidebar-layout",
        {},
        bindings,
      );
      return (await response.json<{ data: unknown }>()).data;
    };
    // No width until the person resizes the sidebar.
    expect(await read(owner)).toEqual({ entries: [] });

    const resized = await choose(owner, { kind: "width", width: 380 });
    expect(resized.status).toBe(200);
    await expect(resized.json()).resolves.toEqual({
      status: "success",
      data: { entries: [], width: 380 },
    });
    expect(
      (await choose(owner, { kind: "thread", id: threadId(4), open: true }))
        .status,
    ).toBe(200);
    expect((await choose(owner, { kind: "width", width: 412 })).status).toBe(
      200,
    );
    expect(await read(owner)).toEqual({
      entries: [{ kind: "thread", id: threadId(4), open: true }],
      width: 412,
    });
    expect(await read(other)).toEqual({ entries: [] });

    // Outside the sidebar's drag range, or not a whole pixel.
    for (const width of [0, 249, 481, 300.5, "300"]) {
      const response = await choose(owner, { kind: "width", width });
      expect(response.status).toBe(400);
    }
    expect(await read(owner)).toMatchObject({ width: 412 });

    // A stored width the current range rejects falls back to the default.
    await env.DB.prepare(
      "UPDATE sidebar_panel SET width = 1000 WHERE user_id = ?1",
    )
      .bind(owner)
      .run();
    expect(await read(owner)).toEqual({
      entries: [{ kind: "thread", id: threadId(4), open: true }],
    });
  });

  it("keeps whether each person's sidebar is collapsed, apart from its width", async () => {
    const owner = "sidebar-collapsed-owner" as UserId;
    const read = async () =>
      (
        await (
          await app(owner).request("/sidebar-layout", {}, bindings)
        ).json<{ data: unknown }>()
      ).data;

    // Collapsing before ever resizing keeps the default width.
    expect(
      (await choose(owner, { kind: "collapsed", collapsed: true })).status,
    ).toBe(200);
    expect(await read()).toEqual({ entries: [], collapsed: true });

    expect((await choose(owner, { kind: "width", width: 300 })).status).toBe(
      200,
    );
    expect(await read()).toEqual({ entries: [], width: 300, collapsed: true });

    expect(
      (await choose(owner, { kind: "collapsed", collapsed: false })).status,
    ).toBe(200);
    expect(await read()).toEqual({ entries: [], width: 300 });
    expect(
      await app("sidebar-collapsed-other" as UserId)
        .request("/sidebar-layout", {}, bindings)
        .then((response) => response.json<{ data: unknown }>())
        .then((body) => body.data),
    ).toEqual({ entries: [] });

    for (const entry of [
      { kind: "collapsed" },
      { kind: "collapsed", collapsed: "yes" },
      { kind: "collapsed", collapsed: 1 },
    ])
      expect((await choose(owner, entry)).status).toBe(400);
  });

  it("keeps only the newest 500 choices", async () => {
    const owner = "sidebar-pruned" as UserId;
    const old = new Date("2026-01-01T00:00:00.000Z").toISOString();
    await env.DB.batch(
      Array.from({ length: 500 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO sidebar_layout_entry (user_id, kind, item_id, open, updated_at)
           VALUES (?1, 'thread', ?2, 1, ?3)`,
        ).bind(owner, threadId(1_000 + index), old),
      ),
    );
    expect(
      (await choose(owner, { kind: "thread", id: threadId(9), open: true }))
        .status,
    ).toBe(200);
    const entries = await layout(owner);
    expect(entries).toHaveLength(500);
    expect(entries).toContainEqual({
      kind: "thread",
      id: threadId(9),
      open: true,
    });
  });
});
