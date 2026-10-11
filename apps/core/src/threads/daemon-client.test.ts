import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  activateThreadDaemon,
  DaemonUnavailable,
  requestThreadDaemon,
  residentThreadDaemonEndpoint,
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

describe("Thread daemon client", () => {
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
});

describe("residentThreadDaemonEndpoint", () => {
  it("allows insecure daemon transport only on concrete loopback hosts", () => {
    expect(
      residentThreadDaemonEndpoint("http://127.0.0.1:5173/", threadId),
    ).toBe(`ws://127.0.0.1:5173/v1/dxd/${threadId}`);
    expect(
      residentThreadDaemonEndpoint("http://localhost:5173/", threadId),
    ).toBe(`ws://localhost:5173/v1/dxd/${threadId}`);
    expect(
      residentThreadDaemonEndpoint("http://deployed.test/", threadId),
    ).toBeUndefined();
    expect(
      residentThreadDaemonEndpoint("https://deployed.test/", threadId),
    ).toBe(`wss://deployed.test/v1/dxd/${threadId}`);
  });
});
