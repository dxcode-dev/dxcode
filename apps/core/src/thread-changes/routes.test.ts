import type {
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesPath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import type { ThreadChangesManifest } from "./capture.js";
import type { ThreadChangesState } from "./repository-d1.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  load: vi.fn(),
  patch: vi.fn(async () => "@@ -1 +1 @@\n-old\n+new\n"),
  createSandbox: vi.fn(),
  push: vi.fn(),
}));

vi.mock("../persistence/d1-binding.js", async () => {
  const { Effect } = await import("effect");
  return { decodeD1Binding: () => Effect.succeed({}) };
});
vi.mock("./repository-d1.js", () => ({
  makeThreadChangesRepository: () => ({ read: mocks.read }),
}));
vi.mock("./capture.js", () => ({
  loadThreadChangesIndex: mocks.load,
  loadThreadChangesPatch: mocks.patch,
}));
vi.mock("../execution/execution-workspaces.js", () => ({
  ExecutionWorkspaces: {
    existingSandboxFactory: { createSandbox: mocks.createSandbox },
  },
}));
vi.mock("../source-control/tools.js", () => {
  class SourcePushHeadChanged extends Error {}
  return {
    executeSourcePush: mocks.push,
    SourcePushHeadChanged,
  };
});
vi.mock("../source-control/operations.js", () => {
  class SourceMutationRejected extends Error {}
  return { SourceMutationRejected };
});

import { SourceMutationRejected } from "../source-control/operations.js";
import { threadChangesRoutes } from "./routes.js";

const threadId = "thr_00000000-0000-4000-8000-000000000249" as ThreadId;
const captureId =
  "chg_00000000-0000-4000-8000-000000000249" as ThreadChangesCaptureId;
const baseline = "a".repeat(40) as ThreadChangesCommitSha;
const head = "b".repeat(40) as ThreadChangesCommitSha;
const path = "src/example.ts" as ThreadChangesPath;
const capturedAt = "2026-08-29T12:00:00.000Z";
const fingerprint = "c".repeat(64);

const state = (generation = 1): ThreadChangesState => ({
  threadId,
  mutationGeneration: generation,
  latestCaptureId: captureId,
  latestCaptureGeneration: 1,
  latestFingerprint: fingerprint,
  latestCapturedAt: capturedAt,
  activeMutations: 0,
});

const manifest: ThreadChangesManifest = {
  schemaVersion: 1,
  captureId,
  threadId,
  generation: 1,
  capturedAt,
  fingerprint,
  repositoryName: "example-org/example-repo",
  defaultBranch: "main",
  baseline,
  head,
  branch: "codex/thread-changes",
  upstreamLabel: "origin/main",
  ahead: 2,
  commits: [{ sha: head, shortSha: head.slice(0, 7), subject: "Changes" }],
  ranges: [
    {
      range: { kind: "all" },
      truncated: false,
      summary: { additions: 1, deletions: 1, files: 1 },
      files: [
        {
          path,
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          truncated: false,
          patch: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    },
  ],
};

const app = new Hono<AppEnv>();
app.use("*", async (context, next) => {
  context.set("requestId", "changes-route-test");
  await next();
});
app.route("/v1/threads", threadChangesRoutes);

const bindings = {
  DB: {} as D1Database,
  DX_STORAGE: {} as R2Bucket,
} as Bindings;

const request = (path: string, init?: RequestInit) =>
  app.request(`http://dx.test${path}`, init, bindings);

afterEach(() => {
  vi.clearAllMocks();
});

describe("Thread Changes routes", () => {
  it("serves an obsolete capture's diff from the newest capture and names it", async () => {
    mocks.read.mockResolvedValueOnce(state());
    mocks.load.mockResolvedValueOnce(manifest);
    const response = await request(
      `/v1/threads/${threadId}/changes/diff?path=${path}&captureId=chg_obsolete`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { kind: "diff", captureId, patch: expect.stringContaining("+new") },
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      bindings.DX_STORAGE,
      threadId,
      captureId,
      { kind: "all" },
      path,
      "primary",
      manifest,
    );
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects an obsolete capture's diff for a file the newest capture dropped", async () => {
    mocks.read.mockResolvedValueOnce(state());
    mocks.load.mockResolvedValueOnce(manifest);
    const response = await request(
      `/v1/threads/${threadId}/changes/diff?path=src/reverted.ts&captureId=chg_obsolete`,
    );
    expect(response.status).toBe(409);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("routes a same-origin observer without accessing an execution workspace", async () => {
    const fetch = vi.fn(
      async (_request: Request) => new Response(null, { status: 200 }),
    );
    const namespace = {
      idFromName: vi.fn(() => "id"),
      get: vi.fn(() => ({ fetch })),
    };
    const url = `http://dx.test/v1/threads/${threadId}/changes/events`;
    const headers = {
      upgrade: "websocket",
      origin: "http://dx.test",
      "sec-websocket-protocol": "dx-changes-v1",
    };
    expect(
      (
        await app.request(url, { headers }, {
          ...bindings,
          THREAD_EXECUTION: namespace,
        } as unknown as Bindings)
      ).status,
    ).toBe(200);
    expect(
      new URL(fetch.mock.calls[0]?.[0]?.url ?? "http://invalid").pathname,
    ).toBe("/changes/events");
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(
      (
        await app.request(
          url,
          { headers: { ...headers, origin: "http://evil.test" } },
          {
            ...bindings,
            THREAD_EXECUTION: namespace,
          } as unknown as Bindings,
        )
      ).status,
    ).toBe(404);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("serves missing and captured reads without resolving an execution workspace", async () => {
    mocks.read.mockResolvedValueOnce(undefined);
    const missing = await request(`/v1/threads/${threadId}/changes`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      status: "success",
      data: { kind: "missing" },
    });

    mocks.read.mockResolvedValueOnce(state());
    mocks.load.mockResolvedValueOnce(manifest);
    const changes = await request(`/v1/threads/${threadId}/changes?range=all`);
    expect(changes.status).toBe(200);
    expect(await changes.json()).toMatchObject({
      status: "success",
      data: {
        kind: "changes",
        freshness: "complete",
        captureId,
        files: [{ path }],
      },
    });

    mocks.read.mockResolvedValueOnce(state());
    mocks.load.mockResolvedValueOnce(manifest);
    const diff = await request(
      `/v1/threads/${threadId}/changes/diff?range=all&path=${encodeURIComponent(path)}`,
    );
    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({
      status: "success",
      data: { kind: "diff", patch: expect.stringContaining("+new") },
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("retries against a newly published pointer when the prior object is deleted", async () => {
    const nextCaptureId =
      "chg_00000000-0000-4000-8000-000000000250" as ThreadChangesCaptureId;
    const nextCapturedAt = "2026-08-29T12:01:00.000Z";
    const nextFingerprint = "d".repeat(64);
    const nextState: ThreadChangesState = {
      ...state(2),
      latestCaptureId: nextCaptureId,
      latestCaptureGeneration: 2,
      latestFingerprint: nextFingerprint,
      latestCapturedAt: nextCapturedAt,
    };
    const nextManifest: ThreadChangesManifest = {
      ...manifest,
      captureId: nextCaptureId,
      generation: 2,
      capturedAt: nextCapturedAt,
      fingerprint: nextFingerprint,
    };
    mocks.read.mockResolvedValueOnce(state()).mockResolvedValueOnce(nextState);
    mocks.load
      .mockRejectedValueOnce(new Error("old object deleted"))
      .mockResolvedValueOnce(nextManifest);

    const response = await request(`/v1/threads/${threadId}/changes`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { kind: "changes", captureId: nextCaptureId },
    });
    expect(mocks.load).toHaveBeenNthCalledWith(
      1,
      bindings.DX_STORAGE,
      threadId,
      captureId,
    );
    expect(mocks.load).toHaveBeenNthCalledWith(
      2,
      bindings.DX_STORAGE,
      threadId,
      nextCaptureId,
    );
  });

  it("keeps the last complete capture readable as stale and rejects stale push", async () => {
    mocks.read.mockResolvedValue({
      ...state(2),
      dirtySince: "2026-08-29T12:01:00.000Z",
    });
    mocks.load.mockResolvedValue(manifest);
    const stale = await request(`/v1/threads/${threadId}/changes`);
    expect(await stale.json()).toMatchObject({
      data: { kind: "changes", freshness: "stale" },
    });

    const push = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-249",
        confirmation: "push",
      }),
    });
    expect(push.status).toBe(409);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("wakes execution only for a confirmed push bound to the captured HEAD", async () => {
    const resumedCaptureId =
      "chg_00000000-0000-4000-8000-000000000251" as ThreadChangesCaptureId;
    const resumedCapturedAt = "2026-08-29T12:02:00.000Z";
    const resumedFingerprint = "e".repeat(64);
    const resumedState: ThreadChangesState = {
      ...state(2),
      latestCaptureId: resumedCaptureId,
      latestCaptureGeneration: 2,
      latestFingerprint: resumedFingerprint,
      latestCapturedAt: resumedCapturedAt,
    };
    const resumedManifest: ThreadChangesManifest = {
      ...manifest,
      captureId: resumedCaptureId,
      generation: 2,
      capturedAt: resumedCapturedAt,
      fingerprint: resumedFingerprint,
    };
    const sandbox = { cwd: "/home/user/workspace/repo" };
    mocks.read
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(resumedState);
    mocks.load
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(resumedManifest);
    mocks.createSandbox.mockResolvedValue(sandbox);
    mocks.push.mockResolvedValue({ status: "pushed", sha: head });

    const response = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-249",
        confirmation: "push",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createSandbox).toHaveBeenCalledWith({ id: threadId });
    expect(mocks.push).toHaveBeenCalledWith(
      {
        threadId,
        sandbox,
        branch: "codex/thread-changes",
        idempotencyKey: "push-operation-249",
        expectedHead: head,
      },
      { bindings },
    );
  });

  it("blocks push when sandbox activation cannot refresh the capture", async () => {
    mocks.read.mockResolvedValueOnce(state()).mockResolvedValueOnce({
      ...state(2),
      dirtySince: "2026-08-29T12:01:00.000Z",
    });
    mocks.load.mockResolvedValue(manifest);
    mocks.createSandbox.mockResolvedValue({
      cwd: "/home/user/workspace/repo",
    });

    const response = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-250",
        confirmation: "push",
      }),
    });

    expect(response.status).toBe(409);
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("allows push when sandbox activation verifies the capture is unchanged", async () => {
    mocks.read.mockResolvedValueOnce(state()).mockResolvedValueOnce(state(2));
    mocks.load.mockResolvedValue(manifest);
    const sandbox = {
      cwd: "/home/user/workspace/repo",
    };
    mocks.createSandbox.mockResolvedValue(sandbox);
    mocks.push.mockResolvedValue({ status: "pushed", sha: head });

    const response = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-251",
        confirmation: "push",
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith(
      {
        threadId,
        sandbox,
        branch: "codex/thread-changes",
        idempotencyKey: "push-operation-251",
        expectedHead: head,
      },
      { bindings },
    );
  });

  it("reports a definite remote push rejection as a conflict", async () => {
    mocks.read.mockResolvedValueOnce(state()).mockResolvedValueOnce(state(2));
    mocks.load.mockResolvedValue(manifest);
    mocks.createSandbox.mockResolvedValue({
      cwd: "/home/user/workspace/repo",
    });
    mocks.push.mockRejectedValue(new SourceMutationRejected());

    const response = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-rejected",
        confirmation: "push",
      }),
    });

    expect(response.status).toBe(409);
  });

  it("blocks push when sandbox activation does not advance the generation", async () => {
    mocks.read.mockResolvedValue(state());
    mocks.load.mockResolvedValue(manifest);
    mocks.createSandbox.mockResolvedValue({
      cwd: "/home/user/workspace/repo",
    });

    const response = await request(`/v1/threads/${threadId}/changes/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-252",
        confirmation: "push",
      }),
    });

    expect(response.status).toBe(409);
    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
