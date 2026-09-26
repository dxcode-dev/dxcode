import {
  isReservedEnvironmentVariableName,
  ProjectId,
  ThreadId,
  UserId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { loadConfigEncryptionKeyring } from "./encryption.js";
import { EnvironmentVariableRepositoryD1 } from "./repository-d1.js";
import {
  EnvironmentVariableService,
  type ResolvedEnvironmentVariable,
} from "./service.js";

const ExecutionThreadRow = Schema.Struct({
  project_id: ProjectId,
  owner_user_id: UserId,
});

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RevisionRow = Schema.Struct({
  scope: Schema.Literals(["personal", "project", "workspace"]),
  target_id: Schema.String,
  revision: NonNegativeInt,
});

export class ExecutionEnvironmentUnavailable extends Schema.TaggedError<ExecutionEnvironmentUnavailable>()(
  "ExecutionEnvironmentUnavailable",
  {},
) {}

export interface ExecutionEnvironmentRevision {
  readonly personal: { readonly targetId: string; readonly revision: number };
  readonly project: { readonly targetId: string; readonly revision: number };
  readonly workspace: {
    readonly targetId: string | null;
    readonly revision: number;
  };
}

export interface ExecutionEnvironmentSnapshot {
  readonly values: ReadonlyArray<ResolvedEnvironmentVariable>;
  readonly revision: ExecutionEnvironmentRevision;
}

const revisionsFor = async (
  db: D1Database,
  thread: typeof ExecutionThreadRow.Type,
) => {
  const result = await db
    .prepare(
      `WITH participating_scope(scope, target_id) AS (
         SELECT 'personal', ?
         UNION ALL SELECT 'project', ?
         UNION ALL SELECT 'workspace', COALESCE((
           SELECT organizationId FROM member
           WHERE userId = ?
           ORDER BY organizationId
           LIMIT 1
         ), '')
       )
       SELECT participating_scope.scope,
              participating_scope.target_id,
              COALESCE(environment_variable_scope_revision.revision, 0) AS revision
       FROM participating_scope
       LEFT JOIN environment_variable_scope_revision
         ON environment_variable_scope_revision.scope = participating_scope.scope
        AND environment_variable_scope_revision.target_id = participating_scope.target_id
       ORDER BY participating_scope.scope, participating_scope.target_id`,
    )
    .bind(thread.owner_user_id, thread.project_id, thread.owner_user_id)
    .all();
  const revisions = Schema.decodeUnknownSync(Schema.Array(RevisionRow))(
    result.results,
  );
  const personal = revisions.find(({ scope }) => scope === "personal");
  const project = revisions.find(({ scope }) => scope === "project");
  const workspace = revisions.find(({ scope }) => scope === "workspace");
  if (
    revisions.length !== 3 ||
    personal === undefined ||
    project === undefined ||
    workspace === undefined
  )
    throw new ExecutionEnvironmentUnavailable();
  return {
    personal: {
      targetId: personal.target_id,
      revision: personal.revision,
    },
    project: { targetId: project.target_id, revision: project.revision },
    workspace: {
      targetId: workspace.target_id === "" ? null : workspace.target_id,
      revision: workspace.revision,
    },
  } satisfies ExecutionEnvironmentRevision;
};

export const executionEnvironmentRevisionsEqual = (
  left: ExecutionEnvironmentRevision,
  right: ExecutionEnvironmentRevision,
) =>
  left.personal.targetId === right.personal.targetId &&
  left.personal.revision === right.personal.revision &&
  left.project.targetId === right.project.targetId &&
  left.project.revision === right.project.revision &&
  left.workspace.targetId === right.workspace.targetId &&
  left.workspace.revision === right.workspace.revision;

const resolveRevisionConsistentSnapshotWithRevision = async <
  Snapshot,
  Revision,
>(
  readRevision: () => Promise<Revision>,
  revisionsEqual: (left: Revision, right: Revision) => boolean,
  resolve: () => Promise<Snapshot>,
): Promise<{ readonly snapshot: Snapshot; readonly revision: Revision }> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readRevision();
    const snapshot = await resolve();
    const after = await readRevision();
    if (revisionsEqual(before, after)) return { snapshot, revision: after };
  }
  throw new ExecutionEnvironmentUnavailable();
};

export const resolveRevisionConsistentSnapshot = async <Snapshot>(
  readRevision: () => Promise<string>,
  resolve: () => Promise<Snapshot>,
): Promise<Snapshot> =>
  (
    await resolveRevisionConsistentSnapshotWithRevision(
      readRevision,
      (left, right) => left === right,
      resolve,
    )
  ).snapshot;

const executionThreadFor = async (db: D1Database, threadId: ThreadId) => {
  const row = await db
    .prepare(
      "SELECT project_id, owner_user_id FROM threads WHERE id = ? LIMIT 1",
    )
    .bind(threadId)
    .first();
  if (row === null) throw new ExecutionEnvironmentUnavailable();
  return Schema.decodeUnknownSync(ExecutionThreadRow)(row);
};

export const resolveExecutionEnvironmentRevision = Effect.fn(
  "resolveExecutionEnvironmentRevision",
)(function* (bindings: Bindings, rawThreadId: string) {
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionEnvironmentUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const thread = yield* Effect.tryPromise({
    try: () => executionThreadFor(db, threadId),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  return yield* Effect.tryPromise({
    try: () => revisionsFor(db, thread),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
});

export const resolveExecutionEnvironment = Effect.fn(
  "resolveExecutionEnvironment",
)(function* (bindings: Bindings, rawThreadId: string) {
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionEnvironmentUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const keyring = yield* loadConfigEncryptionKeyring(bindings).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const thread = yield* Effect.tryPromise({
    try: () => executionThreadFor(db, threadId),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const serviceLayer = EnvironmentVariableService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        EnvironmentVariableRepositoryD1(db),
        workspace,
        SettingsAudit.layer,
      ),
    ),
  );
  const resolved = yield* Effect.tryPromise({
    try: () =>
      resolveRevisionConsistentSnapshotWithRevision(
        () => revisionsFor(db, thread),
        executionEnvironmentRevisionsEqual,
        () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* EnvironmentVariableService;
              return yield* service.resolveForExecution(
                keyring,
                thread.owner_user_id,
                thread.project_id,
              );
            }).pipe(
              Effect.provide(serviceLayer),
              Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
            ),
          ),
      ),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  if (
    resolved.snapshot.some(({ name }) =>
      isReservedEnvironmentVariableName(name),
    )
  )
    settingsPersistenceLogger.warn(
      "Reserved legacy environment configuration was excluded from execution.",
      { event: "environment_variable_legacy_validation_failed" },
    );
  return {
    values: resolved.snapshot.filter(
      ({ name }) => !isReservedEnvironmentVariableName(name),
    ),
    revision: resolved.revision,
  } satisfies ExecutionEnvironmentSnapshot;
});
