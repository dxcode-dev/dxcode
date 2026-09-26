import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId } from "../http/request-id.js";
import type { AppEnv } from "../http/types.js";
import { enforceThreadActive } from "./enforce-thread-active.js";

const threadId = "thr_00000000-0000-4000-8000-000000000047";

const createApp = (lifecycleState: "active" | "archived") => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("threadLifecycleState", lifecycleState);
    await next();
  });
  app.use("/v1/threads/:threadId/terminal", enforceThreadActive);
  app.use("/v1/threads/:threadId/files", enforceThreadActive);
  app.use("/v1/threads/:threadId/files/*", enforceThreadActive);
  app.use("/v1/agents/dx/:threadId", enforceThreadActive);
  app.use("/v1/agents/dx/:threadId/:subpath{.+}", enforceThreadActive);
  app.all("*", (context) => context.body(null, 204));
  return app;
};

describe("archived Thread execution admission", () => {
  it.each([
    ["terminal open", `/v1/threads/${threadId}/terminal`],
    ["Files tree read", `/v1/threads/${threadId}/files`],
    ["Files content read", `/v1/threads/${threadId}/files/src%2Findex.ts`],
    ["Flue submission", `/v1/agents/dx/${threadId}`],
    ["Flue abort", `/v1/agents/dx/${threadId}/abort`],
  ])("blocks archived %s before execution", async (_label, path) => {
    const response = await createApp("archived").request(path, {
      method: path.includes("/files") ? "GET" : "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      data: {
        code: "THREAD_ARCHIVED",
        message: "Thread is archived. Unarchive it before continuing.",
        requestId: expect.any(String),
      },
    });
  });

  it.each([
    ["Flue history", `/v1/agents/dx/${threadId}`],
    ["Flue updates", `/v1/agents/dx/${threadId}/updates`],
    ["Flue attachment", `/v1/agents/dx/${threadId}/attachments/attachment-1`],
  ])("keeps archived %s readable without execution", async (_label, path) => {
    const response = await createApp("archived").request(path);
    expect(response.status).toBe(204);
  });

  it.each([
    `/v1/threads/${threadId}/terminal`,
    `/v1/threads/${threadId}/files`,
    `/v1/threads/${threadId}/files/src%2Findex.ts`,
    `/v1/agents/dx/${threadId}`,
    `/v1/agents/dx/${threadId}/abort`,
  ])("allows active execution at %s", async (path) => {
    const response = await createApp("active").request(path, {
      method: path.includes("/files") ? "GET" : "POST",
    });
    expect(response.status).toBe(204);
  });
});
