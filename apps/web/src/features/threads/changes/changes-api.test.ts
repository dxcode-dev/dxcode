import type {
  GetThreadChangesResponse,
  PushThreadChangesResponse,
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesPath,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import {
  type ChangesEventSocket,
  createChangesTransport,
  subscribeToChanges,
} from "./changes-api.js";

const threadId = "thr_00000000-0000-4000-8000-000000000249" as ThreadId;
const captureId =
  "chg_00000000-0000-4000-8000-000000000249" as ThreadChangesCaptureId;
const commit = "a".repeat(40) as ThreadChangesCommitSha;

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Changes transport", () => {
  it("subscribes with the Changes protocol, reconnects, and disposes", () => {
    const sockets: EventTarget[] = [];
    const timers: Array<() => void> = [];
    const createSocket = vi.fn((url: string, protocol: string) => {
      const socket = new EventTarget();
      Object.assign(socket, { close: vi.fn() });
      sockets.push(socket);
      expect(url).toBe(`wss://dx.test/v1/threads/${threadId}/changes/events`);
      expect(protocol).toBe("dx-changes-v1");
      return socket as unknown as ChangesEventSocket;
    });
    const onUpdate = vi.fn();
    const dispose = subscribeToChanges(threadId, onUpdate, {
      createSocket,
      origin: "https://dx.test/workspace",
      random: () => 0,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return 1;
      }) as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });

    sockets[0]?.dispatchEvent(new Event("open"));
    sockets[0]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "changes-updated" }),
      }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
    sockets[0]?.dispatchEvent(new Event("close"));
    timers[0]?.();
    expect(createSocket).toHaveBeenCalledTimes(2);

    dispose();
    sockets[1]?.dispatchEvent(new Event("close"));
    expect(timers).toHaveLength(1);
    expect(
      (sockets[1] as EventTarget & { close: ReturnType<typeof vi.fn> }).close,
    ).toHaveBeenCalled();
  });

  it("encodes semantic range and confined path parameters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        status: "success",
        data: {
          kind: "diff",
          captureId,
          freshness: "complete",
          capturedAt: "2026-08-29T12:00:00.000Z",
          range: { kind: "commit", sha: commit },
          file: {
            path: "src/a file.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            binary: false,
            truncated: false,
          },
          patch: "@@ -1 +1 @@\n-old\n+new\n",
        },
      }),
    );
    const transport = createChangesTransport(fetch);

    await transport.getDiff(
      threadId,
      "src/a file.ts" as ThreadChangesPath,
      {
        kind: "commit",
        sha: commit,
      },
      captureId,
    );

    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://dx.test");
    expect(url.pathname).toBe(`/v1/threads/${threadId}/changes/diff`);
    expect(url.searchParams.get("range")).toBe(`commit:${commit}`);
    expect(url.searchParams.get("path")).toBe("src/a file.ts");
    expect(url.searchParams.get("captureId")).toBe(captureId);
    expect(url.searchParams.get("worktree")).toBe("primary");
  });

  it("adds explicit confirmation to push and decodes the response contract", async () => {
    const payload: PushThreadChangesResponse = {
      status: "success",
      data: { kind: "pushed", status: "pushed", sha: commit },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(payload));
    const transport = createChangesTransport(fetch);

    await expect(
      transport.push(threadId, {
        expectedCaptureId: captureId,
        idempotencyKey: "push-operation-249",
      }),
    ).resolves.toEqual(payload.data);
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      expectedCaptureId: captureId,
      idempotencyKey: "push-operation-249",
      confirmation: "push",
    });
  });

  it("contains server failures behind a stable client error", async () => {
    const failure: GetThreadChangesResponse = {
      status: "success",
      data: { kind: "missing" },
    };
    const transport = createChangesTransport(
      vi.fn<typeof globalThis.fetch>(async () => response(failure, 503)),
    );

    await expect(
      transport.getChanges(threadId, { kind: "all" }),
    ).rejects.toThrow("Changes request failed.");
  });

  it("propagates cancellation through Changes and diff response decoding", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes("/diff?path=src%2Fexample.ts&range=all&captureId=")
        ? response({
            status: "success",
            data: {
              kind: "diff",
              captureId,
              freshness: "complete",
              capturedAt: "2026-08-29T12:00:00.000Z",
              range: { kind: "all" },
              file: {
                path: "src/example.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                binary: false,
                truncated: false,
              },
              patch: "+new\n",
            },
          })
        : response({
            status: "success",
            data: { kind: "missing" },
          }),
    );
    const transport = createChangesTransport(fetch);
    const changesController = new AbortController();
    const changesCancellation = new Error("changes cancelled");
    changesController.abort(changesCancellation);
    const diffController = new AbortController();
    const diffCancellation = new Error("diff cancelled");
    diffController.abort(diffCancellation);

    await expect(
      transport.getChanges(threadId, { kind: "all" }, changesController.signal),
    ).rejects.toBe(changesCancellation);
    await expect(
      transport.getDiff(
        threadId,
        "src/example.ts" as ThreadChangesPath,
        { kind: "all" },
        captureId,
        diffController.signal,
      ),
    ).rejects.toBe(diffCancellation);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(changesController.signal);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(diffController.signal);
  });
});
