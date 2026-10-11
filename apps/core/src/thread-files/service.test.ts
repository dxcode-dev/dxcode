import { ThreadFilesPath } from "@dx/api";
import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestThreadDaemon: vi.fn() }));

vi.mock("../threads/daemon-client.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestThreadDaemon: mocks.requestThreadDaemon,
}));

import { DaemonUnavailable } from "../threads/daemon-client.js";

import {
  listThreadFilesThroughDaemon,
  ThreadFilesConflict,
  ThreadFilesUnavailable,
} from "./service.js";

const version = `sha256:${"a".repeat(64)}`;
const path = Schema.decodeUnknownSync(ThreadFilesPath)("src/file.ts");

beforeEach(() => {
  mocks.requestThreadDaemon.mockReset();
});

describe("Thread Files service", () => {
  it("does not replay an uncertain file listing after dispatch", async () => {
    mocks.requestThreadDaemon.mockRejectedValue(
      new DaemonUnavailable({
        message: "Thread daemon is unavailable.",
        outcome: "unknown",
      }),
    );

    await expect(
      listThreadFilesThroughDaemon(
        {},
        "thr_00000000-0000-4000-8000-000000000293" as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ThreadFilesUnavailable);
    expect(mocks.requestThreadDaemon).toHaveBeenCalledTimes(1);
  });

  it("retries one failure proven to occur before dispatch", async () => {
    vi.useFakeTimers();
    try {
      mocks.requestThreadDaemon
        .mockRejectedValueOnce(
          new DaemonUnavailable({
            message: "Thread daemon is unavailable.",
            outcome: "known",
          }),
        )
        .mockResolvedValueOnce({
          kind: "tree",
          version,
          entries: [{ name: "ready.ts", kind: "file", sizeBytes: 1 }],
        });

      const result = listThreadFilesThroughDaemon(
        {},
        "thr_00000000-0000-4000-8000-000000000293" as never,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toMatchObject({
        entries: [{ name: "ready.ts" }],
      });
      expect(mocks.requestThreadDaemon).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts opaque public cursors to dxd pagination without exposing the wire cursor", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000000293" as never;
    mocks.requestThreadDaemon
      .mockResolvedValueOnce({
        kind: "tree",
        version,
        entries: [{ name: "file.ts", kind: "file", sizeBytes: 1 }],
        nextIndex: 100,
      })
      .mockResolvedValueOnce({
        kind: "tree",
        version,
        entries: [{ name: "last.ts", kind: "file", sizeBytes: 1 }],
      });
    const first = await listThreadFilesThroughDaemon({}, threadId, undefined);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toContain(version);

    await expect(
      listThreadFilesThroughDaemon({}, threadId, undefined, first.nextCursor),
    ).resolves.toMatchObject({ entries: [{ name: "last.ts" }] });
    expect(mocks.requestThreadDaemon).toHaveBeenNthCalledWith(2, {}, threadId, {
      operation: "files.list",
      path: null,
      cursor: { version, index: 100 },
    });
    await expect(
      listThreadFilesThroughDaemon({}, threadId, path, first.nextCursor),
    ).rejects.toBeInstanceOf(ThreadFilesConflict);
    expect(mocks.requestThreadDaemon).toHaveBeenCalledTimes(2);
  });
});
