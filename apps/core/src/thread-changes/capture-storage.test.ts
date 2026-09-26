import type {
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesPath,
  ThreadChangesWorktreeId,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { describe, expect, it } from "vitest";
import {
  captureKey,
  loadThreadChangesCapture,
  loadThreadChangesIndex,
  loadThreadChangesPatch,
  putThreadChangesCapture,
  ThreadChangesCaptureUnavailable,
  type ThreadChangesManifest,
} from "./capture.js";

const threadId = "thr_00000000-0000-4000-8000-000000000250" as ThreadId;
const captureId =
  "chg_00000000-0000-4000-8000-000000000250" as ThreadChangesCaptureId;
const sha = "1".repeat(40) as ThreadChangesCommitSha;
const unicodePatch = "@@ -1 +1 @@\n-café 🐈\n+東京 🚀\n";

const manifest: ThreadChangesManifest = {
  schemaVersion: 1,
  captureId,
  threadId,
  generation: 2,
  capturedAt: "2026-09-05T00:00:00.000Z",
  fingerprint: "a".repeat(64),
  repositoryName: "example-org/example-repo",
  defaultBranch: "main",
  baseline: sha,
  head: sha,
  ahead: 0,
  commits: [],
  ranges: [
    {
      range: { kind: "all" },
      truncated: false,
      summary: { additions: 2, deletions: 2, files: 2 },
      files: ["one.ts", "two.ts"].map((path) => ({
        path: path as ThreadChangesPath,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        binary: false,
        truncated: false,
        patch: unicodePatch,
      })),
    },
  ],
};

class MemoryR2 {
  body = new Uint8Array();
  metadata: Record<string, string> = {};
  gets: Array<{ offset: number; length: number } | undefined> = [];
  puts = 0;

  async put(_key: string, value: Uint8Array, options: R2PutOptions) {
    this.puts += 1;
    this.body = new Uint8Array(value);
    this.metadata = options.customMetadata ?? {};
    return {} as R2Object;
  }

  async get(_key: string, options?: R2GetOptions) {
    const requested = options?.range;
    const range =
      requested !== undefined && "offset" in requested
        ? {
            offset: requested.offset ?? 0,
            length:
              requested.length ??
              this.body.byteLength - (requested.offset ?? 0),
          }
        : undefined;
    this.gets.push(range);
    const bytes =
      range === undefined
        ? this.body
        : this.body.slice(range.offset, range.offset + range.length);
    return {
      size: this.body.byteLength,
      customMetadata: this.metadata,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    } as unknown as R2ObjectBody;
  }
}

describe("thread changes packed R2 storage", () => {
  it("selects same-path patches by worktree identity", async () => {
    const primary = "primary" as ThreadChangesWorktreeId;
    const linked = "wt_0123456789abcdef" as ThreadChangesWorktreeId;
    const collision: ThreadChangesManifest = {
      ...manifest,
      worktrees: [
        { id: primary, name: "dx", head: sha, branch: "main" },
        { id: linked, name: "agent-worktree", head: sha, branch: "agent" },
      ],
      ranges: [
        {
          range: { kind: "all" },
          truncated: false,
          summary: { additions: 2, deletions: 0, files: 2 },
          files: [
            {
              worktree: primary,
              path: "same.ts" as ThreadChangesPath,
              status: "modified",
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
              patch: "+primary\n",
            },
            {
              worktree: linked,
              path: "same.ts" as ThreadChangesPath,
              status: "modified",
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
              patch: "+linked\n",
            },
          ],
        },
      ],
    };
    const memory = new MemoryR2();
    const bucket = memory as unknown as R2Bucket;
    await putThreadChangesCapture(bucket, collision);

    await expect(
      loadThreadChangesPatch(
        bucket,
        threadId,
        captureId,
        { kind: "all" },
        "same.ts",
        primary,
      ),
    ).resolves.toBe("+primary\n");
    await expect(
      loadThreadChangesPatch(
        bucket,
        threadId,
        captureId,
        { kind: "all" },
        "same.ts",
        linked,
      ),
    ).resolves.toBe("+linked\n");
  });

  it("round trips Unicode, reads one selected patch, and deduplicates patches", async () => {
    const memory = new MemoryR2();
    const bucket = memory as unknown as R2Bucket;
    await putThreadChangesCapture(bucket, manifest);

    expect(memory.puts).toBe(1);
    expect(captureKey(threadId, captureId)).toContain("/changes/v1/");
    const index = await loadThreadChangesIndex(bucket, threadId, captureId);
    expect(index.ranges[0]?.files[0]?.patch).toEqual(
      index.ranges[0]?.files[1]?.patch,
    );
    expect(memory.gets).toHaveLength(1);

    memory.gets = [];
    await expect(
      loadThreadChangesPatch(
        bucket,
        threadId,
        captureId,
        { kind: "all" },
        "one.ts",
        "primary" as ThreadChangesWorktreeId,
      ),
    ).resolves.toBe(unicodePatch);
    expect(memory.gets).toHaveLength(2);
    expect(memory.gets[1]?.length).toBe(
      new TextEncoder().encode(unicodePatch).byteLength,
    );

    await expect(
      loadThreadChangesCapture(bucket, threadId, captureId),
    ).resolves.toEqual(manifest);
  });

  it("reads legacy JSON captures", async () => {
    const memory = new MemoryR2();
    memory.body = new TextEncoder().encode(JSON.stringify(manifest));
    await expect(
      loadThreadChangesCapture(
        memory as unknown as R2Bucket,
        threadId,
        captureId,
      ),
    ).resolves.toEqual(manifest);
  });

  it("contains corrupt metadata and references without exposing content", async () => {
    const memory = new MemoryR2();
    await putThreadChangesCapture(memory as unknown as R2Bucket, manifest);
    memory.metadata.indexLength = String(memory.body.byteLength + 1);
    await expect(
      loadThreadChangesIndex(
        memory as unknown as R2Bucket,
        threadId,
        captureId,
      ),
    ).rejects.toMatchObject({
      _tag: "ThreadChangesCaptureUnavailable",
      stage: "object-decode",
    });

    await putThreadChangesCapture(memory as unknown as R2Bucket, manifest);
    const oldIndexLength = Number(memory.metadata.indexLength);
    const index = JSON.parse(
      new TextDecoder().decode(memory.body.slice(0, oldIndexLength)),
    );
    index.ranges[0].files[0].patch.offset = 9_999_999;
    const corruptIndex = new TextEncoder().encode(JSON.stringify(index));
    const patches = memory.body.slice(oldIndexLength);
    memory.body = new Uint8Array(corruptIndex.byteLength + patches.byteLength);
    memory.body.set(corruptIndex);
    memory.body.set(patches, corruptIndex.byteLength);
    memory.metadata.indexLength = String(corruptIndex.byteLength);
    await expect(
      loadThreadChangesIndex(
        memory as unknown as R2Bucket,
        threadId,
        captureId,
      ),
    ).rejects.toBeInstanceOf(ThreadChangesCaptureUnavailable);
  });
});
