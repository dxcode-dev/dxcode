import type { ThreadChangesCommitSha } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireCapture: vi.fn(),
  read: vi.fn(),
  source: vi.fn(),
  beginMutation: vi.fn(),
  publish: vi.fn(),
  confirmUnchanged: vi.fn(),
  probe: vi.fn(),
  capture: vi.fn(),
  load: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./repository-d1.js", () => ({
  makeThreadChangesRepository: () => ({
    acquireCapture: mocks.acquireCapture,
    read: mocks.read,
    source: mocks.source,
    beginMutation: mocks.beginMutation,
    publish: mocks.publish,
    confirmUnchanged: mocks.confirmUnchanged,
  }),
}));
vi.mock("./capture.js", () => ({
  captureKey: () => "capture-key",
  probeThreadChanges: mocks.probe,
  captureThreadChanges: mocks.capture,
  loadThreadChangesCapture: mocks.load,
  putThreadChangesCapture: mocks.put,
}));
vi.mock("../logging.js", () => ({
  threadChangesLogger: { info: vi.fn(), warn: vi.fn() },
}));

import {
  makeResidentThreadChangesTerminalObserver,
  makeThreadChangesCoordinator,
  runResidentThreadChangesMutation,
} from "./coordinator.js";
import { publishThreadChangesResidentCandidate } from "./resident-publisher.js";

const threadId = "thr_00000000-0000-4000-8000-000000000249" as ThreadId;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Thread Changes mutation coordination", () => {
  it("retains one resident Terminal lease across inputs and refreshes only after suspend", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 7,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 7,
      latestFingerprint: "b".repeat(64),
      activeMutations: 1,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    const residentRefresh = vi.fn(async () => true);
    const observer = makeResidentThreadChangesTerminalObserver({
      db: {} as D1Database,
      threadId,
      residentRefresh,
    });

    await observer.beforeInput();
    await observer.beforeInput();

    expect(mocks.beginMutation).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(residentRefresh).not.toHaveBeenCalled();

    await observer.beforeSuspend();

    expect(release).toHaveBeenCalledOnce();
    expect(residentRefresh).toHaveBeenCalledExactlyOnceWith({
      type: "changes-refresh",
      token: "opaque-refresh-token",
      source: { baseline: "a".repeat(40), defaultBranch: "main" },
      expectedFingerprint: "b".repeat(64),
    });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      residentRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("dirties before dispatch, then queues resident capture after settlement without request capture", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 4,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 4,
      latestFingerprint: "b".repeat(64),
      activeMutations: 1,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.acquireCapture.mockResolvedValue(undefined);
    const residentRefresh = vi.fn(async () => true);
    const dispatch = vi.fn(async () => "saved");
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
      residentRefresh,
    });

    await expect(coordinator.runMutation(dispatch)).resolves.toBe("saved");

    expect(residentRefresh).toHaveBeenCalledExactlyOnceWith({
      type: "changes-refresh",
      token: "opaque-refresh-token",
      source: { baseline: "a".repeat(40), defaultBranch: "main" },
      expectedFingerprint: "b".repeat(64),
    });
    expect(mocks.beginMutation.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0] ?? 0,
    );
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      residentRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("lets a quick settled mutation produce an authoritative unchanged confirmation", async () => {
    vi.useFakeTimers();
    let active = true;
    let comparison: Promise<string> | undefined;
    const token = "opaque-refresh-token";
    const fingerprint = "b".repeat(64);
    const releaseMutation = vi.fn(async () => {
      active = false;
    });
    const releaseComparison = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 4,
      refreshToken: token,
      renew: vi.fn(async () => undefined),
      release: releaseMutation,
    });
    mocks.read.mockImplementation(async () => ({
      threadId,
      mutationGeneration: 4,
      latestCaptureId: "chg_00000000-0000-4000-8000-000000000249",
      latestFingerprint: fingerprint,
      refreshToken: token,
      dirtySince: "2026-09-01T12:00:00.000Z",
      activeMutations: active ? 1 : 0,
    }));
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.acquireCapture.mockResolvedValueOnce({ release: releaseComparison });
    mocks.confirmUnchanged.mockResolvedValue(true);
    const bucket = { put: vi.fn() } as unknown as R2Bucket;
    const residentRefresh = vi.fn(async (refresh) => {
      setTimeout(() => {
        comparison = publishThreadChangesResidentCandidate({
          db: {} as D1Database,
          bucket,
          threadId,
          candidate: {
            type: "changes-candidate",
            token: refresh.token,
            outcome: { kind: "unchanged", fingerprint },
          },
        });
      }, 750);
      return true;
    });
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
      residentRefresh,
    });

    await coordinator.runMutation(async () => "saved");
    expect(active).toBe(false);
    expect(comparison).toBeUndefined();
    await vi.advanceTimersByTimeAsync(750);

    await expect(comparison).resolves.toBe("unchanged");
    expect(releaseComparison).toHaveBeenCalledOnce();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("falls back to direct capture when resident dispatch is unavailable", async () => {
    const releaseMutation = vi.fn(async () => undefined);
    const releaseCapture = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release: releaseMutation,
    });
    mocks.acquireCapture.mockResolvedValue({ release: releaseCapture });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 1,
      activeMutations: 0,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.capture.mockResolvedValue({
      captureId: "chg_00000000-0000-4000-8000-000000000249",
      generation: 1,
      fingerprint: "b".repeat(64),
    });
    mocks.publish.mockResolvedValue(true);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: { put: vi.fn(), delete: vi.fn() } as unknown as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
      residentRefresh: vi.fn(async () => {
        throw new Error("daemon disconnected");
      }),
    });

    await coordinator.runMutation(async () => undefined);

    expect(releaseMutation).toHaveBeenCalledOnce();
    expect(mocks.acquireCapture).toHaveBeenCalledOnce();
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(releaseMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireCapture.mock.invocationCallOrder[0] ?? 0,
    );
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("falls back to direct capture when resident dispatch declines", async () => {
    const releaseMutation = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release: releaseMutation,
    });
    mocks.acquireCapture.mockResolvedValue({
      release: vi.fn(async () => undefined),
    });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 1,
      activeMutations: 0,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.capture.mockResolvedValue({
      captureId: "chg_00000000-0000-4000-8000-000000000250",
      generation: 1,
      fingerprint: "c".repeat(64),
    });
    mocks.publish.mockResolvedValue(true);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: { put: vi.fn(), delete: vi.fn() } as unknown as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
      residentRefresh: vi.fn(async () => false),
    });

    await coordinator.runMutation(async () => undefined);

    expect(releaseMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireCapture.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("builds a resident save refresh before dispatch and refreshes again after lease release", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 4,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 4,
      latestFingerprint: "b".repeat(64),
      activeMutations: 1,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    const dispatch = vi.fn(async () => "saved");
    const residentRefresh = vi.fn(async () => true);

    await expect(
      runResidentThreadChangesMutation({
        db: {} as D1Database,
        threadId,
        operation: dispatch,
        residentRefresh,
      }),
    ).resolves.toBe("saved");

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "changes-refresh",
      token: "opaque-refresh-token",
      source: { baseline: "a".repeat(40), defaultBranch: "main" },
      expectedFingerprint: "b".repeat(64),
    });
    expect(mocks.beginMutation.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0] ?? 0,
    );
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      residentRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(residentRefresh).toHaveBeenCalledExactlyOnceWith({
      type: "changes-refresh",
      token: "opaque-refresh-token",
      source: { baseline: "a".repeat(40), defaultBranch: "main" },
      expectedFingerprint: "b".repeat(64),
    });
    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("confirms a save preview after its lease releases without another R2 write", async () => {
    let active = true;
    const token = "opaque-refresh-token";
    const fingerprint = "b".repeat(64);
    mocks.beginMutation.mockResolvedValue({
      generation: 4,
      refreshToken: token,
      renew: vi.fn(async () => undefined),
      release: async () => {
        active = false;
      },
    });
    mocks.read.mockImplementation(async () => ({
      threadId,
      mutationGeneration: 4,
      latestCaptureId: "chg_00000000-0000-4000-8000-000000000249",
      latestFingerprint: fingerprint,
      refreshToken: token,
      dirtySince: "2026-09-01T12:00:00.000Z",
      activeMutations: active ? 1 : 0,
    }));
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.acquireCapture.mockResolvedValue({
      release: vi.fn(async () => undefined),
    });
    mocks.confirmUnchanged.mockResolvedValue(true);
    const confirm = () =>
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: {
          type: "changes-candidate",
          token,
          outcome: { kind: "unchanged", fingerprint },
        },
      });

    await runResidentThreadChangesMutation({
      db: {} as D1Database,
      threadId,
      operation: async () => {
        await expect(confirm()).resolves.toBe("unchanged");
        expect(mocks.confirmUnchanged).not.toHaveBeenCalled();
      },
      residentRefresh: async () => {
        expect(active).toBe(false);
        await expect(confirm()).resolves.toBe("unchanged");
        return true;
      },
    });

    expect(mocks.confirmUnchanged).toHaveBeenCalledOnce();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("allows a local scratch save without inventing a Changes source", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.source.mockResolvedValue(undefined);
    const dispatch = vi.fn(async () => "saved");

    await expect(
      runResidentThreadChangesMutation({
        db: {} as D1Database,
        threadId,
        allowMissingSource: true,
        operation: dispatch,
      }),
    ).resolves.toBe("saved");

    expect(dispatch).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.beginMutation).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("marks activation dirty before attempting its capture", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.acquireCapture.mockResolvedValue(undefined);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    await coordinator.sync();

    expect(mocks.beginMutation).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.acquireCapture).toHaveBeenCalledOnce();
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireCapture.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("renews a lease while a sandbox mutation is still running", async () => {
    vi.useFakeTimers();
    let finish: ((value: string) => void) | undefined;
    const renew = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({ generation: 1, renew, release });
    mocks.acquireCapture.mockResolvedValue(undefined);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    const mutation = coordinator.runMutation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.waitFor(() => expect(mocks.beginMutation).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(renew).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    finish?.("done");
    await expect(mutation).resolves.toBe("done");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the lease and attempts capture when a mutation rejects", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      renew: vi.fn(async () => undefined),
      release,
    });
    mocks.acquireCapture.mockResolvedValue(undefined);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    await expect(
      coordinator.runMutation(async () => {
        throw new Error("command failed");
      }),
    ).rejects.toThrow("command failed");

    expect(release).toHaveBeenCalledOnce();
    expect(mocks.acquireCapture).toHaveBeenCalledOnce();
  });

  it("retries a raced best-effort capture once", async () => {
    const fingerprint = "b".repeat(64);
    const captureId = "chg_00000000-0000-4000-8000-000000000249";
    const releaseMutation = vi.fn(async () => undefined);
    const releaseCapture = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 2,
      renew: vi.fn(async () => undefined),
      release: releaseMutation,
    });
    mocks.acquireCapture.mockResolvedValue({ release: releaseCapture });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 2,
      latestCaptureId: captureId,
      latestFingerprint: fingerprint,
      activeMutations: 0,
    });
    mocks.source.mockResolvedValue({
      baseline: "a".repeat(40),
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.probe.mockResolvedValue({ kind: "unchanged", fingerprint });
    mocks.confirmUnchanged
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    await coordinator.runMutation(async () => undefined, {
      detectUnchanged: true,
    });

    expect(mocks.acquireCapture).toHaveBeenCalledTimes(2);
    expect(mocks.confirmUnchanged).toHaveBeenCalledTimes(2);
    expect(releaseCapture).toHaveBeenCalledTimes(2);
  });

  it("preserves the prior pointer when capture or publication races", async () => {
    const releaseCapture = vi.fn(async () => undefined);
    const deleteObject = vi.fn(async () => undefined);
    const previousCaptureId = "chg_00000000-0000-4000-8000-000000000248";
    const nextCaptureId = "chg_00000000-0000-4000-8000-000000000249";
    const head = "a".repeat(40) as ThreadChangesCommitSha;
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
    mocks.capture.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      schemaVersion: 1,
      captureId: nextCaptureId,
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
    mocks.publish.mockResolvedValue(false);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: { delete: deleteObject } as unknown as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    await expect(coordinator.flush()).resolves.toBe("raced");
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();

    await expect(coordinator.flush()).resolves.toBe("raced");
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.put.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0] ?? 0,
    );
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith("capture-key");
    expect(releaseCapture).toHaveBeenCalledTimes(2);
  });

  it("reuses an unchanged capture after a post-command fingerprint probe", async () => {
    const releaseCapture = vi.fn(async () => undefined);
    const fingerprint = "b".repeat(64);
    const captureId = "chg_00000000-0000-4000-8000-000000000249";
    const head = "a".repeat(40) as ThreadChangesCommitSha;
    mocks.acquireCapture.mockResolvedValue({ release: releaseCapture });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 2,
      latestCaptureId: captureId,
      latestFingerprint: fingerprint,
      activeMutations: 0,
    });
    mocks.source.mockResolvedValue({
      baseline: head,
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    mocks.probe.mockResolvedValue({ kind: "unchanged", fingerprint });
    mocks.confirmUnchanged.mockResolvedValue(true);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });

    await expect(coordinator.flush({ detectUnchanged: true })).resolves.toBe(
      "unchanged",
    );

    expect(mocks.confirmUnchanged).toHaveBeenCalledWith({
      threadId,
      generation: 2,
      captureId,
      fingerprint,
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("seeds a full capture from a changed post-command fingerprint", async () => {
    const releaseCapture = vi.fn(async () => undefined);
    const previousFingerprint = "b".repeat(64);
    const nextFingerprint = "c".repeat(64);
    const head = "a".repeat(40) as ThreadChangesCommitSha;
    mocks.acquireCapture.mockResolvedValue({ release: releaseCapture });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 2,
      latestCaptureId: "chg_00000000-0000-4000-8000-000000000248",
      latestFingerprint: previousFingerprint,
      activeMutations: 0,
    });
    const source = {
      baseline: head,
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    };
    mocks.source.mockResolvedValue(source);
    mocks.probe.mockResolvedValue({
      kind: "changed",
      fingerprint: nextFingerprint,
    });
    mocks.capture.mockResolvedValue(undefined);
    const sandbox = { cwd: "/repo" } as Sandbox;
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox,
    });

    await expect(coordinator.flush({ detectUnchanged: true })).resolves.toBe(
      "raced",
    );

    expect(mocks.capture).toHaveBeenCalledWith({
      sandbox,
      threadId,
      source,
      generation: 2,
      expectedFingerprint: nextFingerprint,
    });
    expect(mocks.confirmUnchanged).not.toHaveBeenCalled();
    expect(releaseCapture).toHaveBeenCalledOnce();
  });
});

describe("Thread Changes terminal coordination", () => {
  it("contains mutation persistence failures within terminal hooks", async () => {
    mocks.beginMutation.mockRejectedValueOnce(new Error("D1 unavailable"));
    mocks.acquireCapture.mockResolvedValue(undefined);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });
    const terminal = coordinator.terminalObserver();

    await expect(terminal.beforeInput()).resolves.toBeUndefined();
    await expect(terminal.beforeSuspend()).resolves.toBeUndefined();
  });

  it("still attempts suspension capture when mutation release fails", async () => {
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      renew: vi.fn(async () => undefined),
      release: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });
    mocks.acquireCapture.mockResolvedValue(undefined);
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });
    const terminal = coordinator.terminalObserver();

    await terminal.beforeInput();
    await expect(terminal.beforeSuspend()).resolves.toBeUndefined();
    expect(mocks.acquireCapture).toHaveBeenCalledOnce();
  });

  it("renews the terminal mutation lease without further input", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({ generation: 1, renew, release });
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });
    const terminal = coordinator.terminalObserver();

    await terminal.beforeInput();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledOnce();

    terminal.close();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("keeps the projection dirty on disconnect because tmux may still mutate", async () => {
    const release = vi.fn(async () => undefined);
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      renew: vi.fn(async () => undefined),
      release,
    });
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: {} as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
    });
    const terminal = coordinator.terminalObserver();

    await terminal.beforeInput();
    terminal.close();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("queues resident refresh after the terminal lease is released for suspension", async () => {
    const releaseMutation = vi.fn(async () => undefined);
    const residentRefresh = vi.fn(async () => true);
    const head = "a".repeat(40) as ThreadChangesCommitSha;
    mocks.beginMutation.mockResolvedValue({
      generation: 1,
      refreshToken: "opaque-refresh-token",
      renew: vi.fn(async () => undefined),
      release: releaseMutation,
    });
    mocks.read.mockResolvedValue({
      threadId,
      mutationGeneration: 1,
      activeMutations: 0,
    });
    mocks.source.mockResolvedValue({
      baseline: head,
      defaultBranch: "main",
      repositoryName: "example-org/example-repo",
    });
    const coordinator = makeThreadChangesCoordinator({
      db: {} as D1Database,
      bucket: { delete: vi.fn() } as unknown as R2Bucket,
      threadId,
      sandbox: { cwd: "/repo" } as Sandbox,
      residentRefresh,
    });
    const terminal = coordinator.terminalObserver();

    await terminal.beforeInput();
    expect(residentRefresh).not.toHaveBeenCalled();
    await terminal.beforeSuspend();

    expect(releaseMutation).toHaveBeenCalledOnce();
    expect(residentRefresh).toHaveBeenCalledOnce();
    expect(releaseMutation.mock.invocationCallOrder[0]).toBeLessThan(
      residentRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
