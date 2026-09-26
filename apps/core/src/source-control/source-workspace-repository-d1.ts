import {
  PersistenceUnavailable,
  SourceWorkspaceRepository,
  ThreadSourceAuthority,
  ThreadSourceIntent,
  ThreadSourceSnapshot,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

const SourceRow = Schema.Struct({
  owner_user_id: Schema.String,
  snapshot_thread_id: Schema.NullOr(Schema.String),
  snapshot_project_id: Schema.NullOr(Schema.String),
  snapshot_binding_revision: Schema.NullOr(Schema.Number),
  snapshot_provider: Schema.NullOr(Schema.String),
  snapshot_repository_full_name: Schema.NullOr(Schema.String),
  snapshot_clone_url: Schema.NullOr(Schema.String),
  snapshot_default_branch: Schema.NullOr(Schema.String),
  snapshot_initial_ref: Schema.NullOr(Schema.String),
  snapshot_initial_commit_sha: Schema.NullOr(Schema.String),
  snapshot_created_at: Schema.NullOr(Schema.String),
  intent_thread_id: Schema.NullOr(Schema.String),
  intent_project_id: Schema.NullOr(Schema.String),
  intent_binding_revision: Schema.NullOr(Schema.Number),
  intent_provider: Schema.NullOr(Schema.String),
  intent_repository_full_name: Schema.NullOr(Schema.String),
  intent_clone_url: Schema.NullOr(Schema.String),
  intent_created_at: Schema.NullOr(Schema.String),
  owner_grant_id: Schema.NullOr(Schema.String),
  installation_id: Schema.NullOr(Schema.String),
  provider_workspace_id: Schema.NullOr(Schema.String),
  provider_repository_id: Schema.NullOr(Schema.String),
  authorization_epoch: Schema.NullOr(Schema.Number),
  installation_epoch: Schema.NullOr(Schema.Number),
  policy_revision: Schema.NullOr(Schema.Number),
  private_submodule_repository_ids_json: Schema.NullOr(Schema.String),
});

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const load = async (db: D1Database, threadId: string) => {
  const raw = await db
    .prepare(`
      SELECT thread.owner_user_id,
             snapshot.thread_id AS snapshot_thread_id,
             snapshot.project_id AS snapshot_project_id,
             snapshot.binding_revision AS snapshot_binding_revision,
             snapshot.provider AS snapshot_provider,
             snapshot.repository_full_name AS snapshot_repository_full_name,
             snapshot.clone_url AS snapshot_clone_url,
             snapshot.default_branch AS snapshot_default_branch,
             snapshot.initial_ref AS snapshot_initial_ref,
             snapshot.initial_commit_sha AS snapshot_initial_commit_sha,
             snapshot.created_at AS snapshot_created_at,
             intent.thread_id AS intent_thread_id,
             intent.project_id AS intent_project_id,
             intent.binding_revision AS intent_binding_revision,
             intent.provider AS intent_provider,
             intent.repository_full_name AS intent_repository_full_name,
             intent.clone_url AS intent_clone_url,
             intent.created_at AS intent_created_at,
             authority.owner_grant_id, authority.installation_id,
             authority.provider_workspace_id,
             authority.provider_repository_id, authority.authorization_epoch,
             authority.installation_epoch, authority.policy_revision,
             authority.private_submodule_repository_ids_json
        FROM threads AS thread
        LEFT JOIN thread_source_snapshot AS snapshot ON snapshot.thread_id = thread.id
        LEFT JOIN thread_source_intent AS intent ON intent.thread_id = thread.id
        LEFT JOIN thread_source_authority AS authority ON authority.thread_id = thread.id
       WHERE thread.id = ?
       LIMIT 1
    `)
    .bind(threadId)
    .first();
  if (raw === null) throw new Error("thread-not-found");
  const row = Schema.decodeUnknownSync(SourceRow)(raw);
  const snapshot =
    row.snapshot_thread_id === null
      ? undefined
      : Schema.decodeUnknownSync(ThreadSourceSnapshot)({
          version: 2,
          threadId: row.snapshot_thread_id,
          projectId: row.snapshot_project_id,
          bindingRevision: row.snapshot_binding_revision,
          provider: row.snapshot_provider,
          repositoryName: row.snapshot_repository_full_name,
          cloneUrl: row.snapshot_clone_url,
          defaultBranch: row.snapshot_default_branch,
          sourceRevision: row.snapshot_initial_commit_sha,
          initialRef: row.snapshot_initial_ref,
          capturedAt: row.snapshot_created_at,
        });
  const intent =
    row.intent_thread_id === null
      ? undefined
      : Schema.decodeUnknownSync(ThreadSourceIntent)({
          version: 1,
          threadId: row.intent_thread_id,
          projectId: row.intent_project_id,
          bindingRevision: row.intent_binding_revision,
          provider: row.intent_provider,
          repositoryName: row.intent_repository_full_name,
          cloneUrl: row.intent_clone_url,
          createdAt: row.intent_created_at,
        });
  const ids = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(row.private_submodule_repository_ids_json ?? "[]"),
  );
  const authority =
    row.owner_grant_id === null
      ? undefined
      : Schema.decodeUnknownSync(ThreadSourceAuthority)({
          threadId,
          grantId: row.owner_grant_id,
          installationId: row.installation_id ?? undefined,
          providerWorkspaceId: row.provider_workspace_id ?? undefined,
          providerRepositoryId: row.provider_repository_id,
          authorizationEpoch: row.authorization_epoch,
          installationEpoch: row.installation_epoch,
          policyRevision: row.policy_revision,
          privateSubmoduleRepositoryIds: ids,
        });
  const privateSubmodules = [];
  for (const repositoryId of ids) {
    const repository = await db
      .prepare(`
        SELECT full_name
          FROM github_installation_repository
         WHERE installation_id = ? AND provider_repository_id = ?
           AND entitled = 1
         LIMIT 1
      `)
      .bind(row.installation_id, repositoryId)
      .first<{ full_name: string }>();
    if (repository === null) throw new Error("submodule-not-entitled");
    privateSubmodules.push({
      providerRepositoryId: repositoryId,
      repositoryName: repository.full_name,
    });
  }
  return {
    actorUserId: row.owner_user_id,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(intent === undefined ? {} : { intent }),
    ...(authority === undefined ? {} : { authority }),
    privateSubmodules,
  };
};

export const SourceWorkspaceRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    SourceWorkspaceRepository,
    SourceWorkspaceRepository.of({
      findByThreadId: (threadId) =>
        Effect.tryPromise({
          try: () => load(db, threadId),
          catch: unavailable("source-workspace.findByThreadId"),
        }),
      finalizeAnonymous: (intent, finalization) =>
        Effect.gen(function* () {
          const snapshot = yield* Schema.decodeUnknownEffect(
            Schema.toType(ThreadSourceSnapshot),
          )({
            version: 2,
            threadId: intent.threadId,
            projectId: intent.projectId,
            bindingRevision: intent.bindingRevision,
            provider: intent.provider,
            repositoryName: intent.repositoryName,
            cloneUrl: intent.cloneUrl,
            defaultBranch: finalization.defaultBranch,
            sourceRevision: finalization.sourceRevision,
            initialRef: finalization.initialRef,
            capturedAt: finalization.capturedAt,
          });
          const encoded =
            yield* Schema.encodeEffect(ThreadSourceSnapshot)(snapshot);
          return yield* Effect.tryPromise({
            try: async () => {
              await db.batch([
                db
                  .prepare(`
                    INSERT INTO thread_source_snapshot (
                      thread_id, project_id, binding_revision, provider,
                      repository_full_name, clone_url, default_branch,
                      initial_ref, initial_commit_sha, created_at
                    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                      FROM thread_source_intent AS intent
                     WHERE intent.thread_id = ?
                       AND intent.project_id = ?
                       AND intent.binding_revision = ?
                       AND intent.provider = ?
                       AND intent.repository_full_name = ?
                       AND intent.clone_url = ?
                    ON CONFLICT(thread_id) DO NOTHING
                  `)
                  .bind(
                    encoded.threadId,
                    encoded.projectId,
                    encoded.bindingRevision,
                    encoded.provider,
                    encoded.repositoryName,
                    encoded.cloneUrl,
                    encoded.defaultBranch,
                    encoded.initialRef,
                    encoded.sourceRevision,
                    encoded.capturedAt,
                    intent.threadId,
                    intent.projectId,
                    intent.bindingRevision,
                    intent.provider,
                    intent.repositoryName,
                    intent.cloneUrl,
                  ),
                db
                  .prepare(`
                    INSERT INTO thread_source_finalization_assertion (thread_id)
                    VALUES ((SELECT thread_id FROM thread_source_snapshot
                      WHERE thread_id = ? AND project_id = ? AND binding_revision = ?
                        AND provider = ? AND repository_full_name = ? AND clone_url = ?
                        AND default_branch = ? AND initial_ref = ?
                        AND initial_commit_sha = ?))
                  `)
                  .bind(
                    encoded.threadId,
                    encoded.projectId,
                    encoded.bindingRevision,
                    encoded.provider,
                    encoded.repositoryName,
                    encoded.cloneUrl,
                    encoded.defaultBranch,
                    encoded.initialRef,
                    encoded.sourceRevision,
                  ),
                db
                  .prepare(
                    "DELETE FROM thread_source_intent WHERE thread_id = ?",
                  )
                  .bind(encoded.threadId),
                db
                  .prepare(
                    "DELETE FROM thread_source_finalization_assertion WHERE thread_id = ?",
                  )
                  .bind(encoded.threadId),
              ]);
              const stored = await load(db, encoded.threadId);
              if (stored.snapshot === undefined)
                throw new Error("source-finalization-missing");
              return stored.snapshot;
            },
            catch: unavailable("source-workspace.finalizeAnonymous"),
          });
        }),
    }),
  );
