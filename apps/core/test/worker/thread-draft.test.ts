import { env } from "cloudflare:test";
import { THREAD_DRAFT_MAX_LENGTH } from "@dx/api";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { threadDraftRoutes } from "../../src/threads/thread-draft-route.js";
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
  routes.route("/threads", threadDraftRoutes);
  routes.onError(errorHandler);
  return routes;
};

const read = async (threadId: string, who = principal) => {
  const response = await app(who).request(
    `/threads/${threadId}/draft`,
    {},
    bindings,
  );
  return {
    status: response.status,
    text: (await response.json<{ data: { text?: string } }>()).data.text,
  };
};

const write = (threadId: string, body: unknown, who = principal) =>
  app(who).request(
    `/threads/${threadId}/draft`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );

/** One of a Thread's boxes besides its composer, as `?slot=` names it. */
const box = (threadId: string, slot: string) => ({
  read: async () => {
    const response = await app().request(
      `/threads/${threadId}/draft?slot=${encodeURIComponent(slot)}`,
      {},
      bindings,
    );
    return {
      status: response.status,
      text: (await response.json<{ data: { text?: string } }>()).data.text,
    };
  },
  write: (text: string) =>
    app().request(
      `/threads/${threadId}/draft?slot=${encodeURIComponent(slot)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
      bindings,
    ),
});

const rows = (threadId: string) =>
  env.DB.prepare(
    `SELECT COUNT(*) AS count FROM thread_draft WHERE thread_id = ?`,
  )
    .bind(threadId)
    .first<{ count: number }>()
    .then((row) => row?.count);

describe("Thread draft", () => {
  it("is empty until saved, the last write wins, and an empty one is deleted", async () => {
    const project = await createProjectViaApi("Draft");
    const thread = await createThreadViaApi(project.data.id);
    const id = thread.data.id;

    expect(await read(id)).toEqual({ status: 200, text: "" });

    expect((await write(id, { text: "first device" })).status).toBe(200);
    expect((await write(id, { text: "second device\nwins" })).status).toBe(200);
    expect(await read(id)).toEqual({
      status: 200,
      text: "second device\nwins",
    });

    // Sending clears the composer, which removes the stored draft.
    expect((await write(id, { text: "" })).status).toBe(200);
    expect(await read(id)).toEqual({ status: 200, text: "" });
    expect(await rows(id)).toBe(0);
  });

  it("is invisible to someone without access to the Thread", async () => {
    const project = await createProjectViaApi("Draft");
    const thread = await createThreadViaApi(project.data.id);
    await write(thread.data.id, { text: "private" });

    expect((await read(thread.data.id, otherPrincipal)).status).toBe(404);
    expect(
      (await write(thread.data.id, { text: "x" }, otherPrincipal)).status,
    ).toBe(404);
    expect(await read(thread.data.id)).toEqual({
      status: 200,
      text: "private",
    });
  });

  it("rejects a malformed or oversized draft", async () => {
    const project = await createProjectViaApi("Draft");
    const thread = await createThreadViaApi(project.data.id);
    for (const bad of [
      "not json",
      {},
      { text: 3 },
      { text: "x".repeat(THREAD_DRAFT_MAX_LENGTH + 1) },
    ])
      expect((await write(thread.data.id, bad)).status).toBe(400);
    expect((await read("thr_not-a-thread")).status).toBe(400);
    expect(await rows(thread.data.id)).toBe(0);
  });

  it("keeps each of a Thread's boxes apart from its composer", async () => {
    const project = await createProjectViaApi("Draft");
    const thread = await createThreadViaApi(project.data.id);
    const id = thread.data.id;
    const comment = box(id, "post-comment:post-1");
    const artifactComment = box(id, "artifact-comment:art_1");

    await write(id, { text: "composer" });
    expect((await comment.write("a")).status).toBe(200);
    expect((await artifactComment.write("b")).status).toBe(200);
    expect(await read(id)).toEqual({ status: 200, text: "composer" });
    expect(await comment.read()).toEqual({ status: 200, text: "a" });
    expect(await artifactComment.read()).toEqual({ status: 200, text: "b" });
    expect(await box(id, "post-comment:post-2").read()).toEqual({
      status: 200,
      text: "",
    });

    // Posting the comment clears only its box.
    await comment.write("");
    expect(await comment.read()).toEqual({ status: 200, text: "" });
    expect(await read(id)).toEqual({ status: 200, text: "composer" });

    for (const bad of ["", "other:1", "post-comment:", "post-comment:a/b"])
      expect((await box(id, bad).read()).status).toBe(400);
  });

  it("keeps a person's newest boxes in a Thread when they write too many", async () => {
    const project = await createProjectViaApi("Draft");
    const thread = await createThreadViaApi(project.data.id);
    const id = thread.data.id;
    for (let index = 0; index <= 50; index += 1)
      expect(
        (await box(id, `post-comment:post-${index}`).write(`c${index}`)).status,
      ).toBe(200);
    const kept = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM thread_slot_draft WHERE thread_id = ?`,
    )
      .bind(id)
      .first<{ count: number }>();
    expect(kept?.count).toBe(50);
    // The box just written is always kept.
    expect(await box(id, "post-comment:post-50").read()).toEqual({
      status: 200,
      text: "c50",
    });
  });
});
