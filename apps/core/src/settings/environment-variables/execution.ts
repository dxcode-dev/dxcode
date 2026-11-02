import {
  EnvironmentVariableName,
  isReservedEnvironmentVariableName,
  ProjectId,
  ThreadId,
  UserId,
  WorkspaceMembership,
} from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsPersistenceLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import {
  PORTAL_HOST_SUFFIX_VARIABLE,
  portalConfiguration,
  portalHostSuffix,
} from "../../portals/host.js";
import { loadConfigEncryptionKeyring } from "./encryption.js";
import {
  decodeEnvironmentVariableRows,
  ENVIRONMENT_VARIABLE_COLUMNS,
} from "./repository-d1.js";
import {
  type ResolvedEnvironmentVariable,
  selectForExecution,
} from "./service.js";

const ExecutionThreadRow = Schema.Struct({
  project_id: ProjectId,
  owner_user_id: UserId,
});

const portalHostSuffixName = Schema.decodeSync(EnvironmentVariableName)(
  PORTAL_HOST_SUFFIX_VARIABLE,
);

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

/** A variable an execution receives: a resolved setting or one dx provides. */
export type ExecutionEnvironmentValue = Pick<
  ResolvedEnvironmentVariable,
  "name" | "kind" | "value"
>;

export interface ExecutionEnvironmentSnapshot {
  readonly values: ReadonlyArray<ExecutionEnvironmentValue>;
  readonly revision: ExecutionEnvironmentRevision;
}

/** The Thread's owner and Project, as one statement's leading clause. */
const THREAD_CTE =
  "WITH thread AS (SELECT owner_user_id, project_id FROM threads WHERE id = ?1)";

const threadStatement = (db: D1Database, threadId: ThreadId) =>
  db
    .prepare(
      "SELECT project_id, owner_user_id FROM threads WHERE id = ? LIMIT 1",
    )
    .bind(threadId);

/** The revision of each scope an execution of this Thread reads. */
const revisionStatement = (db: D1Database, threadId: ThreadId) =>
  db
    .prepare(
      `${THREAD_CTE},
       participating_scope(scope, target_id) AS (
         SELECT 'personal', (SELECT owner_user_id FROM thread)
         UNION ALL SELECT 'project', (SELECT project_id FROM thread)
         UNION ALL SELECT 'workspace', COALESCE((
           SELECT organizationId FROM member
           WHERE userId = (SELECT owner_user_id FROM thread)
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
    .bind(threadId);

const revisionsFrom = (rows: unknown) => {
  const revisions = Schema.decodeUnknownSync(Schema.Array(RevisionRow))(rows);
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

/** As `WorkspaceRepository.findByUser`: the owner's one workspace, if any. */
const MEMBERSHIP_FROM = `FROM member
  INNER JOIN organization ON organization.id = member.organizationId
  WHERE member.userId = (SELECT owner_user_id FROM thread)
  ORDER BY organization.id`;

const MembershipRow = Schema.Struct({
  workspace_id: Schema.String,
  display_name: Schema.String,
  short_name: Schema.String,
  lifecycle_state: Schema.String,
  profile_revision: Schema.Number,
  avatar_key: Schema.NullOr(Schema.String),
  user_id: Schema.String,
  role: Schema.String,
});

const membershipStatement = (db: D1Database, threadId: ThreadId) =>
  db
    .prepare(
      `${THREAD_CTE}
       SELECT organization.id AS workspace_id,
              organization.name AS display_name,
              organization.slug AS short_name,
              organization.lifecycleState AS lifecycle_state,
              organization.profileRevision AS profile_revision,
              organization.avatar_key,
              member.userId AS user_id,
              member.role
       ${MEMBERSHIP_FROM}
       LIMIT 2`,
    )
    .bind(threadId);

/** One scope's variables, as `EnvironmentVariableRepository.list` reads them. */
const variablesStatement = (
  db: D1Database,
  threadId: ThreadId,
  scope: "personal" | "project" | "workspace",
) =>
  db
    .prepare(
      `${THREAD_CTE}
       SELECT ${ENVIRONMENT_VARIABLE_COLUMNS}
       FROM environment_variable
       WHERE scope = ?2 AND target_id = (${
         scope === "personal"
           ? "SELECT owner_user_id FROM thread"
           : scope === "project"
             ? "SELECT project_id FROM thread"
             : `SELECT organization.id ${MEMBERSHIP_FROM} LIMIT 1`
})
       ORDER BY name ASC, id ASC`,
    )
    .bind(threadId, scope);

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

const threadFrom = (rows: ReadonlyArray<unknown>) => {
  if (rows[0] === undefined) throw new ExecutionEnvironmentUnavailable();
  return Schema.decodeUnknownSync(ExecutionThreadRow)(rows[0]);
};

/**
 * The statements of a revision read, for a caller that adds its own to the
 * same batch (one round trip); `environmentRevisionFrom` reads their results.
 */
export const environmentRevisionStatements = (
  db: D1Database,
  threadId: ThreadId,
) => [threadStatement(db, threadId), revisionStatement(db, threadId)] as const;

/** The revision from `environmentRevisionStatements`' results, in order. */
export const environmentRevisionFrom = (
  results: ReadonlyArray<D1Result | undefined>,
) => {
  threadFrom(results[0]?.results ?? []);
  return revisionsFrom(results[1]?.results);
};

export const resolveExecutionEnvironmentRevision = Effect.fn(
  "resolveExecutionEnvironmentRevision",
)(function* (bindings: Bindings, rawThreadId: string) {
  const startedAt = Date.now();
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionEnvironmentUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  // One round trip: a batch is one transaction.
  const revision = yield* Effect.tryPromise({
    try: async () => {
      return environmentRevisionFrom(
        await db.batch([...environmentRevisionStatements(db, threadId)]),
      );
    },
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  settingsPersistenceLogger.info("Execution environment revision read.", {
    event: "execution_environment_read_timing",
    read: "revision",
    threadId,
    durationMs: Date.now() - startedAt,
  });
  return revision;
});

/**
 * Everything an execution of this Thread receives, read in one round trip.
 * The batch is one D1 transaction, so the values and the revisions they
 * carry are always the same snapshot: the revision check that used to bracket
 * the separate reads holds by construction.
 */
export const resolveExecutionEnvironment = Effect.fn(
  "resolveExecutionEnvironment",
)(function* (bindings: Bindings, rawThreadId: string) {
  const startedAt = Date.now();
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionEnvironmentUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const keyring = yield* loadConfigEncryptionKeyring(bindings).pipe(
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const batch = yield* Effect.tryPromise({
    try: () =>
      db.batch([
        threadStatement(db, threadId),
        revisionStatement(db, threadId),
        variablesStatement(db, threadId, "personal"),
        variablesStatement(db, threadId, "project"),
        membershipStatement(db, threadId),
        variablesStatement(db, threadId, "workspace"),
      ]),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  const [thread, revisions, personal, project, membership, workspace] = batch;
  const { owner, revision } = yield* Effect.try({
    try: () => ({
      owner: threadFrom(thread?.results ?? []).owner_user_id,
      revision: revisionsFrom(revisions?.results),
    }),
    catch: () => new ExecutionEnvironmentUnavailable(),
  });
  // As `WorkspaceRepository.findByUser`: more than one membership is an
  // invariant violation, and the one membership must decode.
  const memberships = membership?.results ?? [];
  if (memberships.length > 1) {
    settingsPersistenceLogger.error(
      "Workspace membership invariant was violated.",
      { event: "workspace_membership_invariant_failed", userId: owner },
    );
    return yield* new ExecutionEnvironmentUnavailable();
  }
  if (memberships[0] !== undefined)
    yield* Schema.decodeUnknownEffect(MembershipRow)(memberships[0]).pipe(
      Effect.flatMap((row) =>
        Schema.decodeUnknownEffect(WorkspaceMembership)({
          workspace: {
            id: row.workspace_id,
            displayName: row.display_name,
            shortName: row.short_name,
            lifecycleState: row.lifecycle_state,
            revision: row.profile_revision,
            ...(row.avatar_key === null ? {} : { avatarKey: row.avatar_key }),
          },
          userId: row.user_id,
          role: row.role,
        }),
      ),
      Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
    );
  const snapshot = yield* Effect.all({
    personal: decodeEnvironmentVariableRows(personal?.results),
    project: decodeEnvironmentVariableRows(project?.results),
    workspace: decodeEnvironmentVariableRows(workspace?.results),
  }).pipe(
    Effect.flatMap((scopes) => selectForExecution(keyring, scopes)),
    Effect.mapError(() => new ExecutionEnvironmentUnavailable()),
  );
  const resolved = { snapshot, revision };
  settingsPersistenceLogger.info("Execution environment read.", {
    event: "execution_environment_read_timing",
    read: "environment",
    threadId,
    durationMs: Date.now() - startedAt,
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
  // The deployment chooses its Portal domain, so the workspace learns it here
  // instead of from a hostname written into a project's dev-server config.
  const portals = portalConfiguration(bindings);
  const values: ReadonlyArray<ExecutionEnvironmentValue> =
    resolved.snapshot.filter(
      ({ name }) =>
        !isReservedEnvironmentVariableName(name) &&
        (portals === undefined || name !== PORTAL_HOST_SUFFIX_VARIABLE),
    );
  return {
    values:
      portals === undefined
        ? values
        : [
            ...values,
            {
              name: portalHostSuffixName,
              kind: "variable",
              value: Redacted.make(portalHostSuffix(portals)),
            },
          ],
    revision: resolved.revision,
  } satisfies ExecutionEnvironmentSnapshot;
});
