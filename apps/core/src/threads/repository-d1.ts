import {
  decodeThreadPageCursor,
  encodeThreadPageCursor,
  InvalidPageCursor,
  PersistenceUnavailable,
  ResolvedPluginSnapshots,
  ResolvedSkillSnapshots,
  Thread,
  ThreadNotFound,
  ThreadRepository,
  ThreadSourceAuthority,
  ThreadSourceIntent,
  ThreadSourceSnapshot,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Schema, SchemaTransformation } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { threadPersistenceLogger } from "../logging.js";

const ThreadRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project_id: Schema.String,
  owner_user_id: Schema.String,
  agent_instructions: Schema.String,
  agent_instructions_revision: Schema.Number,
  agent_instructions_version: Schema.Number,
  model_selection: Schema.String,
  runner_profile_id: Schema.optional(Schema.NullOr(Schema.String)),
  plugin_snapshot_json: Schema.String,
  skill_snapshot_json: Schema.String,
  visibility: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  last_activity_at: Schema.String,
  activity_status: Schema.String,
  lifecycle_state: Schema.String,
  pinned_at: Schema.NullOr(Schema.String),
  title_pending_until: Schema.optional(Schema.NullOr(Schema.String)),
});

type ThreadRow = typeof ThreadRow.Type;
type ThreadObservationError =
  | InvalidPageCursor
  | PersistenceUnavailable
  | Schema.SchemaError
  | ThreadNotFound;

const JsonString = Schema.String.pipe(
  Schema.decodeTo(Schema.Unknown, SchemaTransformation.fromJsonString()),
);

const decodeThreadRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ThreadRow))(rows).pipe(
    Effect.flatMap((decoded) =>
      Effect.all(
        decoded.map((row) =>
          Effect.gen(function* () {
            const selection = yield* Effect.try({
              try: () => JSON.parse(row.model_selection) as unknown,
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "thread.decodeModelSelection" },
                  cause,
                ),
            });
            const plugins = yield* Schema.decodeUnknownEffect(JsonString)(
              row.plugin_snapshot_json,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(ResolvedPluginSnapshots),
              ),
            );
            const skills = yield* Schema.decodeUnknownEffect(JsonString)(
              row.skill_snapshot_json,
            ).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(ResolvedSkillSnapshots),
              ),
            );
            return yield* Schema.decodeUnknownEffect(Thread)({
              id: row.id,
              title: row.title,
              projectId: row.project_id,
              ownerUserId: row.owner_user_id,
              agentInstructions: {
                content: row.agent_instructions,
                revision: row.agent_instructions_revision,
                version: row.agent_instructions_version,
              },
              selection,
              ...(row.runner_profile_id === null ||
              row.runner_profile_id === undefined
                ? {}
                : { runnerProfileId: row.runner_profile_id }),
              plugins,
              skills,
              visibility: row.visibility,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              lastActivityAt: row.last_activity_at,
              activityStatus: row.activity_status,
              lifecycleState: row.lifecycle_state,
              pinnedAt: row.pinned_at ?? undefined,
              ...(row.title_pending_until === null ||
              row.title_pending_until === undefined
                ? {}
                : { titlePendingUntil: row.title_pending_until }),
            });
          }),
        ),
      ),
    ),
  );

const logFailure = (
  error: ThreadObservationError,
  operation: string,
  properties: Record<string, unknown>,
  startedAt: number,
) => {
  const details = {
    operation,
    outcome: error._tag,
    durationMs: Math.round(performance.now() - startedAt),
    ...properties,
  };
  Match.value(error).pipe(
    Match.tag("ThreadNotFound", () =>
      threadPersistenceLogger.info("Thread lookup found no match.", details),
    ),
    Match.tag("InvalidPageCursor", () =>
      threadPersistenceLogger.warn(
        "Thread persistence rejected invalid input.",
        details,
      ),
    ),
    Match.orElse(() =>
      threadPersistenceLogger.error("Thread persistence failed.", details),
    ),
  );
};

const observe = <A, E extends ThreadObservationError, R>(
  operation: string,
  properties: Record<string, unknown>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const startedAt = performance.now();
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          threadPersistenceLogger.info("Thread persistence succeeded.", {
            operation,
            outcome: "success",
            durationMs: Math.round(performance.now() - startedAt),
            ...properties,
          }),
        ),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => logFailure(error, operation, properties, startedAt)),
      ),
    );
  });

export const ThreadRepositoryD1 = Layer.effect(
  ThreadRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const d1: D1Client.D1Client = yield* D1Client.D1Client;
    const unavailable = (operation: string) => (cause: unknown) =>
      PersistenceUnavailable.new({ operation }, cause);

    return ThreadRepository.of({
      insert: (thread, source) =>
        observe(
          "thread.insert",
          { threadId: thread.id },
          Schema.encodeEffect(Thread)(thread).pipe(
            Effect.flatMap((encoded) => {
              const insertThread = sql`
                INSERT INTO threads (
                  id,
                  title,
                  project_id,
                  owner_user_id,
                  agent_instructions,
                  agent_instructions_revision,
                  agent_instructions_version,
                  model_selection,
                  runner_profile_id,
                  plugin_snapshot_json,
                  skill_snapshot_json,
                  visibility,
                  lifecycle_state,
                  title_pending_until,
                  created_at,
                  updated_at
                )
                VALUES (
                  ${encoded.id}, ${encoded.title}, ${encoded.projectId}, ${encoded.ownerUserId},
                  ${encoded.agentInstructions.content},
                  ${encoded.agentInstructions.revision},
                  ${encoded.agentInstructions.version},
                  ${JSON.stringify(encoded.selection)},
                  ${encoded.runnerProfileId ?? null},
                  ${JSON.stringify(encoded.plugins)},
                  ${JSON.stringify(encoded.skills)},
                  ${encoded.visibility ?? "private"},
                  ${encoded.lifecycleState},
                  ${encoded.titlePendingUntil ?? null},
                  ${encoded.createdAt}, ${encoded.updatedAt}
                )
              `;
              if (source === undefined)
                return d1.batch([insertThread] as const).pipe(Effect.asVoid);
              if (source.kind === "pending")
                return Schema.encodeEffect(ThreadSourceIntent)(
                  source.intent,
                ).pipe(
                  Effect.flatMap((intent) =>
                    d1
                      .batch([
                        insertThread,
                        sql`
                          INSERT INTO thread_source_intent (
                            thread_id, project_id, binding_revision, provider,
                            repository_full_name, clone_url, created_at
                          ) SELECT
                            ${intent.threadId}, ${intent.projectId},
                            ${intent.bindingRevision}, ${intent.provider},
                            ${intent.repositoryName}, ${intent.cloneUrl}, ${intent.createdAt}
                          WHERE EXISTS (
                            SELECT 1 FROM project_repository AS repository
                             WHERE repository.project_id = ${intent.projectId}
                               AND repository.binding_revision = ${intent.bindingRevision}
                               AND repository.provider = ${intent.provider}
                               AND repository.full_name = ${intent.repositoryName}
                               AND repository.clone_url = ${intent.cloneUrl}
                          )
                        `,
                        sql`
                          INSERT INTO thread_source_intent_assertion (thread_id)
                          VALUES ((SELECT thread_id FROM thread_source_intent
                            WHERE thread_id = ${intent.threadId}))
                        `,
                        sql`
                          DELETE FROM thread_source_intent_assertion
                          WHERE thread_id = ${intent.threadId}
                        `,
                      ] as const)
                      .pipe(Effect.asVoid),
                  ),
                );
              return Schema.encodeEffect(ThreadSourceSnapshot)(
                source.snapshot,
              ).pipe(
                Effect.flatMap((snapshot) => {
                  const snapshotInsert = sql`
                    INSERT INTO thread_source_snapshot (
                      thread_id, project_id, binding_revision, provider,
                      repository_full_name, clone_url, default_branch,
                      initial_ref, initial_commit_sha, created_at
                    ) VALUES (
                      ${snapshot.threadId}, ${snapshot.projectId},
                      ${snapshot.bindingRevision}, ${snapshot.provider},
                      ${snapshot.repositoryName}, ${snapshot.cloneUrl},
                      ${snapshot.defaultBranch}, ${snapshot.initialRef},
                      ${snapshot.sourceRevision}, ${snapshot.capturedAt}
                    )
                  `;
                  return Schema.encodeEffect(ThreadSourceAuthority)(
                    source.authority,
                  ).pipe(
                    Effect.flatMap((authority) =>
                      d1
                        .batch([
                          insertThread,
                          snapshotInsert,
                          sql`
                        INSERT INTO thread_source_authority (
                          thread_id, owner_grant_id, installation_id,
                          provider_workspace_id, provider_repository_id, authorization_epoch,
                          installation_epoch, policy_revision,
                          private_submodule_repository_ids_json
                        ) VALUES (
                          ${snapshot.threadId}, ${authority.grantId},
                          ${authority.installationId ?? null},
                          ${authority.providerWorkspaceId ?? null}, ${authority.providerRepositoryId},
                          ${authority.authorizationEpoch}, ${authority.installationEpoch},
                          ${authority.policyRevision},
                          ${JSON.stringify(authority.privateSubmoduleRepositoryIds)}
                        )
                      `,
                          sql`
                        INSERT INTO source_admission_assertion (project_id)
                        VALUES ((
                          SELECT binding.project_id
                            FROM project_repository AS repository
                            JOIN project_source_authority AS binding
                              ON binding.project_id = repository.project_id
                             AND binding.binding_revision = repository.binding_revision
                           WHERE repository.project_id = ${snapshot.projectId}
                             AND repository.binding_revision = ${snapshot.bindingRevision}
                             AND repository.provider = ${snapshot.provider}
                             AND repository.full_name = ${snapshot.repositoryName}
                             AND repository.clone_url = ${snapshot.cloneUrl}
                             AND binding.owner_grant_id = ${authority.grantId}
                             AND binding.installation_id IS ${authority.installationId ?? null}
                             AND binding.provider_workspace_id IS ${authority.providerWorkspaceId ?? null}
                             AND binding.provider_repository_id = ${authority.providerRepositoryId}
                             AND binding.default_branch = ${snapshot.defaultBranch}
                             AND binding.authorization_epoch = ${authority.authorizationEpoch}
                             AND binding.installation_epoch = ${authority.installationEpoch}
                             AND binding.policy_revision = ${authority.policyRevision}
                             AND binding.provenance = 'live-grant'
                             AND binding.source_health = 'available'
                             AND (binding.provider = 'bitbucket' OR COALESCE((SELECT epoch FROM github_authorization_epoch
                               WHERE subject_kind = 'owner-grant'
                                 AND subject_id = binding.owner_grant_id), 1)
                               = binding.authorization_epoch)
                             AND (binding.provider = 'bitbucket' OR COALESCE((SELECT epoch FROM github_authorization_epoch
                               WHERE subject_kind = 'installation'
                                 AND subject_id = binding.installation_id), 1)
                               = binding.installation_epoch)
                             AND CASE WHEN binding.owner_scope = 'workspace'
                               THEN COALESCE((SELECT revision FROM workspace_policy
                                 WHERE workspace_id = binding.owner_id), 0) ELSE 0 END
                               = binding.policy_revision
                             AND ((binding.provider = 'github' AND EXISTS (
                               SELECT 1 FROM github_owner_grant AS grant_row
                               JOIN github_installation AS installation
                                 ON installation.installation_id = grant_row.installation_id
                               JOIN github_installation_repository AS entitlement
                                 ON entitlement.installation_id = grant_row.installation_id
                                AND entitlement.provider_repository_id = binding.provider_repository_id
                               WHERE grant_row.id = binding.owner_grant_id
                                 AND grant_row.status = 'active'
                                 AND installation.status = 'active'
                                 AND entitlement.entitled = 1
                             )) OR (binding.provider = 'bitbucket'
                               AND binding.owner_scope = 'personal'
                               AND binding.installation_id IS NULL
                               AND binding.installation_epoch = 0
                               AND binding.policy_revision = 0
                               AND EXISTS (
                                 SELECT 1 FROM bitbucket_connection AS connection
                                 JOIN bitbucket_repository AS entitlement
                                   ON entitlement.connection_id = connection.id
                                  AND entitlement.repository_id = binding.provider_repository_id
                                  AND entitlement.workspace_id = binding.provider_workspace_id
                                WHERE connection.id = binding.owner_grant_id
                                  AND connection.user_id = binding.owner_id
                                  AND connection.status = 'active'
                                  AND connection.authorization_epoch = binding.authorization_epoch
                               )))
                        ))
                      `,
                          sql`
                        DELETE FROM source_admission_assertion
                        WHERE project_id = ${snapshot.projectId}
                      `,
                        ] as const)
                        .pipe(Effect.asVoid),
                    ),
                  );
                }),
              );
            }),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(unavailable("thread.insert")(cause)),
            ),
            Effect.asVoid,
          ),
        ),

      findOwnedById: (threadId, ownerUserId) =>
        observe(
          "thread.findOwnedById",
          { threadId },
          sql<ThreadRow>`
            SELECT
              id,
              title,
              project_id,
              owner_user_id,
              agent_instructions,
              agent_instructions_revision,
              agent_instructions_version,
              model_selection,
              runner_profile_id,
              plugin_snapshot_json,
              skill_snapshot_json,
              visibility,
              created_at,
              updated_at,
              last_activity_at,
              activity_status,
              lifecycle_state,
              pinned_at,
              title_pending_until
            FROM threads
            WHERE id = ${threadId}
              AND owner_user_id = ${ownerUserId}
              AND lifecycle_state != 'deleted'
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(unavailable("thread.findOwnedById")(cause)),
            ),
            Effect.flatMap(decodeThreadRows),
            Effect.flatMap((threads) =>
              threads[0] === undefined
                ? Effect.fail(new ThreadNotFound({ threadId }))
                : Effect.succeed(threads[0]),
            ),
          ),
        ),

      setPinnedAtOwned: (threadId, ownerUserId, pinnedAt) =>
        observe(
          "thread.setPinnedAtOwned",
          { threadId },
          Effect.gen(function* () {
            const encodedPinnedAt =
              pinnedAt === undefined
                ? null
                : Schema.encodeSync(Schema.DateTimeUtcFromString)(pinnedAt);
            yield* sql`
              UPDATE threads
              SET pinned_at = ${encodedPinnedAt}, updated_at = ${encodedPinnedAt ?? new Date().toISOString()}
              WHERE id = ${threadId}
                AND owner_user_id = ${ownerUserId}
                AND lifecycle_state != 'deleted'
                AND (${encodedPinnedAt} IS NULL OR lifecycle_state = 'active')
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(unavailable("thread.setPinnedAtOwned")(cause)),
              ),
            );
            return yield* sql<ThreadRow>`
              SELECT id, title, project_id, owner_user_id, agent_instructions,
                agent_instructions_revision, agent_instructions_version,
                model_selection, runner_profile_id, plugin_snapshot_json, skill_snapshot_json,
                visibility, created_at, updated_at,
                last_activity_at, activity_status, lifecycle_state, pinned_at,
                title_pending_until
              FROM threads
              WHERE id = ${threadId}
                AND owner_user_id = ${ownerUserId}
                AND lifecycle_state != 'deleted'
                AND (${encodedPinnedAt} IS NULL OR lifecycle_state = 'active')
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(unavailable("thread.setPinnedAtOwned")(cause)),
              ),
              Effect.flatMap(decodeThreadRows),
              Effect.flatMap((threads) =>
                threads[0] === undefined
                  ? Effect.fail(new ThreadNotFound({ threadId }))
                  : Effect.succeed(threads[0]),
              ),
            );
          }),
        ),

      setLifecycleStateOwned: (threadId, ownerUserId, lifecycleState) =>
        observe(
          "thread.setLifecycleStateOwned",
          { threadId, lifecycleState },
          Effect.gen(function* () {
            const updatedAt = new Date().toISOString();
            return yield* sql<ThreadRow>`
              UPDATE threads
              SET lifecycle_state = ${lifecycleState},
                  pinned_at = CASE
                    WHEN ${lifecycleState} = 'archived' THEN NULL
                    ELSE pinned_at
                  END,
                  updated_at = ${updatedAt}
              WHERE id = ${threadId}
                AND owner_user_id = ${ownerUserId}
                AND lifecycle_state != 'deleted'
              RETURNING id, title, project_id, owner_user_id, agent_instructions,
                agent_instructions_revision, agent_instructions_version,
                model_selection, runner_profile_id, plugin_snapshot_json, skill_snapshot_json,
                visibility, created_at, updated_at,
                last_activity_at, activity_status, lifecycle_state, pinned_at,
                title_pending_until
            `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(
                  unavailable("thread.setLifecycleStateOwned")(cause),
                ),
              ),
              Effect.flatMap(decodeThreadRows),
              Effect.flatMap((threads) =>
                threads[0] === undefined
                  ? Effect.fail(new ThreadNotFound({ threadId }))
                  : Effect.succeed(threads[0]),
              ),
            );
          }),
        ),

      listOwned: (ownerUserId, projectId, request) =>
        observe(
          "thread.listOwned",
          projectId ? { projectId } : {},
          Effect.gen(function* () {
            const limit = request.limit ?? 20;
            const cursor = request.cursor
              ? yield* decodeThreadPageCursor(request.cursor)
              : undefined;
            if (
              cursor !== undefined &&
              cursor.lifecycleState !== request.lifecycleState
            )
              return yield* Effect.fail(new InvalidPageCursor());
            const snapshotSequence =
              cursor?.snapshotSequence ??
              (yield* sql<{ snapshot_sequence: number | null }>`
                SELECT MAX(sequence) AS snapshot_sequence
                FROM thread_activity
              `.pipe(
                Effect.catchTag("SqlError", (cause) =>
                  Effect.fail(unavailable("thread.listOwned")(cause)),
                ),
                Effect.map((rows) => rows[0]?.snapshot_sequence ?? 0),
              ));
            const snapshotPinSequence =
              (cursor?.ordering === "pin-snapshot"
                ? cursor.snapshotPinSequence
                : undefined) ??
              (yield* sql<{ snapshot_sequence: number | null }>`
                SELECT MAX(sequence) AS snapshot_sequence
                FROM thread_pin_history
              `.pipe(
                Effect.catchTag("SqlError", (cause) =>
                  Effect.fail(unavailable("thread.listOwned")(cause)),
                ),
                Effect.map((rows) => rows[0]?.snapshot_sequence ?? 0),
              ));
            const cursorTime = cursor
              ? Schema.encodeSync(Schema.DateTimeUtcFromString)(
                  cursor.lastActivityAt,
                )
              : undefined;
            const cursorPinnedAt =
              cursor?.ordering === "pin-snapshot" && cursor.pinnedAt
                ? Schema.encodeSync(Schema.DateTimeUtcFromString)(
                    cursor.pinnedAt,
                  )
                : "";
            const cursorPinRank =
              cursor?.ordering === "pin-snapshot" &&
              cursor.pinnedAt !== undefined
                ? 0
                : 1;
            const rows = yield* (
              projectId
                ? cursor?.ordering === "activity"
                  ? sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                        AND scoped.project_id = ${projectId}
                      GROUP BY candidate.thread_id
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      thread.pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.project_id = ${projectId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                      AND (activity.last_activity_at, thread.id) < (${cursorTime}, ${cursor.id})
                    ORDER BY activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
                  : cursor
                    ? sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                        AND scoped.project_id = ${projectId}
                      GROUP BY candidate.thread_id
                    ), pin_snapshot AS (
                      SELECT history.thread_id, history.pinned_at
                      FROM thread_pin_history AS history
                      WHERE history.sequence = (
                        SELECT MAX(candidate.sequence)
                        FROM thread_pin_history AS candidate
                        WHERE candidate.thread_id = history.thread_id
                          AND candidate.sequence <= ${snapshotPinSequence}
                      )
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      pin.pinned_at AS pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    LEFT JOIN pin_snapshot AS pin ON pin.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.project_id = ${projectId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                      AND (
                        CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END > ${cursorPinRank}
                        OR (CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END = ${cursorPinRank}
                          AND (COALESCE(pin.pinned_at, '') < ${cursorPinnedAt}
                            OR (COALESCE(pin.pinned_at, '') = ${cursorPinnedAt}
                              AND (activity.last_activity_at, thread.id) < (${cursorTime}, ${cursor.id}))))
                      )
                    ORDER BY CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END,
                      pin.pinned_at DESC, activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
                    : sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                        AND scoped.project_id = ${projectId}
                      GROUP BY candidate.thread_id
                    ), pin_snapshot AS (
                      SELECT history.thread_id, history.pinned_at
                      FROM thread_pin_history AS history
                      WHERE history.sequence = (
                        SELECT MAX(candidate.sequence)
                        FROM thread_pin_history AS candidate
                        WHERE candidate.thread_id = history.thread_id
                          AND candidate.sequence <= ${snapshotPinSequence}
                      )
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      pin.pinned_at AS pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    LEFT JOIN pin_snapshot AS pin ON pin.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.project_id = ${projectId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                    ORDER BY CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END,
                      pin.pinned_at DESC, activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
                : cursor?.ordering === "activity"
                  ? sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                      GROUP BY candidate.thread_id
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      thread.pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                      AND (activity.last_activity_at, thread.id) < (${cursorTime}, ${cursor.id})
                    ORDER BY activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
                  : cursor
                    ? sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                      GROUP BY candidate.thread_id
                    ), pin_snapshot AS (
                      SELECT history.thread_id, history.pinned_at
                      FROM thread_pin_history AS history
                      WHERE history.sequence = (
                        SELECT MAX(candidate.sequence)
                        FROM thread_pin_history AS candidate
                        WHERE candidate.thread_id = history.thread_id
                          AND candidate.sequence <= ${snapshotPinSequence}
                      )
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      pin.pinned_at AS pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    LEFT JOIN pin_snapshot AS pin ON pin.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                      AND (
                        CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END > ${cursorPinRank}
                        OR (CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END = ${cursorPinRank}
                          AND (COALESCE(pin.pinned_at, '') < ${cursorPinnedAt}
                            OR (COALESCE(pin.pinned_at, '') = ${cursorPinnedAt}
                              AND (activity.last_activity_at, thread.id) < (${cursorTime}, ${cursor.id}))))
                      )
                    ORDER BY CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END,
                      pin.pinned_at DESC, activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
                    : sql<ThreadRow>`
                    WITH snapshot_activity AS (
                      SELECT candidate.thread_id,
                             MAX(candidate.occurred_at) AS last_activity_at
                      FROM thread_activity AS candidate
                      INNER JOIN threads AS scoped
                        ON scoped.id = candidate.thread_id
                      WHERE candidate.sequence <= ${snapshotSequence}
                        AND scoped.owner_user_id = ${ownerUserId}
                      GROUP BY candidate.thread_id
                    ), pin_snapshot AS (
                      SELECT history.thread_id, history.pinned_at
                      FROM thread_pin_history AS history
                      WHERE history.sequence = (
                        SELECT MAX(candidate.sequence)
                        FROM thread_pin_history AS candidate
                        WHERE candidate.thread_id = history.thread_id
                          AND candidate.sequence <= ${snapshotPinSequence}
                      )
                    )
                    SELECT
                      thread.id, thread.title, thread.project_id, thread.owner_user_id,
                      thread.agent_instructions, thread.agent_instructions_revision,
                      thread.agent_instructions_version, thread.model_selection,
                      thread.runner_profile_id, thread.title_pending_until,
                      thread.plugin_snapshot_json, thread.skill_snapshot_json,
                      thread.visibility, thread.created_at,
                      thread.updated_at, activity.last_activity_at,
                      thread.activity_status, thread.lifecycle_state,
                      pin.pinned_at AS pinned_at
                    FROM threads AS thread
                    INNER JOIN snapshot_activity AS activity
                      ON activity.thread_id = thread.id
                    LEFT JOIN pin_snapshot AS pin ON pin.thread_id = thread.id
                    WHERE thread.owner_user_id = ${ownerUserId}
                      AND thread.lifecycle_state != 'deleted'
                      AND (${request.lifecycleState ?? null} IS NULL OR thread.lifecycle_state = ${request.lifecycleState ?? null})
                    ORDER BY CASE WHEN pin.pinned_at IS NULL THEN 1 ELSE 0 END,
                      pin.pinned_at DESC, activity.last_activity_at DESC, thread.id DESC
                    LIMIT ${limit + 1}
                  `
            ).pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(unavailable("thread.listOwned")(cause)),
              ),
            );
            const decoded = yield* decodeThreadRows(rows);
            const items = decoded.slice(0, limit);
            const last = items.at(-1);
            const nextCursor =
              decoded.length > limit && last
                ? cursor?.ordering === "activity"
                  ? yield* encodeThreadPageCursor({
                      ordering: "activity",
                      snapshotSequence,
                      lastActivityAt: last.lastActivityAt,
                      id: last.id,
                    })
                  : yield* encodeThreadPageCursor({
                      ordering: "pin-snapshot",
                      snapshotSequence,
                      snapshotPinSequence,
                      pinnedAt: last.pinnedAt,
                      lastActivityAt: last.lastActivityAt,
                      id: last.id,
                      lifecycleState: request.lifecycleState,
                    })
                : undefined;
            return { items, nextCursor };
          }),
        ),
    });
  }),
);
