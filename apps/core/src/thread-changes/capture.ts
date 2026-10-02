import {
  THREAD_CHANGES_MAX_COMMITS,
  THREAD_CHANGES_MAX_FILES,
  THREAD_CHANGES_MAX_PATCH_BYTES,
  THREAD_CHANGES_MAX_WORKTREES,
  ThreadChangedFileSchema,
  ThreadChangesCaptureId,
  ThreadChangesCommitSchema,
  ThreadChangesCommitSha,
  ThreadChangesRangeSchema,
  type ThreadChangesWorktreeId,
  ThreadChangesWorktreeSchema,
} from "@dx/api";
import { ThreadId, type ThreadId as ThreadIdType } from "@dx/domain";
import type { Sandbox } from "@flue/runtime";
import { Schema } from "effect";
import type { ThreadChangesSource } from "./repository-d1.js";

const CAPTURE_SCHEMA_VERSION = 1 as const;
const CAPTURE_TIMEOUT_MS = 60_000;
const CAPTURE_MAX_OBJECT_BYTES = 8 * 1_024 * 1_024;

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const ThreadChangesCapturedFileSchema = Schema.Struct({
  ...ThreadChangedFileSchema.fields,
  patch: Schema.String,
});

export const ThreadChangesCapturedRangeSchema = Schema.Struct({
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  summary: Schema.Struct({
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
  }),
  files: Schema.Array(ThreadChangesCapturedFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
});

const GuestCaptureSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("changed") }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    baseline: ThreadChangesCommitSha,
    head: ThreadChangesCommitSha,
    branch: Schema.NullOr(Schema.String),
    upstreamLabel: Schema.NullOr(Schema.String),
    ahead: NonNegativeInt,
    commits: Schema.Array(ThreadChangesCommitSchema).check(
      Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
    ),
    worktrees: Schema.optional(
      Schema.Array(ThreadChangesWorktreeSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
      ),
    ),
    ranges: Schema.Array(ThreadChangesCapturedRangeSchema).check(
      Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
    ),
  }),
]);

const GuestProbeSchema = Schema.Struct({
  kind: Schema.Literals(["changed", "unchanged"]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export const ThreadChangesManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CAPTURE_SCHEMA_VERSION),
  captureId: ThreadChangesCaptureId,
  threadId: ThreadId,
  generation: NonNegativeInt,
  capturedAt: Schema.String,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  repositoryName: Schema.String,
  defaultBranch: Schema.String,
  baseline: ThreadChangesCommitSha,
  head: ThreadChangesCommitSha,
  branch: Schema.optional(Schema.String),
  upstreamLabel: Schema.optional(Schema.String),
  ahead: NonNegativeInt,
  commits: Schema.Array(ThreadChangesCommitSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS),
  ),
  worktrees: Schema.optional(
    Schema.Array(ThreadChangesWorktreeSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(THREAD_CHANGES_MAX_WORKTREES),
    ),
  ),
  ranges: Schema.Array(ThreadChangesCapturedRangeSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
  ),
});
export type ThreadChangesManifest = typeof ThreadChangesManifestSchema.Type;

export const ThreadChangesPatchReferenceSchema = Schema.Struct({
  offset: NonNegativeInt,
  length: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(THREAD_CHANGES_MAX_PATCH_BYTES),
  ),
});
export type ThreadChangesPatchReference =
  typeof ThreadChangesPatchReferenceSchema.Type;

export const ThreadChangesIndexedFileSchema = Schema.Struct({
  ...ThreadChangedFileSchema.fields,
  patch: ThreadChangesPatchReferenceSchema,
});

export const ThreadChangesIndexedRangeSchema = Schema.Struct({
  range: ThreadChangesRangeSchema,
  truncated: Schema.Boolean,
  summary: Schema.Struct({
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
  }),
  files: Schema.Array(ThreadChangesIndexedFileSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_FILES),
  ),
});

export const ThreadChangesIndexSchema = Schema.Struct({
  ...ThreadChangesManifestSchema.fields,
  ranges: Schema.Array(ThreadChangesIndexedRangeSchema).check(
    Schema.isMaxLength(THREAD_CHANGES_MAX_COMMITS + 2),
  ),
});
export type ThreadChangesIndex = typeof ThreadChangesIndexSchema.Type;

export class ThreadChangesCaptureUnavailable extends Schema.TaggedError<ThreadChangesCaptureUnavailable>()(
  "ThreadChangesCaptureUnavailable",
  { stage: Schema.String },
) {}

// The request-scoped capture runs the resident daemon binary as a command so
// activation and reconnect repair use exactly the capture and fingerprint the
// daemon's own resident path produces. The guest installs `dxd` on PATH.
const guestProbeCommand = "dxd changes-capture";
const guestCommand = "dxd changes-capture";

export const captureKey = (
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => `threads/${threadId}/changes/v1/${captureId}.json`;

export const probeThreadChanges = async (input: {
  readonly sandbox: Sandbox;
  readonly source: ThreadChangesSource;
  readonly expectedFingerprint: string;
}) => {
  const result = await input.sandbox
    .exec(guestProbeCommand, {
      cwd: input.sandbox.cwd,
      env: {
        DX_CHANGES_PROBE: "1",
        DX_CHANGES_ROOT: input.sandbox.cwd,
        DX_CHANGES_DEFAULT_BRANCH: input.source.defaultBranch,
        DX_CHANGES_EXPECTED_FINGERPRINT: input.expectedFingerprint,
      },
      timeoutMs: CAPTURE_TIMEOUT_MS,
    })
    .catch(() => {
      throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe" });
    });
  if (result.exitCode !== 0)
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-probe-decode" });
  }
  return Schema.decodeUnknownSync(GuestProbeSchema)(decoded);
};

export const captureThreadChanges = async (input: {
  readonly sandbox: Sandbox;
  readonly threadId: ThreadIdType;
  readonly source: ThreadChangesSource;
  readonly generation: number;
  readonly expectedFingerprint?: string;
}): Promise<ThreadChangesManifest | undefined> => {
  const result = await input.sandbox
    .exec(guestCommand, {
      cwd: input.sandbox.cwd,
      env: {
        DX_CHANGES_ROOT: input.sandbox.cwd,
        DX_CHANGES_BASELINE: input.source.baseline,
        DX_CHANGES_DEFAULT_BRANCH: input.source.defaultBranch,
        ...(input.expectedFingerprint === undefined
          ? {}
          : {
              DX_CHANGES_EXPECTED_FINGERPRINT: input.expectedFingerprint,
            }),
      },
      timeoutMs: CAPTURE_TIMEOUT_MS,
    })
    .catch(() => {
      throw new ThreadChangesCaptureUnavailable({ stage: "guest-command" });
    });
  if (result.exitCode !== 0)
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-command" });
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "guest-decode" });
  }
  const capture = Schema.decodeUnknownSync(GuestCaptureSchema)(decoded);
  if (capture.kind === "changed") return undefined;
  const captureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
    `chg_${crypto.randomUUID()}`,
  );
  return Schema.decodeUnknownSync(ThreadChangesManifestSchema)({
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId,
    threadId: input.threadId,
    generation: input.generation,
    capturedAt: new Date().toISOString(),
    fingerprint: capture.fingerprint,
    repositoryName: input.source.repositoryName,
    defaultBranch: input.source.defaultBranch,
    baseline: capture.baseline,
    head: capture.head,
    ...(capture.branch === null ? {} : { branch: capture.branch }),
    ...(capture.upstreamLabel === null
      ? {}
      : { upstreamLabel: capture.upstreamLabel }),
    ahead: capture.ahead,
    commits: capture.commits,
    ...(capture.worktrees === undefined
      ? {}
      : { worktrees: capture.worktrees }),
    ranges: capture.ranges,
  });
};

export const putThreadChangesCapture = async (
  bucket: R2Bucket,
  manifest: ThreadChangesManifest,
) => {
  try {
    const encoder = new TextEncoder();
    const patches: Array<Uint8Array> = [];
    const references = new Map<string, ThreadChangesPatchReference>();
    let patchBytes = 0;
    const ranges = manifest.ranges.map((range) => ({
      ...range,
      files: range.files.map(({ patch, ...file }) => {
        let reference = references.get(patch);
        if (reference === undefined) {
          const encoded = encoder.encode(patch);
          reference = { offset: patchBytes, length: encoded.byteLength };
          references.set(patch, reference);
          patches.push(encoded);
          patchBytes += encoded.byteLength;
        }
        return { ...file, patch: reference };
      }),
    }));
    const index = Schema.decodeUnknownSync(ThreadChangesIndexSchema)(
      { ...manifest, ranges },
      { onExcessProperty: "error" },
    );
    const indexBytes = encoder.encode(JSON.stringify(index));
    const body = new Uint8Array(indexBytes.byteLength + patchBytes);
    body.set(indexBytes);
    let cursor = indexBytes.byteLength;
    for (const patch of patches) {
      body.set(patch, cursor);
      cursor += patch.byteLength;
    }
    if (body.byteLength > CAPTURE_MAX_OBJECT_BYTES)
      throw new Error("capture object exceeds storage bound");
    await bucket.put(captureKey(manifest.threadId, manifest.captureId), body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        capturedAt: manifest.capturedAt,
        schemaVersion: String(manifest.schemaVersion),
        format: "dx-thread-changes-packed-v1",
        indexLength: String(indexBytes.byteLength),
      },
    });
  } catch {
    throw new ThreadChangesCaptureUnavailable({ stage: "object-write" });
  }
};

const INDEX_INITIAL_READ_BYTES = 64 * 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

const decodeIndex = (
  bytes: ArrayBuffer,
  objectSize: number,
  indexLength: number,
) => {
  if (
    !Number.isSafeInteger(indexLength) ||
    indexLength <= 0 ||
    indexLength > objectSize ||
    bytes.byteLength !== indexLength ||
    objectSize > CAPTURE_MAX_OBJECT_BYTES
  )
    throw new Error("invalid capture index bounds");
  const index = Schema.decodeUnknownSync(ThreadChangesIndexSchema)(
    JSON.parse(decoder.decode(bytes)),
    { onExcessProperty: "error" },
  );
  for (const range of index.ranges)
    for (const file of range.files)
      if (
        file.patch.offset > objectSize - indexLength ||
        file.patch.length > objectSize - indexLength - file.patch.offset
      )
        throw new Error("invalid capture patch bounds");
  return index;
};

const readCaptureIndex = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => {
  const checkedThreadId = Schema.decodeUnknownSync(ThreadId)(threadId);
  const checkedCaptureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
    captureId,
  );
  const key = captureKey(checkedThreadId, checkedCaptureId);
  const first = await bucket.get(key, {
    range: { offset: 0, length: INDEX_INITIAL_READ_BYTES },
  });
  if (first === null)
    throw new ThreadChangesCaptureUnavailable({ stage: "object-read" });
  const prefix = await first.arrayBuffer();
  if (first.customMetadata?.format !== "dx-thread-changes-packed-v1") {
    if (first.size > CAPTURE_MAX_OBJECT_BYTES)
      throw new Error("invalid capture bounds");
    const legacy =
      first.size <= prefix.byteLength ? undefined : await bucket.get(key);
    if (legacy === null)
      throw new ThreadChangesCaptureUnavailable({ stage: "object-read" });
    const manifest = Schema.decodeUnknownSync(ThreadChangesManifestSchema)(
      legacy === undefined
        ? JSON.parse(decoder.decode(prefix))
        : await legacy.json(),
      { onExcessProperty: "error" },
    );
    return { kind: "legacy" as const, manifest };
  }
  const indexLength = Number(first.customMetadata.indexLength);
  if (!Number.isSafeInteger(indexLength) || indexLength <= 0)
    throw new Error("invalid capture index metadata");
  const bytes =
    indexLength <= INDEX_INITIAL_READ_BYTES
      ? prefix.slice(0, indexLength)
      : await (async () => {
          if (
            indexLength > first.size ||
            indexLength > CAPTURE_MAX_OBJECT_BYTES
          )
            throw new Error("invalid capture index bounds");
          const object = await bucket.get(key, {
            range: { offset: 0, length: indexLength },
          });
          if (object === null) throw new Error("capture disappeared");
          return object.arrayBuffer();
        })();
  return {
    kind: "packed" as const,
    index: decodeIndex(bytes, first.size, indexLength),
    indexLength,
    objectSize: first.size,
  };
};

const loadedIndexes = new WeakMap<
  ThreadChangesIndex,
  Awaited<ReturnType<typeof readCaptureIndex>>
>();

/** Loads capture metadata and patch byte references using a bounded prefix read. */
export const loadThreadChangesIndex = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
): Promise<ThreadChangesIndex> => {
  try {
    const stored = await readCaptureIndex(bucket, threadId, captureId);
    const index =
      stored.kind === "packed"
        ? stored.index
        : (() => {
            const encoder = new TextEncoder();
            let offset = 0;
            return {
              ...stored.manifest,
              ranges: stored.manifest.ranges.map((range) => ({
                ...range,
                files: range.files.map(({ patch, ...file }) => {
                  const length = encoder.encode(patch).byteLength;
                  const result = { ...file, patch: { offset, length } };
                  offset += length;
                  return result;
                }),
              })),
            };
          })();
    if (index.threadId !== threadId || index.captureId !== captureId)
      throw new Error("capture identity mismatch");
    loadedIndexes.set(index, stored);
    return index;
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};

/** Loads one patch. Packed captures issue a bounded ranged GET for its UTF-8 bytes. */
export const loadThreadChangesPatch = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
  range: ThreadChangesManifest["ranges"][number]["range"],
  path: string,
  worktree: ThreadChangesWorktreeId,
  index?: ThreadChangesIndex,
): Promise<string> => {
  try {
    const stored =
      (index === undefined ? undefined : loadedIndexes.get(index)) ??
      (await readCaptureIndex(bucket, threadId, captureId));
    const metadata = stored.kind === "packed" ? stored.index : stored.manifest;
    if (metadata.threadId !== threadId || metadata.captureId !== captureId)
      throw new Error("capture identity mismatch");
    const selectedRange =
      stored.kind === "packed" ? stored.index.ranges : stored.manifest.ranges;
    const selected = selectedRange.find(
      (candidate) => JSON.stringify(candidate.range) === JSON.stringify(range),
    );
    const file = selected?.files.find(
      (candidate) =>
        candidate.path === path &&
        (candidate.worktree ?? "primary") === worktree,
    );
    if (file === undefined) throw new Error("capture selection not found");
    if (stored.kind === "legacy") return file.patch as string;
    const reference = file.patch as ThreadChangesPatchReference;
    if (reference.length === 0) return "";
    const object = await bucket.get(captureKey(threadId, captureId), {
      range: {
        offset: stored.indexLength + reference.offset,
        length: reference.length,
      },
    });
    if (object === null) throw new Error("capture disappeared");
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== reference.length)
      throw new Error("short capture patch read");
    return decoder.decode(bytes);
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};

export const loadThreadChangesCapture = async (
  bucket: R2Bucket,
  threadId: ThreadIdType,
  captureId: ThreadChangesCaptureId,
) => {
  try {
    const stored = await readCaptureIndex(bucket, threadId, captureId);
    if (stored.kind === "legacy") {
      if (
        stored.manifest.threadId !== threadId ||
        stored.manifest.captureId !== captureId
      )
        throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
      return stored.manifest;
    }
    const patchRegionLength = stored.objectSize - stored.indexLength;
    const patchRegion =
      patchRegionLength === 0
        ? new ArrayBuffer(0)
        : await (async () => {
            const object = await bucket.get(captureKey(threadId, captureId), {
              range: {
                offset: stored.indexLength,
                length: patchRegionLength,
              },
            });
            if (object === null) throw new Error("capture disappeared");
            const bytes = await object.arrayBuffer();
            if (bytes.byteLength !== patchRegionLength)
              throw new Error("short capture patch region read");
            return bytes;
          })();
    const manifest = Schema.decodeUnknownSync(ThreadChangesManifestSchema)({
      ...stored.index,
      ranges: stored.index.ranges.map((range) => ({
        ...range,
        files: range.files.map((file) => ({
          ...file,
          patch: decoder.decode(
            patchRegion.slice(
              file.patch.offset,
              file.patch.offset + file.patch.length,
            ),
          ),
        })),
      })),
    });
    if (manifest.threadId !== threadId || manifest.captureId !== captureId)
      throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
    return manifest;
  } catch (cause) {
    if (cause instanceof ThreadChangesCaptureUnavailable) throw cause;
    throw new ThreadChangesCaptureUnavailable({ stage: "object-decode" });
  }
};
