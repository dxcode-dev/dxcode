import { ThreadChangesCaptureId } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import type { DxdChangesCandidateEvent } from "../execution/dxd/protocol.js";
import { DxdChangesCandidateMessage } from "../execution/dxd/protocol.js";
import { threadChangesLogger } from "../logging.js";
import {
  captureKey,
  putThreadChangesCapture,
  ThreadChangesManifestSchema,
} from "./capture.js";
import { makeThreadChangesRepository } from "./repository-d1.js";

const CAPTURE_LEASE_MS = 90_000;

export type ThreadChangesResidentPublication =
  | "published"
  | "unchanged"
  | "raced"
  | "unavailable"
  | "invalid"
  | "superseded"
  | "busy"
  | "source-missing";

const recordPublication = (
  threadId: ThreadId,
  publication: ThreadChangesResidentPublication,
  candidateKind: DxdChangesCandidateEvent["outcome"]["kind"] | "invalid",
  generation?: number,
) => {
  threadChangesLogger.info("Thread Changes resident candidate settled.", {
    event: "thread_changes_resident_candidate_settled",
    threadId,
    generation,
    candidateKind,
    outcome: publication,
  });
  return publication;
};

const logDeleteFailure = (threadId: ThreadId, stage: string) =>
  threadChangesLogger.warn("Thread Changes resident object cleanup failed.", {
    event: "thread_changes_resident_object_cleanup_failed",
    threadId,
    stage,
  });

export const publishThreadChangesResidentCandidate = async (input: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly threadId: ThreadId;
  readonly candidate: unknown;
  readonly onPublished?: () => Promise<void>;
}): Promise<ThreadChangesResidentPublication> => {
  const decoded = Schema.decodeUnknownOption(DxdChangesCandidateMessage)(
    input.candidate,
    { onExcessProperty: "error" },
  );
  if (Option.isNone(decoded))
    return recordPublication(input.threadId, "invalid", "invalid");
  const candidate: DxdChangesCandidateEvent = decoded.value;
  const repository = makeThreadChangesRepository(input.db);
  const captureLease = await repository.acquireCapture(
    input.threadId,
    CAPTURE_LEASE_MS,
  );
  if (captureLease === undefined)
    return recordPublication(input.threadId, "busy", candidate.outcome.kind);

  let generation: number | undefined;
  let publication: ThreadChangesResidentPublication;
  try {
    const [state, source] = await Promise.all([
      repository.read(input.threadId),
      repository.source(input.threadId),
    ]);
    generation = state?.mutationGeneration;
    if (
      state === undefined ||
      state.refreshToken !== candidate.token ||
      state.dirtySince === undefined
    ) {
      publication = "superseded";
    } else if (candidate.outcome.kind === "raced") {
      publication = "raced";
    } else if (candidate.outcome.kind === "unavailable") {
      publication = "unavailable";
    } else if (candidate.outcome.kind === "unchanged") {
      publication =
        state.latestCaptureId !== undefined &&
        state.latestFingerprint === candidate.outcome.fingerprint &&
        (state.activeMutations > 0 ||
          (await repository.confirmUnchanged({
            threadId: input.threadId,
            generation: state.mutationGeneration,
            captureId: state.latestCaptureId,
            fingerprint: candidate.outcome.fingerprint,
          })))
          ? "unchanged"
          : "raced";
    } else if (source === undefined) {
      publication = "source-missing";
    } else if (candidate.outcome.capture.baseline !== source.baseline) {
      publication = "invalid";
    } else {
      const captureId = Schema.decodeUnknownSync(ThreadChangesCaptureId)(
        `chg_${crypto.randomUUID()}`,
      );
      const capturedAt = new Date().toISOString();
      const content = candidate.outcome.capture;
      const manifest = Schema.decodeUnknownSync(ThreadChangesManifestSchema)({
        schemaVersion: 1,
        captureId,
        threadId: input.threadId,
        generation: state.mutationGeneration,
        capturedAt,
        fingerprint: content.fingerprint,
        repositoryName: source.repositoryName,
        defaultBranch: source.defaultBranch,
        baseline: content.baseline,
        head: content.head,
        ...(content.branch === null ? {} : { branch: content.branch }),
        ...(content.upstreamLabel === null
          ? {}
          : { upstreamLabel: content.upstreamLabel }),
        ahead: content.ahead,
        commits: content.commits,
        ...(content.worktrees === undefined
          ? {}
          : { worktrees: content.worktrees }),
        ranges: content.ranges,
      });
      try {
        await putThreadChangesCapture(input.bucket, manifest);
      } catch {
        publication = "unavailable";
        return recordPublication(
          input.threadId,
          publication,
          candidate.outcome.kind,
          generation,
        );
      }
      let published: boolean;
      try {
        const summary = manifest.ranges.find(
          ({ range }) => range.kind === "all",
        )?.summary;
        published = await repository.publish({
          threadId: input.threadId,
          generation: manifest.generation,
          captureId: manifest.captureId,
          fingerprint: manifest.fingerprint,
          capturedAt: manifest.capturedAt,
          ...(summary === undefined ? {} : { summary }),
          ...(state.activeMutations > 0 ? { preview: true } : {}),
        });
      } catch {
        await input.bucket
          .delete(captureKey(input.threadId, manifest.captureId))
          .catch(() => logDeleteFailure(input.threadId, "orphan-delete"));
        publication = "unavailable";
        return recordPublication(
          input.threadId,
          publication,
          candidate.outcome.kind,
          generation,
        );
      }
      if (!published) {
        await input.bucket
          .delete(captureKey(input.threadId, manifest.captureId))
          .catch(() => logDeleteFailure(input.threadId, "orphan-delete"));
        publication = "raced";
      } else {
        await input.onPublished?.().catch(() => undefined);
        if (
          state.latestCaptureId !== undefined &&
          state.latestCaptureId !== manifest.captureId
        )
          await input.bucket
            .delete(captureKey(input.threadId, state.latestCaptureId))
            .catch(() => logDeleteFailure(input.threadId, "superseded-delete"));
        publication = "published";
      }
    }
  } finally {
    await captureLease
      .release()
      .catch(() => logDeleteFailure(input.threadId, "capture-lease-release"));
  }

  return recordPublication(
    input.threadId,
    publication,
    candidate.outcome.kind,
    generation,
  );
};
