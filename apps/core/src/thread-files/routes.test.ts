import type { ThreadFilesPath, ThreadFileVersion } from "@dx/api";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../http/types.js";

const mocks = vi.hoisted(() => ({ requestThreadDaemon: vi.fn() }));

vi.mock("../threads/daemon-client.js", () => ({
  requestThreadDaemon: mocks.requestThreadDaemon,
}));

import { makeThreadFilesRoutes } from "./routes.js";

const threadId = "thr_00000000-0000-4000-8000-000000000243";
const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
const path = "src/nested/example.ts" as ThreadFilesPath;

const appFor = (
  resident?: NonNullable<Parameters<typeof makeThreadFilesRoutes>[0]>,
) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "files-route-test");
    await next();
  });
  app.route("/v1/threads", makeThreadFilesRoutes(resident));
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
    expect(mocks.requestThreadDaemon).toHaveBeenNthCalledWith(
      1,
      bindings,
      threadId,
      { operation: "files.list", path: null },
    );
    expect(mocks.requestThreadDaemon).toHaveBeenNthCalledWith(
      2,
      bindings,
      threadId,
      { operation: "files.read", path },
    );
  });

  it("selects resident dxd for deployed Files", async () => {
    const resident = {
      list: vi.fn(async () => ({
        kind: "tree" as const,
        version,
        entries: [],
      })),
      read: vi.fn(),
      save: vi.fn(),
    };
    const app = appFor(resident);
    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files`,
      undefined,
      { DX_RUNTIME_MODE: "deployed" },
    );

    expect(response.status).toBe(200);
    expect(resident.list).toHaveBeenCalledOnce();
    expect(mocks.requestThreadDaemon).not.toHaveBeenCalled();
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

  it("selects resident save before dispatch and never resolves a request-scoped workspace", async () => {
    const save = vi.fn(async () => ({
      kind: "saved" as const,
      contentVersion: `sha256:${"b".repeat(64)}` as ThreadFileVersion,
    }));
    const app = appFor({
      list: vi.fn(),
      read: vi.fn(),
      save,
    });
    const content = "export const newest = true;\n";

    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, content }),
      },
      { DX_RUNTIME_MODE: "local" },
    );

    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      threadId,
      path,
      version,
      content,
      undefined,
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not replay after a resident save dispatch fails", async () => {
    const save = vi.fn(async () => {
      throw new Error("uncertain dispatch");
    });
    const app = appFor({
      list: vi.fn(),
      read: vi.fn(),
      save,
    });

    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, content: "newest\n" }),
      },
      { DX_RUNTIME_MODE: "deployed" },
    );

    expect(response.status).toBe(503);
    expect(save).toHaveBeenCalledOnce();
  });

  it("preserves the public conflict envelope from resident save", async () => {
    const save = vi.fn(async () => {
      const { ThreadFilesConflict } = await import("./service.js");
      throw new ThreadFilesConflict();
    });
    const app = appFor({
      list: vi.fn(),
      read: vi.fn(),
      save,
    });

    const response = await app.request(
      `http://dx.test/v1/threads/${threadId}/files/${encodeURIComponent(path)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, content: "newest\n" }),
      },
      { DX_RUNTIME_MODE: "local" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      data: { code: "THREAD_FILES_CONFLICT" },
    });
    expect(save).toHaveBeenCalledOnce();
  });
});
