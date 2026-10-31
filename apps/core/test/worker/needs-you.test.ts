import { env } from "cloudflare:test";
import type { CreateThreadResponse, NeedsYouData } from "@dx/api";
import type { FlueObservation } from "@flue/runtime";
import { Hono } from "hono";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { createNeedsYouTools } from "../../src/needs-you/agent-tools.js";
import { needsYouRoutes } from "../../src/needs-you/routes.js";
import { recordFlueThreadActivity } from "../../src/threads/activity.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

/**
 * The Needs-you inbox in workerd with real D1: the agent's request_attention
 * tool, Flue's turn observations as the activity recorder receives them, and
 * the owner's list and Dismiss through the real routes.
 */

const observe = (value: Record<string, unknown>) =>
  recordFlueThreadActivity(
    value as unknown as FlueObservation,
    { id: "fixture", agentName: "dx", env: { DB: env.DB } } as never,
  );

// Turns run in the past, before the asks the tool stamps with now.
let clock = Date.UTC(2026, 0, 5, 12, 0, 0);
const tick = () => {
  clock += 60_000;
  return new Date(clock).toISOString();
};

const start = (threadId: string, submissionId: string, timestamp = tick()) =>
  observe({
    type: "submission_running",
    instanceId: threadId,
    submissionId,
    timestamp,
  });

const settle = (
  threadId: string,
  submissionId: string,
  outcome: "completed" | "failed",
  timestamp = tick(),
) =>
  observe({
    type: "submission_settled",
    instanceId: threadId,
    submissionId,
    outcome,
    timestamp,
  });

const requestAttention = async (
  threadId: string,
  data: Record<string, unknown>,
) => {
  const [tool] = createNeedsYouTools(threadId, () => ({
    db: env.DB,
    bindings,
  }));
  if (tool === undefined) throw new Error("request_attention is missing.");
  // As Flue does before it runs a tool: validate and transform the input.
  const parsed = v.parse(tool.input as v.GenericSchema, data);
  return (
    (await tool.run({
      data: parsed,
      toolCallId: crypto.randomUUID(),
      signal: undefined,
    } as never)) as { output: Record<string, unknown> }
  ).output;
};

const needsYouApp = (requestPrincipal = principal) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  app.route("/needs-you", needsYouRoutes);
  return app;
};

const list = async (requestPrincipal = principal) => {
  const response = await needsYouApp(requestPrincipal).request(
    "/needs-you",
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json<{ data: NeedsYouData }>()).data.items;
};

const dismiss = (threadId: string, requestPrincipal = principal) =>
  needsYouApp(requestPrincipal).request(
    `/needs-you/${threadId}`,
    { method: "DELETE" },
    bindings,
  );

const createChild = async (projectId: string, parentThreadId: string) =>
  (
    await createProductApp().request(
      "/threads",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ projectId, title: "Child", parentThreadId }),
      },
      bindings,
    )
  ).json<CreateThreadResponse>();

describe("Needs you", () => {
  it("lists asks and failed root turns until the next turn or Dismiss", async () => {
    const project = await createProjectViaApi("needs-you");
    const root = (await createThreadViaApi(project.data.id)).data.id;
    const other = (await createThreadViaApi(project.data.id)).data.id;
    const child = (await createChild(project.data.id, root)).data.id;
    const names = new Map([
      [root, "root"],
      [other, "other"],
      [child, "child"],
    ]);
    const steps: string[] = [];
    const snapshot = async (step: string) => {
      const items = await list();
      steps.push(
        `${step}\n${items
          .map(
            (item) =>
              `${names.get(item.threadId)} ${item.kind}${item.summary === undefined ? "" : `: ${item.summary}`}${item.url === undefined ? "" : ` <${item.url}>`}`,
          )
          .join("\n")}\n`,
      );
      return items;
    };

    expect(await snapshot("nothing asked")).toEqual([]);

    // The agent asks during its turn and the turn ends.
    await start(root, "root-1");
    expect(
      await requestAttention(root, {
        kind: "approval",
        summary: "  Approve merging PR #12  ",
        url: "https://github.com/acme/app/pull/12",
      }),
    ).toMatchObject({ listed: true });
    await settle(root, "root-1", "completed", new Date().toISOString());
    let items = await snapshot("root asks for approval");
    expect(items).toMatchObject([
      {
        threadId: root,
        threadTitle: "Test thread",
        projectName: "needs-you",
        kind: "approval",
        summary: "Approve merging PR #12",
        url: "https://github.com/acme/app/pull/12",
      },
    ]);

    // A replay of the turn's start, observed late, does not clear the ask
    // the turn made after it started.
    await start(root, "root-1", new Date(clock).toISOString());
    expect(await list()).toHaveLength(1);

    // Another person neither sees nor dismisses it.
    expect(await list(otherPrincipal)).toEqual([]);
    expect((await dismiss(root, otherPrincipal)).status).toBe(200);
    expect(await list()).toHaveLength(1);

    // The owner replies: the next turn starting clears the ask.
    await start(root, "root-2", new Date(Date.now() + 1_000).toISOString());
    expect(await snapshot("the owner replied")).toEqual([]);
    clock = Date.now() + 2_000;

    // A root Thread's failed turn lists it; a child's does not, because its
    // parent already waits on it.
    await settle(root, "root-2", "failed");
    await start(child, "child-1");
    await settle(child, "child-1", "failed");
    items = await snapshot("root and child failed");
    expect(items).toMatchObject([{ threadId: root, kind: "failed" }]);
    expect(items[0]).not.toHaveProperty("summary");

    // A failure does not replace a question the agent asked.
    await start(other, "other-1");
    await requestAttention(other, {
      kind: "question",
      summary: "Which region should the bucket live in?",
    });
    await settle(
      other,
      "other-1",
      "failed",
      new Date(Date.now() + 3_000).toISOString(),
    );
    items = await snapshot("other asks, then fails");
    // Newest first: root's failure is stamped after other's ask.
    expect(
      items.map(({ threadId, kind }) => [names.get(threadId), kind]),
    ).toEqual([
      ["root", "failed"],
      ["other", "question"],
    ]);

    // Dismiss removes it, and a replayed failure does not bring it back.
    const dismissed = await dismiss(root);
    expect(dismissed.status).toBe(200);
    expect(
      (await dismissed.json<{ data: NeedsYouData }>()).data.items.map(
        ({ threadId }) => names.get(threadId),
      ),
    ).toEqual(["other"]);
    const failedAt = new Date(clock).toISOString();
    await settle(root, "root-2", "failed", failedAt);
    items = await snapshot("root dismissed, failure replayed");
    expect(items.map(({ threadId }) => names.get(threadId))).toEqual(["other"]);

    // A child asked directly is listed: its agent chose to ask the owner.
    await requestAttention(child, {
      kind: "question",
      summary: "Need the staging API key",
    });
    expect((await list()).map(({ threadId }) => names.get(threadId))).toContain(
      "child",
    );

    // An archived Thread's ask is hidden.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(other)
      .run();
    await snapshot("other archived");
    expect((await list()).map(({ threadId }) => names.get(threadId))).toEqual([
      "child",
    ]);

    // Bad input is refused before anything is written.
    await expect(
      requestAttention(root, { kind: "question", summary: "" }),
    ).rejects.toThrow();
    await expect(
      requestAttention(root, {
        kind: "question",
        summary: "Look",
        url: "javascript:alert(1)",
      }),
    ).rejects.toThrow();
    expect((await dismiss("not-a-thread")).status).toBe(400);

    // question, approval, or failed per Thread; <link> when the ask has one.
    await expect(steps.join("\n")).toMatchFileSnapshot(
      "../../../../artifacts/needs-you/inbox.txt",
    );
  });
});
