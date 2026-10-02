import { type ThreadChangesCaptureId, ThreadChangesCommitSha } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class ThreadChangesPersistenceUnavailable extends Schema.TaggedError<ThreadChangesPersistenceUnavailable>()(
  "ThreadChangesPersistenceUnavailable",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const StateRowSchema = Schema.Struct({
  thread_id: Schema.String,
  mutation_generation: Schema.Number,
  latest_capture_id: Schema.NullOr(Schema.String),
  latest_capture_generation: Schema.NullOr(Schema.Number),
  latest_fingerprint: Schema.NullOr(Schema.String),
  latest_captured_at: Schema.NullOr(Schema.String),
  dirty_since: Schema.NullOr(Schema.String),
  summary_additions: Schema.optional(Schema.NullOr(Schema.Number)),
  summary_deletions: Schema.optional(Schema.NullOr(Schema.Number)),
  summary_files: Schema.optional(Schema.NullOr(Schema.Number)),
  shadow_refresh_token: Schema.NullOr(Schema.String),
  active_mutations: Schema.Number,
});

const SourceRowSchema = Schema.Struct({
  initial_commit_sha: ThreadChangesCommitSha,
  default_branch: Schema.String,
  repository_full_name: Schema.String,
});

const MutationLeaseRowSchema = Schema.Struct({ generation: Schema.Number });

export interface ThreadChangesState {
  readonly threadId: ThreadId;
  readonly mutationGeneration: number;
  readonly latestCaptureId?: ThreadChangesCaptureId;
  readonly latestCaptureGeneration?: number;
  readonly latestFingerprint?: string;
  readonly latestCapturedAt?: string;
  readonly dirtySince?: string;
  readonly summary?: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
  };
  readonly refreshToken?: string;
  readonly activeMutations: number;
}

export interface ThreadChangesSource {
  readonly baseline: string;
  readonly defaultBranch: string;
  readonly repositoryName: string;
}

export interface ThreadChangesMutationLease {
  readonly generation: number;
  readonly refreshToken: string;
  readonly renew: (durationMs: number) => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface ThreadChangesCaptureLease {
  readonly token: string;
  readonly expiresAt: number;
  /** State and source read in the same transaction that took the lease. */
  readonly state?: ThreadChangesState;
  readonly source?: ThreadChangesSource;
  readonly release: () => Promise<void>;
}

const unavailable = (operation: string, cause?: unknown) =>
  new ThreadChangesPersistenceUnavailable({ operation, cause });

const ensureStateStatement = (
  db: D1Database,
  threadId: ThreadId,
  now: string,
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO thread_changes_state (thread_id, updated_at)
       VALUES (?, ?)`,
    )
    .bind(threadId, now);

const decodeState = (raw: unknown): ThreadChangesState | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const row = Schema.decodeUnknownSync(StateRowSchema)(raw);
  return {
    threadId: row.thread_id as ThreadId,
    mutationGeneration: row.mutation_generation,
    ...(row.latest_capture_id === null
      ? {}
      : {
          latestCaptureId: row.latest_capture_id as ThreadChangesCaptureId,
        }),
    ...(row.latest_capture_generation === null
      ? {}
      : { latestCaptureGeneration: row.latest_capture_generation }),
    ...(row.latest_fingerprint === null
      ? {}
      : { latestFingerprint: row.latest_fingerprint }),
    ...(row.latest_captured_at === null
      ? {}
      : { latestCapturedAt: row.latest_captured_at }),
    ...(row.dirty_since === null ? {} : { dirtySince: row.dirty_since }),
    ...(row.summary_additions == null ||
    row.summary_deletions == null ||
    row.summary_files == null
      ? {}
      : {
          summary: {
            additions: row.summary_additions,
            deletions: row.summary_deletions,
            files: row.summary_files,
          },
        }),
    ...(row.shadow_refresh_token === null
      ? {}
      : { refreshToken: row.shadow_refresh_token }),
    activeMutations: row.active_mutations,
  };
};

const decodeSource = (raw: unknown): ThreadChangesSource | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const row = Schema.decodeUnknownSync(SourceRowSchema)(raw);
  return {
    baseline: row.initial_commit_sha,
    defaultBranch: row.default_branch,
    repositoryName: row.repository_full_name,
  };
};

export const makeThreadChangesRepository = (db: D1Database) => {
  const stateStatements = (threadId: ThreadId, now: number) => [
    db
      .prepare(
        "DELETE FROM thread_changes_mutation_lease WHERE thread_id = ? AND expires_at <= ?",
      )
      .bind(threadId, now),
    db
      .prepare(
        `SELECT state.*,
                (SELECT count(*) FROM thread_changes_mutation_lease AS lease
                  WHERE lease.thread_id = state.thread_id
                    AND lease.expires_at > ?) AS active_mutations
           FROM thread_changes_state AS state
          WHERE state.thread_id = ?
          LIMIT 1`,
      )
      .bind(now, threadId),
  ];

  const sourceStatement = (threadId: ThreadId) =>
    db
      .prepare(
        `SELECT initial_commit_sha, default_branch, repository_full_name
           FROM thread_source_snapshot
          WHERE thread_id = ?
          UNION ALL
         SELECT ?, 'main', project.name
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM project_repository WHERE project_id = project.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM thread_source_snapshot WHERE thread_id = thread.id
            )
          LIMIT 1`,
      )
      .bind(threadId, EMPTY_TREE_SHA, threadId);

  const read = async (
    threadId: ThreadId,
  ): Promise<ThreadChangesState | undefined> => {
    try {
      const [, selected] = await db.batch(
        stateStatements(threadId, Date.now()),
      );
      return decodeState(selected?.results[0]);
    } catch (cause) {
      throw unavailable("thread-changes.state.read", cause);
    }
  };

  const source = async (
    threadId: ThreadId,
  ): Promise<ThreadChangesSource | undefined> => {
    try {
      return decodeSource(await sourceStatement(threadId).first());
    } catch (cause) {
      throw unavailable("thread-changes.source.read", cause);
    }
  };

  /**
   * Record a resident filesystem hint in one round trip: bump the generation,
   * keep the oldest dirty time, and mint the only token a candidate may carry.
   * No mutation lease is held, so the capture it requests can publish as
   * complete once nothing else is mutating. With `holdCaptureMs` the same
   * batch also takes (or renews `held`) the capture lease and reads the state
   * after the mark, so the candidate can be validated without another trip.
   */
  const markDirty = async (
    threadId: ThreadId,
    refreshToken: string = crypto.randomUUID(),
    hold?: {
      readonly holdCaptureMs: number;
      readonly held?: ThreadChangesCaptureLease;
    },
  ): Promise<{
    readonly refreshToken: string;
    readonly latestFingerprint?: string;
    readonly capture?: ThreadChangesCaptureLease;
  }> => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const leaseToken = hold?.held?.token ?? crypto.randomUUID();
    const expiresAt = nowMs + Math.max(1_000, hold?.holdCaptureMs ?? 0);
    try {
      const [, marked, leased, , state, source] = await db.batch([
        ensureStateStatement(db, threadId, now),
        db
          .prepare(
            `UPDATE thread_changes_state
                SET mutation_generation = mutation_generation + 1,
                    dirty_since = COALESCE(dirty_since, ?),
                    shadow_refresh_token = ?,
                    updated_at = ?
              WHERE thread_id = ?
          RETURNING latest_fingerprint`,
          )
          .bind(now, refreshToken, now, threadId),
        ...(hold === undefined
          ? []
          : [
              captureLeaseStatement(threadId, leaseToken, expiresAt, nowMs),
              ...stateStatements(threadId, nowMs),
              sourceStatement(threadId),
            ]),
      ]);
      const row = marked?.results[0] as
        | { readonly latest_fingerprint: string | null }
        | undefined;
      if (row === undefined) throw unavailable("thread-changes.mark-dirty");
      return {
        refreshToken,
        ...(row.latest_fingerprint === null
          ? {}
          : { latestFingerprint: row.latest_fingerprint }),
        ...(leased?.meta.changes === 1
          ? {
              capture: captureLease(
                threadId,
                leaseToken,
                expiresAt,
                state?.results[0],
                source?.results[0],
              ),
            }
          : {}),
      };
    } catch (cause) {
      if (cause instanceof ThreadChangesPersistenceUnavailable) throw cause;
      throw unavailable("thread-changes.mark-dirty", cause);
    }
  };

  const beginMutation = async (
    threadId: ThreadId,
    durationMs: number,
  ): Promise<ThreadChangesMutationLease> => {
    const leaseToken = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = Date.now() + Math.max(1_000, durationMs);
    try {
      const result = await db.batch([
        ensureStateStatement(db, threadId, now),
        db
          .prepare(
            `UPDATE thread_changes_state
                SET mutation_generation = mutation_generation + 1,
                    dirty_since = COALESCE(dirty_since, ?),
                    shadow_refresh_token = ?,
                    updated_at = ?
              WHERE thread_id = ?`,
          )
          .bind(now, refreshToken, now, threadId),
        db
          .prepare(
            `INSERT INTO thread_changes_mutation_lease (
               thread_id, lease_token, generation, expires_at, created_at
             )
             SELECT thread_id, ?, mutation_generation, ?, ?
               FROM thread_changes_state
              WHERE thread_id = ?`,
          )
          .bind(leaseToken, expiresAt, now, threadId),
      ]);
      if (result[1]?.meta.changes !== 1 || result[2]?.meta.changes !== 1)
        throw unavailable("thread-changes.mutation.begin");
      const rawLease = await db
        .prepare(
          `SELECT generation
             FROM thread_changes_mutation_lease
            WHERE thread_id = ? AND lease_token = ?
            LIMIT 1`,
        )
        .bind(threadId, leaseToken)
        .first();
      if (rawLease === null) throw unavailable("thread-changes.mutation.begin");
      const leaseRow = Schema.decodeUnknownSync(MutationLeaseRowSchema)(
        rawLease,
      );
      let released = false;
      return {
        generation: leaseRow.generation,
        refreshToken,
        renew: async (nextDurationMs) => {
          if (released) return;
          try {
            const renewed = await db
              .prepare(
                `UPDATE thread_changes_mutation_lease
                    SET expires_at = ?
                  WHERE thread_id = ? AND lease_token = ?`,
              )
              .bind(
                Date.now() + Math.max(1_000, nextDurationMs),
                threadId,
                leaseToken,
              )
              .run();
            if (renewed.meta.changes !== 1)
              throw unavailable("thread-changes.mutation.renew");
          } catch (cause) {
            if (cause instanceof ThreadChangesPersistenceUnavailable)
              throw cause;
            throw unavailable("thread-changes.mutation.renew", cause);
          }
        },
        release: async () => {
          if (released) return;
          try {
            await db
              .prepare(
                `DELETE FROM thread_changes_mutation_lease
                  WHERE thread_id = ? AND lease_token = ?`,
              )
              .bind(threadId, leaseToken)
              .run();
            released = true;
          } catch (cause) {
            throw unavailable("thread-changes.mutation.release", cause);
          }
        },
      };
    } catch (cause) {
      if (cause instanceof ThreadChangesPersistenceUnavailable) throw cause;
      throw unavailable("thread-changes.mutation.begin", cause);
    }
  };

  const captureLeaseStatement = (
    threadId: ThreadId,
    token: string,
    expiresAt: number,
    now: number,
  ) =>
    db
      .prepare(
        `INSERT INTO thread_changes_capture_lease (
           thread_id, lease_token, expires_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           lease_token = excluded.lease_token,
           expires_at = excluded.expires_at
         WHERE thread_changes_capture_lease.expires_at <= ?
            OR thread_changes_capture_lease.lease_token = excluded.lease_token`,
      )
      .bind(threadId, token, expiresAt, now);

  const captureLease = (
    threadId: ThreadId,
    token: string,
    expiresAt: number,
    state: unknown,
    source: unknown,
  ): ThreadChangesCaptureLease => {
    let released = false;
    const leased = decodeState(state);
    const leasedSource = decodeSource(source);
    return {
      token,
      expiresAt,
      ...(leased === undefined ? {} : { state: leased }),
      ...(leasedSource === undefined ? {} : { source: leasedSource }),
      release: async () => {
        if (released) return;
        try {
          await db
            .prepare(
              `DELETE FROM thread_changes_capture_lease
                WHERE thread_id = ? AND lease_token = ?`,
            )
            .bind(threadId, token)
            .run();
          released = true;
        } catch (cause) {
          throw unavailable("thread-changes.capture.release", cause);
        }
      },
    };
  };

  const acquireCapture = async (
    threadId: ThreadId,
    durationMs: number,
  ): Promise<ThreadChangesCaptureLease | undefined> => {
    const token = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + Math.max(1_000, durationMs);
    try {
      // One round trip: take the lease and read what the holder validates.
      const [, result, , state, source] = await db.batch([
        ensureStateStatement(db, threadId, new Date(now).toISOString()),
        captureLeaseStatement(threadId, token, expiresAt, now),
        ...stateStatements(threadId, now),
        sourceStatement(threadId),
      ]);
      if (result?.meta.changes !== 1) return undefined;
      return captureLease(
        threadId,
        token,
        expiresAt,
        state?.results[0],
        source?.results[0],
      );
    } catch (cause) {
      throw unavailable("thread-changes.capture.acquire", cause);
    }
  };

  const publish = async (input: {
    readonly threadId: ThreadId;
    readonly generation: number;
    readonly captureId: ThreadChangesCaptureId;
    readonly fingerprint: string;
    readonly capturedAt: string;
    readonly summary?: {
      readonly additions: number;
      readonly deletions: number;
      readonly files: number;
    };
    readonly preview?: boolean;
  }) => {
    try {
      const result = await db
        .prepare(
          `UPDATE thread_changes_state
              SET latest_capture_id = ?,
                  latest_capture_generation = ?,
                  latest_fingerprint = ?,
                  latest_captured_at = ?,
                  summary_additions = ?,
                  summary_deletions = ?,
                  summary_files = ?,
                  dirty_since = CASE WHEN ? = 1 THEN dirty_since ELSE NULL END,
                  updated_at = ?
            WHERE thread_id = ?
              AND mutation_generation = ?
              AND (? = 1 OR NOT EXISTS (
                SELECT 1 FROM thread_changes_mutation_lease
                 WHERE thread_id = ? AND expires_at > ?
              ))`,
        )
        .bind(
          input.captureId,
          input.generation,
          input.fingerprint,
          input.capturedAt,
          input.summary?.additions ?? null,
          input.summary?.deletions ?? null,
          input.summary?.files ?? null,
          input.preview ? 1 : 0,
          input.capturedAt,
          input.threadId,
          input.generation,
          input.preview ? 1 : 0,
          input.threadId,
          Date.now(),
        )
        .run();
      return result.meta.changes === 1;
    } catch (cause) {
      throw unavailable("thread-changes.capture.publish", cause);
    }
  };

  const confirmUnchanged = async (input: {
    readonly threadId: ThreadId;
    readonly generation: number;
    readonly captureId: ThreadChangesCaptureId;
    readonly fingerprint: string;
  }) => {
    const now = new Date().toISOString();
    try {
      const result = await db
        .prepare(
          `UPDATE thread_changes_state
              SET dirty_since = NULL,
                  updated_at = ?
            WHERE thread_id = ?
              AND mutation_generation = ?
              AND latest_capture_id = ?
              AND latest_fingerprint = ?
              AND NOT EXISTS (
                SELECT 1 FROM thread_changes_mutation_lease
                 WHERE thread_id = ? AND expires_at > ?
              )`,
        )
        .bind(
          now,
          input.threadId,
          input.generation,
          input.captureId,
          input.fingerprint,
          input.threadId,
          Date.now(),
        )
        .run();
      return result.meta.changes === 1;
    } catch (cause) {
      throw unavailable("thread-changes.capture.confirm-unchanged", cause);
    }
  };

  return {
    read,
    source,
    markDirty,
    beginMutation,
    acquireCapture,
    publish,
    confirmUnchanged,
  };
};
