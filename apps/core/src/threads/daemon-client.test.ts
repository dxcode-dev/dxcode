import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DXD_RELEASE } from "../execution/dxd/protocol.js";
import {
  activateThreadDaemon,
  DaemonUnavailable,
  drainThreadDaemon,
  queueThreadChangesRefresh,
  requestThreadDaemon,
  residentThreadDaemonEndpoint,
  startThreadDaemonActivation,
} from "./daemon-client.js";

const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000292",
);

const namespaceWith = (...responses: Response[]) => {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    namespace: {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({ fetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace,
  };
};

describe("activateThreadDaemon", () => {
  it("starts attributed activation without waiting for readiness", async () => {
    const fixture = namespaceWith(
      Response.json(
        { ready: false, activationId: "activation-background" },
        { status: 202 },
      ),
    );
    await expect(
      startThreadDaemonActivation(
        { THREAD_EXECUTION: fixture.namespace },
        threadId,
        "submission-1",
      ),
    ).resolves.toEqual({
      ready: false,
      activationId: "activation-background",
    });
    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://thread.internal/daemon/activate",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-dx-daemon-activate-mode": "background",
          "x-dx-submission-id": "submission-1",
        }),
      }),
    );
  });

  it("returns only sanitized readiness", async () => {
    const fixture = namespaceWith(
      Response.json({
        ready: true,
        activationId: "activation-1",
        release: DXD_RELEASE,
        protocolMajor: 1,
      }),
    );
    await expect(
      activateThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId),
    ).resolves.toEqual({
      ready: true,
      activationId: "activation-1",
      release: DXD_RELEASE,
      protocolMajor: 1,
    });
    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://thread.internal/daemon/activate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns content-free daemon activation milestones", async () => {
    const fixture = namespaceWith(
      Response.json({
        ready: true,
        activationId: "activation-2",
        release: DXD_RELEASE,
        protocolMajor: 1,
        activationMilestones: {
          releaseLoadedAt: 1_000,
          installedAt: 2_000,
          connectedAt: 3_000,
          environmentReadyAt: 4_000,
        },
      }),
    );

    await expect(
      activateThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId),
    ).resolves.toMatchObject({
      activationMilestones: {
        releaseLoadedAt: 1_000,
        installedAt: 2_000,
        connectedAt: 3_000,
        environmentReadyAt: 4_000,
      },
    });
  });

  it("replaces transport and decoding failures with a typed safe error", async () => {
    const fixture = namespaceWith(Response.json({ secret: "must-not-escape" }));
    await expect(
      activateThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId),
    ).rejects.toEqual(
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome: "known",
      }),
    );
  });

  it("sends one typed operation to the resident transport owner", async () => {
    const fixture = namespaceWith(
      Response.json({
        kind: "tree",
        version: `sha256:${"a".repeat(64)}`,
        entries: [{ name: "src", kind: "directory" }],
      }),
    );
    await expect(
      requestThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId, {
        operation: "files.list",
        path: null,
      }),
    ).resolves.toMatchObject({ kind: "tree" });
    expect(fixture.fetch).toHaveBeenCalledOnce();
    const [url, init] = fixture.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://thread.internal/daemon/request");
    expect(JSON.parse(String(init.body))).toEqual({
      operation: "files.list",
      path: null,
    });
    expect(String(init.body)).not.toMatch(/provider|sandbox|e2b/i);
  });

  it("does not retry or expose a malformed daemon response", async () => {
    const fixture = namespaceWith(Response.json({ secret: "must-not-escape" }));
    await expect(
      requestThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId, {
        operation: "files.read",
        path: "README.md" as never,
      }),
    ).rejects.toEqual(
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome: "unknown",
      }),
    );
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("classifies operation encoding failures as known before dispatch", async () => {
    const fixture = namespaceWith();
    await expect(
      requestThreadDaemon({ THREAD_EXECUTION: fixture.namespace }, threadId, {
        operation: "files.list",
        path: 42,
      } as never),
    ).rejects.toEqual(
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome: "known",
      }),
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("dispatches one typed save with its refresh and never retries uncertain settlement", async () => {
    const fixture = namespaceWith(
      Response.json(
        { error: "daemon-unavailable", outcome: "unknown" },
        { status: 503 },
      ),
    );
    const operation = {
      operation: "files.save" as const,
      path: "README.md" as never,
      expectedVersion: `sha256:${"a".repeat(64)}` as never,
      content: "newest\n",
      refresh: {
        type: "changes-refresh" as const,
        token: "opaque-refresh-token",
        source: { baseline: "b".repeat(40), defaultBranch: "main" },
      },
    };

    await expect(
      requestThreadDaemon(
        { THREAD_EXECUTION: fixture.namespace },
        threadId,
        operation,
      ),
    ).rejects.toEqual(
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome: "unknown",
      }),
    );

    expect(fixture.fetch).toHaveBeenCalledOnce();
    const [, request] = fixture.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual(operation);
  });

  it("drains the Thread object before archive pause", async () => {
    const fixture = namespaceWith(new Response(null, { status: 204 }));
    await expect(
      drainThreadDaemon(
        { THREAD_EXECUTION: fixture.namespace },
        threadId,
        "thread-archived",
      ),
    ).resolves.toBeUndefined();
    expect(fixture.fetch).toHaveBeenCalledWith(
      "https://thread.internal/daemon/drain",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-dx-thread-id": threadId }),
      }),
    );
  });
});

describe("residentThreadDaemonEndpoint", () => {
  it("allows insecure daemon transport only on concrete loopback hosts", () => {
    expect(
      residentThreadDaemonEndpoint("http://127.0.0.1:5173/", threadId),
    ).toBe(`ws://127.0.0.1:5173/v1/threads/${threadId}/dxd`);
    expect(
      residentThreadDaemonEndpoint("http://localhost:5173/", threadId),
    ).toBe(`ws://localhost:5173/v1/threads/${threadId}/dxd`);
    expect(
      residentThreadDaemonEndpoint("http://deployed.test/", threadId),
    ).toBeUndefined();
    expect(
      residentThreadDaemonEndpoint("https://deployed.test/", threadId),
    ).toBe(`wss://deployed.test/v1/threads/${threadId}/dxd`);
  });
});

describe("queueThreadChangesRefresh", () => {
  it("sends only the opaque token and bounded source context to the Thread object", async () => {
    const fixture = namespaceWith(new Response(null, { status: 202 }));
    const refresh = {
      type: "changes-refresh" as const,
      token: "opaque-refresh-token",
      source: { baseline: "a".repeat(40), defaultBranch: "main" },
      expectedFingerprint: "b".repeat(64),
    };

    await expect(
      queueThreadChangesRefresh(
        { THREAD_EXECUTION: fixture.namespace },
        threadId,
        refresh,
      ),
    ).resolves.toBe(true);

    const [, request] = fixture.fetch.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      method: "POST",
      body: JSON.stringify(refresh),
    });
    expect(JSON.stringify(request)).not.toMatch(
      /sandbox|provider|credential|history|command/i,
    );
  });

  it("drops a refresh when the daemon transport is unavailable", async () => {
    await expect(
      queueThreadChangesRefresh({}, threadId, {
        type: "changes-refresh",
        token: "opaque-refresh-token",
        source: { baseline: "a".repeat(40), defaultBranch: "main" },
      }),
    ).resolves.toBe(false);
  });
});
