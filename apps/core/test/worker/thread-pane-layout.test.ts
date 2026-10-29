import { env } from "cloudflare:test";
import type { ThreadPaneLayout } from "@dx/api";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { threadPaneLayoutRoutes } from "../../src/threads/pane-layout-route.js";
import {
  bindings,
  createProjectViaApi,
  createThreadViaApi,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

const app = (requestPrincipal = principal) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  routes.route("/threads", threadPaneLayoutRoutes);
  routes.onError(errorHandler);
  return routes;
};

const read = async (threadId: string, who = principal) => {
  const response = await app(who).request(
    `/threads/${threadId}/layout`,
    {},
    bindings,
  );
  return {
    status: response.status,
    body: await response.json<{
      data: { layout?: ThreadPaneLayout | null; code?: string };
    }>(),
  };
};

const write = async (threadId: string, layout: unknown, who = principal) =>
  app(who).request(
    `/threads/${threadId}/layout`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof layout === "string" ? layout : JSON.stringify(layout),
    },
    bindings,
  );

const layout: ThreadPaneLayout = {
  version: 1,
  focused: "p2",
  nextPane: 3,
  nextTerminal: 2,
  root: {
    kind: "split",
    id: "s1",
    direction: "row",
    sizes: [0.6, 0.4],
    children: [
      { kind: "pane", id: "p1", tabs: [{ kind: "agent" }], active: 0 },
      {
        kind: "pane",
        id: "p2",
        active: 2,
        tabs: [
          { kind: "files" },
          { kind: "terminal", ordinal: 1 },
          {
            kind: "file",
            target: {
              kind: "workspace",
              worktree: "primary",
              path: "src/index.ts",
            },
          },
        ],
      },
    ],
  },
} as ThreadPaneLayout;

describe("Thread pane layout", () => {
  it("is null until saved, then round-trips per person", async () => {
    const project = await createProjectViaApi("Layout");
    const thread = await createThreadViaApi(project.data.id);

    expect(await read(thread.data.id)).toMatchObject({
      status: 200,
      body: { data: { layout: null } },
    });

    const saved = await write(thread.data.id, layout);
    expect(saved.status).toBe(200);
    expect(
      (await saved.json<{ data: { layout: ThreadPaneLayout } }>()).data.layout,
    ).toEqual(layout);
    expect((await read(thread.data.id)).body.data.layout).toEqual(layout);

    // A second save replaces the first.
    const next = { ...layout, focused: "p1" };
    expect((await write(thread.data.id, next)).status).toBe(200);
    expect((await read(thread.data.id)).body.data.layout).toEqual(next);

    // Another person has no access to this Thread, so neither its layout.
    expect((await read(thread.data.id, otherPrincipal)).status).toBe(404);
    expect((await write(thread.data.id, layout, otherPrincipal)).status).toBe(
      404,
    );
  });

  it("rejects a layout the schema does not accept", async () => {
    const project = await createProjectViaApi("Layout");
    const thread = await createThreadViaApi(project.data.id);
    for (const bad of [
      "not json",
      { ...layout, version: 2 },
      { ...layout, root: { kind: "pane", id: "p1", tabs: [], active: "0" } },
      {
        ...layout,
        root: {
          kind: "pane",
          id: "p1",
          active: 0,
          tabs: [
            {
              kind: "file",
              target: { kind: "workspace", worktree: "primary", path: "../x" },
            },
          ],
        },
      },
      { ...layout, root: { ...layout.root, sizes: [0.5] } },
    ]) {
      const response = await write(thread.data.id, bad);
      expect(response.status).toBe(400);
    }
    expect((await read(thread.data.id)).body.data.layout).toBeNull();
  });

  it("treats a stored row the schema rejects as none", async () => {
    const project = await createProjectViaApi("Layout");
    const thread = await createThreadViaApi(project.data.id);
    await env.DB.prepare(
      `INSERT INTO thread_pane_layout (thread_id, user_id, layout, updated_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(
        thread.data.id,
        principal.userId,
        JSON.stringify({ version: 0 }),
        new Date().toISOString(),
      )
      .run();
    expect((await read(thread.data.id)).body.data.layout).toBeNull();
  });
});
