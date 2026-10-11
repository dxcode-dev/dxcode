import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authenticate } from "../../src/auth/authenticate.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { threadRoutes } from "../../src/threads/routes.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
} from "./product-route-fixture.js";

const createAuthenticatedProductApp = () => {
  const productApp = new Hono<AppEnv>();
  productApp.use("*", requestId);
  productApp.use("/v1/*", authenticate);
  productApp.route("/v1/projects", projectRoutes);
  productApp.route("/v1/threads", threadRoutes);
  productApp.onError(errorHandler);
  return productApp;
};

describe("Product route access in workerd with real D1", () => {
  it("rejects requests without a session or API key", async () => {
    const authenticatedApp = createAuthenticatedProductApp();
    const unauthenticated = await authenticatedApp.request(
      "/v1/projects",
      {},
      bindings,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("makes absent and cross-owner resources indistinguishable", async () => {
    const createdProject = await createProjectViaApi();
    const createdThread = await createThreadViaApi(createdProject.data.id);
    const otherApp = createProductApp(otherPrincipal);

    for (const [path, missingPath] of [
      [
        `/projects/${createdProject.data.id}`,
        "/projects/prj_00000000-0000-4000-8000-000000000091",
      ],
      [
        `/threads/${createdThread.data.id}`,
        "/threads/thr_00000000-0000-4000-8000-000000000092",
      ],
    ]) {
      const crossOwner = await otherApp.request(
        path,
        { headers: { "x-request-id": "same-not-found" } },
        bindings,
      );
      const absent = await otherApp.request(
        missingPath,
        { headers: { "x-request-id": "same-not-found" } },
        bindings,
      );
      expect(crossOwner.status).toBe(404);
      expect(await crossOwner.json()).toEqual(await absent.json());
    }

    const unownedCreate = await otherApp.request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          projectId: createdProject.data.id,
          title: "Test thread",
        }),
      },
      bindings,
    );
    const absentCreate = await otherApp.request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          projectId: "prj_00000000-0000-4000-8000-000000000093",
        }),
      },
      bindings,
    );
    expect(unownedCreate.status).toBe(404);
    expect(await unownedCreate.json()).toEqual(await absentCreate.json());
  });

  it("allows the owner to pin and unpin but rejects cross-owner mutation", async () => {
    const createdProject = await createProjectViaApi();
    const createdThread = await createThreadViaApi(createdProject.data.id);
    const path = `/threads/${createdThread.data.id}/pin`;

    const pinned = await createProductApp().request(
      path,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ pinned: true }),
      },
      bindings,
    );
    expect(pinned.status).toBe(200);
    const pinnedBody = await pinned.json<{
      data: { id: string; pinnedAt?: string };
    }>();
    expect(pinnedBody.data.id).toBe(createdThread.data.id);
    expect(pinnedBody.data.pinnedAt).toBeDefined();

    const crossOwner = await createProductApp(otherPrincipal).request(
      path,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ pinned: false }),
      },
      bindings,
    );
    expect(crossOwner.status).toBe(404);

    const unpinned = await createProductApp().request(
      path,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ pinned: false }),
      },
      bindings,
    );
    expect(unpinned.status).toBe(200);
    expect(
      (await unpinned.json<{ data: { pinnedAt?: string } }>()).data.pinnedAt,
    ).toBeUndefined();
  });

  it("lets the owner rename and recolor a Thread, and returns it to auto color", async () => {
    const createdProject = await createProjectViaApi();
    const createdThread = await createThreadViaApi(createdProject.data.id);
    const threadId = createdThread.data.id;
    const path = `/threads/${threadId}`;
    const update = (body: unknown, app = createProductApp()) =>
      app.request(
        path,
        { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) },
        bindings,
      );
    // A generated title is still pending; a rename must end it so the title
    // agent cannot overwrite the owner's name.
    await bindings.DB.prepare(
      "UPDATE threads SET title_pending_until = ? WHERE id = ?",
    )
      .bind(new Date(Date.now() + 60_000).toISOString(), threadId)
      .run();

    const recolored = await update({ color: "green" });
    expect(recolored.status).toBe(200);
    expect(
      (
        await recolored.json<{
          data: { color?: string; titlePending?: boolean };
        }>()
      ).data,
    ).toMatchObject({ color: "green", titlePending: true });

    const renamed = await update({ title: "Port features to 0.2.10" });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json<{
      data: { title: string; color?: string; titlePending?: boolean };
    }>();
    expect(renamedBody.data).toMatchObject({
      title: "Port features to 0.2.10",
      color: "green",
    });
    expect(renamedBody.data.titlePending).toBeUndefined();
    expect(
      await bindings.DB.prepare(
        "SELECT title_pending_until FROM threads WHERE id = ?",
      )
        .bind(threadId)
        .first("title_pending_until"),
    ).toBeNull();

    const listed = await createProductApp().request("/threads", {}, bindings);
    const listedThread = (
      await listed.json<{
        data: { items: ReadonlyArray<{ id: string; color?: string }> };
      }>()
    ).data.items.find((item) => item.id === threadId);
    expect(listedThread?.color).toBe("green");

    const detail = await createProductApp().request(path, {}, bindings);
    expect(
      (await detail.json<{ data: { title: string; color?: string } }>()).data,
    ).toMatchObject({ title: "Port features to 0.2.10", color: "green" });

    expect((await update({ color: "magenta" })).status).toBe(400);
    expect((await update({ title: "" })).status).toBe(400);
    expect(
      (await update({ color: "red" }, createProductApp(otherPrincipal))).status,
    ).toBe(404);

    const auto = await update({ color: null });
    expect(auto.status).toBe(200);
    const autoBody = await auto.json<{
      data: { title: string; color?: string };
    }>();
    expect(autoBody.data.color).toBeUndefined();
    expect(autoBody.data.title).toBe("Port features to 0.2.10");
  });

  it("persists Thread ownership before native routing without runtime side effects", async () => {
    const before = await createProductApp().request(
      "/agents/thr_00000000-0000-4000-8000-0000000000c1",
      {},
      bindings,
    );
    expect(before.status).toBe(404);

    const createdProject = await createProjectViaApi();
    const createdThread = await createThreadViaApi(createdProject.data.id);
    const after = await createProductApp().request(
      `/agents/${createdThread.data.id}`,
      {},
      bindings,
    );
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ native: true });
  });
});
