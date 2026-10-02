import type { ThreadChangesCommitSha } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireCapture: vi.fn(),
  read: vi.fn(),
  source: vi.fn(),
  beginMutation: vi.fn(),
  renew: vi.fn(),
  publish: vi.fn(),
  capture: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./repository-d1.js", () => ({
  makeThreadChangesRepository: () => ({
    acquireCapture: async (threadId: unknown, durationMs: unknown) => {
      // The real lease reads state and source in the same transaction.
      const lease = await mocks.acquireCapture(threadId, durationMs);
      if (lease === undefined) return undefined;
      const [state, source] = await Promise.all([
        mocks.read(threadId),
        mocks.source(threadId),
      ]);
      return { ...lease, state, source };
    },
    read: mocks.read,
    source: mocks.source,
    beginMutation: mocks.beginMutation,
    publish: mocks.publish,
  }),
}));
vi.mock("./capture.js", () => ({
  captureKey: () => "capture-key",
  captureThreadChanges: mocks.capture,
  putThreadChangesCapture: mocks.put,
}));
vi.mock("../logging.js", () => ({
  threadChangesLogger: { info: vi.fn(), warn: vi.fn() },
}));

import { makeThreadChangesCoordinator } from "./coordinator.js";

const threadId = "thr_00000000-0000-4000-8000-000000000249" as ThreadId;
const head = "a".repeat(40) as ThreadChangesCommitSha;
const previousCaptureId = "chg_00000000-0000-4000-8000-000000000248";

const manifest = (captureId: string) => ({
  schemaVersion: 1,
  captureId,
  threadId,
  generation: 2,
  capturedAt: "2026-08-29T12:00:00.000Z",
  fingerprint: "b".repeat(64),
  repositoryName: "example-org/example-repo",
  defaultBranch: "main",
  baseline: head,
  head,
  ahead: 0,
  commits: [],
  ranges: [],
});

afterEach(() => {
  vi.resetAllMocks();
});

const setupCoordinator = () => {
  const releaseCapture = vi.fn(async () => undefined);
  const releaseMutation = vi.fn(async () => undefined);
  const deleteObject = vi.fn(async () => undefined);
  mocks.beginMutation.mockResolvedValue({
    generation: 2,
    renew: mocks.renew,
    release: releaseMutation,
  });
  mocks.acquireCapture.mockResolvedValue({ release: releaseCapture });
  mocks.read.mockResolvedValue({
    threadId,
    mutationGeneration: 2,
    latestCaptureId: previousCaptureId,
    activeMutations: 0,
  });
  mocks.source.mockResolvedValue({
    baseline: head,
    defaultBranch: "main",
    repositoryName: "example-org/example-repo",
  });
  mocks.capture.mockResolvedValue(manifest("chg_repro"));
  mocks.put.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(true);
  const coordinator = makeThreadChangesCoordinator({
    db: {} as D1Database,
    bucket: { delete: deleteObject } as unknown as R2Bucket,
    threadId,
    sandbox: { cwd: "/repo" } as Sandbox,
  });
  return { coordinator, releaseCapture, releaseMutation, deleteObject };
};

describe("orphan R2 object handling on publish failure", () => {
  it("cleans up the orphan R2 object when publish throws (D1 transient)", async () => {
    const { coordinator, deleteObject, releaseCapture } = setupCoordinator();
    mocks.publish.mockRejectedValue(new Error("D1 unavailable"));

    // flushBestEffort (invoked by runMutation) still swallows the rethrow.
    await expect(
      coordinator.runMutation(async () => undefined),
    ).resolves.toBeUndefined();

    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith("capture-key");
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("preserves the live object when publish commits before its response is lost", async () => {
    const { coordinator, deleteObject, releaseCapture } = setupCoordinator();
    mocks.publish.mockRejectedValue(new Error("D1 unavailable"));
    // First read (flush preamble) returns the prior pointer; the re-read after
    // the throw observes the publish actually landed, so the object is live.
    mocks.read
      .mockResolvedValueOnce({
        threadId,
        mutationGeneration: 2,
        latestCaptureId: previousCaptureId,
        activeMutations: 0,
      })
      .mockResolvedValueOnce({
        threadId,
        mutationGeneration: 2,
        latestCaptureId: "chg_repro",
        activeMutations: 0,
      });

    await expect(
      coordinator.runMutation(async () => undefined),
    ).resolves.toBeUndefined();

    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("does not delete and rethrows the original error when the confirmatory re-read fails", async () => {
    const { coordinator, deleteObject, releaseCapture } = setupCoordinator();
    mocks.publish.mockRejectedValue(new Error("D1 unavailable"));
    mocks.read
      .mockResolvedValueOnce({
        threadId,
        mutationGeneration: 2,
        latestCaptureId: previousCaptureId,
        activeMutations: 0,
      })
      .mockRejectedValueOnce(new Error("D1 read unavailable"));

    // Calling flush() directly surfaces the rethrown cause (runMutation would
    // swallow it via flushBestEffort); the original publish error must win.
    await expect(coordinator.flush()).rejects.toThrow("D1 unavailable");

    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    // Cannot confirm the publish did not commit -> safer to leak than to drop a live object.
    expect(deleteObject).not.toHaveBeenCalled();
    expect(releaseCapture).toHaveBeenCalledOnce();
  });
});
