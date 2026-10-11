import type { ThreadFilesPath, ThreadFileVersion } from "@dx/api";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../http/types.js";

const mocks = vi.hoisted(() => ({ requestThreadDaemon: vi.fn() }));

vi.mock("../threads/daemon-client.js", () => ({
  requestThreadDaemon: mocks.requestThreadDaemon,
}));

import { threadFilesRoutes } from "./routes.js";

const threadId = "thr_00000000-0000-4000-8000-000000000243";
const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
const path = "src/nested/example.ts" as ThreadFilesPath;

const appFor = () => {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "files-route-test");
    await next();
  });
  app.route("/v1/threads", threadFilesRoutes);
  return app;
};

beforeEach(() => {
  mocks.requestThreadDaemon.mockReset();
});

describe("Thread Files routes", () => {
  it("rejects malformed input before daemon dispatch", async () => {
    const app = appFor();
    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      data: { code: "THREAD_FILES_INVALID_REQUEST" },
    });
    expect(mocks.requestThreadDaemon).not.toHaveBeenCalled();
  });

  it("selects resident dxd for local list and read", async () => {
    mocks.requestThreadDaemon
      .mockResolvedValueOnce({
        kind: "tree",
        version,
        entries: [{ name: "src", kind: "directory" }],
      })
      .mockResolvedValueOnce({
        kind: "editable",
        version,
        content: "export {};\n",
        sizeBytes: 11,
      });
    const app = appFor();
    const bindings = { DX_RUNTIME_MODE: "local" };

    const list = await app.request(
      `http://dx.test/v1/threads/${threadId}/files`,
      undefined,
      bindings,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      status: "success",
      data: { entries: [{ name: "src", path: "src", kind: "directory" }] },
    });
    const read = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      undefined,
      bindings,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      status: "success",
      data: {
        path,
        editable: true,
        language: "typescript",
        mediaType: "text/typescript",
      },
    });
  });

  it("maps daemon failures without alternate dispatch", async () => {
    mocks.requestThreadDaemon.mockResolvedValueOnce({ kind: "missing" });
    const app = appFor();
    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      undefined,
      { DX_RUNTIME_MODE: "local" },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      data: { code: "THREAD_FILES_ENTRY_NOT_FOUND" },
    });
  });
});
