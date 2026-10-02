import type { ThreadChangesCaptureId, ThreadChangesCommitSha } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireCapture: vi.fn(),
  read: vi.fn(),
  source: vi.fn(),
  publish: vi.fn(),
  confirmUnchanged: vi.fn(),
  put: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
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
    publish: mocks.publish,
    confirmUnchanged: mocks.confirmUnchanged,
  }),
}));
vi.mock("./capture.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./capture.js")>();
  return { ...original, putThreadChangesCapture: mocks.put };
});
vi.mock("../logging.js", () => ({
  threadChangesLogger: { info: mocks.info, warn: mocks.warn },
}));

import { publishThreadChangesResidentCandidate } from "./resident-publisher.js";

const threadId = "thr_00000000-0000-4000-8000-000000000295" as ThreadId;
const captureId =
  "chg_00000000-0000-4000-8000-000000000294" as ThreadChangesCaptureId;
const baseline = "a".repeat(40) as ThreadChangesCommitSha;
const fingerprint = "b".repeat(64);
const token = "opaque-refresh-token";
const content = {
  fingerprint,
  baseline,
  head: baseline,
  branch: "main",
  upstreamLabel: null,
  ahead: 0,
  commits: [],
  worktrees: [
    { id: "primary", name: "dx", head: baseline, branch: "main" },
    {
      id: "wt_0123456789abcdef",
      name: "agent-worktree",
      head: baseline,
      branch: "journey",
    },
  ],
  ranges: [],
} as const;
const event = (outcome: unknown, refreshToken = token) => ({
  type: "changes-candidate",
  token: refreshToken,
  outcome,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireCapture.mockResolvedValue({
    release: vi.fn(async () => undefined),
  });
  mocks.read.mockResolvedValue({
    threadId,
    mutationGeneration: 7,
    latestCaptureId: captureId,
    latestCaptureGeneration: 6,
    latestFingerprint: fingerprint,
    refreshToken: token,
    dirtySince: "2026-09-01T12:00:00.000Z",
    activeMutations: 0,
  });
  mocks.source.mockResolvedValue({
    baseline,
    defaultBranch: "main",
    repositoryName: "example-org/example-repo",
  });
  mocks.publish.mockResolvedValue(true);
  mocks.confirmUnchanged.mockResolvedValue(true);
  mocks.put.mockResolvedValue(undefined);
});

describe("resident Thread Changes publication", () => {
  it("stamps, writes, and CAS-publishes one complete candidate before deleting the prior object", async () => {
    const deleteObject = vi.fn(async () => undefined);

    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: { delete: deleteObject } as unknown as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("published");

    expect(mocks.put).toHaveBeenCalledOnce();
    const manifest = mocks.put.mock.calls[0]?.[1];
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      threadId,
      generation: 7,
      repositoryName: "example-org/example-repo",
      defaultBranch: "main",
      fingerprint,
      baseline,
      worktrees: content.worktrees,
    });
    expect(mocks.publish).toHaveBeenCalledWith({
      threadId,
      generation: 7,
      captureId: manifest.captureId,
      fingerprint,
      capturedAt: manifest.capturedAt,
    });
    expect(mocks.put.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0] ?? 0,
    );
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith(
      `threads/${threadId}/changes/v1/${captureId}.json`,
    );
  });

  it("notifies as soon as the pointer commits, before cleanup and lease release", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    mocks.acquireCapture.mockResolvedValueOnce({ release });
    const onCommitted = vi.fn(() => {
      expect(mocks.publish).toHaveBeenCalledOnce();
      expect(deleteObject).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: { delete: deleteObject } as unknown as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
        onCommitted,
      }),
    ).resolves.toBe("published");
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    mocks.publish.mockResolvedValue(false);
    onCommitted.mockClear();
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: { delete: vi.fn(async () => undefined) } as unknown as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
        onCommitted,
      }),
    ).resolves.toBe("raced");
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("confirms unchanged only against the current generation, prior capture, and fingerprint", async () => {
    const onCommitted = vi.fn();
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "unchanged", fingerprint }),
        onCommitted,
      }),
    ).resolves.toBe("unchanged");
    expect(onCommitted).toHaveBeenCalledOnce();

    expect(mocks.confirmUnchanged).toHaveBeenCalledExactlyOnceWith({
      threadId,
      generation: 7,
      captureId,
      fingerprint,
    });
    expect(mocks.put).not.toHaveBeenCalled();

    mocks.confirmUnchanged.mockClear();
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "unchanged", fingerprint: "c".repeat(64) }),
        onCommitted,
      }),
    ).resolves.toBe("raced");
    expect(mocks.confirmUnchanged).not.toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("deletes the orphan and preserves the prior pointer when publication CAS loses", async () => {
    const deleteObject = vi.fn(async () => undefined);
    mocks.publish.mockResolvedValue(false);

    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: { delete: deleteObject } as unknown as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("raced");

    const manifest = mocks.put.mock.calls[0]?.[1];
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith(
      `threads/${threadId}/changes/v1/${manifest.captureId}.json`,
    );
    expect(deleteObject).not.toHaveBeenCalledWith(
      `threads/${threadId}/changes/v1/${captureId}.json`,
    );
  });

  it.each([
    [{ kind: "raced" }, "raced"],
    [{ kind: "unavailable", reason: "capture-failed" }, "unavailable"],
  ] as const)(
    "settles %s without touching R2 or D1 publication",
    async (outcome, expected) => {
      await expect(
        publishThreadChangesResidentCandidate({
          db: {} as D1Database,
          bucket: {} as R2Bucket,
          threadId,
          candidate: event(outcome),
        }),
      ).resolves.toBe(expected);
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.confirmUnchanged).not.toHaveBeenCalled();
    },
  );

  it("rejects stale tokens, clean generations, and mismatched baselines but allows marked previews", async () => {
    mocks.read.mockResolvedValueOnce({
      threadId,
      mutationGeneration: 8,
      refreshToken: "newer-refresh-token",
      dirtySince: "2026-09-01T12:00:00.000Z",
      activeMutations: 0,
    });
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("superseded");

    mocks.read.mockResolvedValueOnce({
      threadId,
      mutationGeneration: 7,
      refreshToken: token,
      dirtySince: "2026-09-01T12:00:00.000Z",
      activeMutations: 1,
    });
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("published");
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ preview: true }),
    );
    mocks.put.mockClear();

    mocks.read.mockResolvedValueOnce({
      threadId,
      mutationGeneration: 7,
      refreshToken: token,
      activeMutations: 0,
    });
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("superseded");

    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({
          kind: "complete",
          capture: { ...content, baseline: "c".repeat(40) },
        }),
      }),
    ).resolves.toBe("invalid");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects excess protocol fields before taking the capture lease", async () => {
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: {
          ...event({ kind: "raced" }),
          providerId: "forbidden",
        },
      }),
    ).resolves.toBe("invalid");
    expect(mocks.acquireCapture).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(fingerprint);
  });

  it("does not compete with a request-scoped repair holding the capture lease", async () => {
    mocks.acquireCapture.mockResolvedValueOnce(undefined);
    await expect(
      publishThreadChangesResidentCandidate({
        db: {} as D1Database,
        bucket: {} as R2Bucket,
        threadId,
        candidate: event({ kind: "complete", capture: content }),
      }),
    ).resolves.toBe("busy");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
