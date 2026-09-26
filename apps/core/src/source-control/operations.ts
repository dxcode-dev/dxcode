import { Context, Effect, Layer, Schema } from "effect";

export const SourceMutationKind = Schema.Literals([
  "contents-push",
  "workflow-write",
  "pull-request-write",
  "issue-write",
  "actions-write",
]);
export type SourceMutationKind = typeof SourceMutationKind.Type;

export type SourceMutationState =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "reconcile-required";

export interface SourceMutationIntent {
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly providerRepositoryId: string;
  readonly kind: SourceMutationKind;
  readonly expectedRemoteSha?: string;
  readonly intendedSha?: string;
  readonly inputIdentity: string;
}

export interface SourceMutationRecord {
  readonly id: string;
  readonly idempotencyKeyHash: string;
  readonly actorUserId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly providerRepositoryId: string;
  readonly kind: SourceMutationKind;
  readonly expectedRemoteSha?: string;
  readonly intendedSha?: string;
  readonly inputIdentityHash: string;
  readonly state: SourceMutationState;
  readonly attempt: number;
  readonly version: number;
  readonly providerResultOpaqueId?: string;
  readonly providerResultCategory?: string;
}

export class SourceMutationConflict extends Schema.TaggedError<SourceMutationConflict>()(
  "SourceMutationConflict",
  {
    reason: Schema.Literals([
      "idempotency-conflict",
      "state-conflict",
      "remote-conflict",
    ]),
  },
) {}

export class SourceMutationUnavailable extends Schema.TaggedError<SourceMutationUnavailable>()(
  "SourceMutationUnavailable",
  {},
) {}

export class SourceMutationRejected extends Schema.TaggedError<SourceMutationRejected>()(
  "SourceMutationRejected",
  {},
) {}

type SourceMutationError =
  | SourceMutationConflict
  | SourceMutationUnavailable
  | SourceMutationRejected;

export interface SourceMutationRepositoryShape {
  readonly register: (
    intent: SourceMutationIntent,
  ) => Effect.Effect<SourceMutationRecord, SourceMutationError>;
  readonly transition: (
    record: SourceMutationRecord,
    state: Exclude<SourceMutationState, "pending">,
    result?: { readonly id?: string; readonly category?: string },
  ) => Effect.Effect<SourceMutationRecord, SourceMutationError>;
}

export class SourceMutationRepository extends Context.Service<
  SourceMutationRepository,
  SourceMutationRepositoryShape
>()("@dx/core/source-control/SourceMutationRepository") {}

const hexHash = async (value: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

interface OperationRow {
  id: string;
  idempotency_key_hash: string;
  actor_user_id: string;
  project_id: string;
  thread_id: string;
  provider: string;
  provider_repository_id: string;
  semantic_kind: SourceMutationKind;
  expected_remote_sha: string | null;
  intended_sha: string | null;
  input_identity_hash: string;
  state: SourceMutationState;
  attempt: number;
  version: number;
  provider_result_opaque_id: string | null;
  provider_result_category: string | null;
}

const fromRow = (row: OperationRow): SourceMutationRecord => ({
  id: row.id,
  idempotencyKeyHash: row.idempotency_key_hash,
  actorUserId: row.actor_user_id,
  projectId: row.project_id,
  threadId: row.thread_id,
  provider: row.provider,
  providerRepositoryId: row.provider_repository_id,
  kind: row.semantic_kind,
  ...(row.expected_remote_sha === null
    ? {}
    : { expectedRemoteSha: row.expected_remote_sha }),
  ...(row.intended_sha === null ? {} : { intendedSha: row.intended_sha }),
  inputIdentityHash: row.input_identity_hash,
  state: row.state,
  attempt: row.attempt,
  version: row.version,
  ...(row.provider_result_opaque_id === null
    ? {}
    : { providerResultOpaqueId: row.provider_result_opaque_id }),
  ...(row.provider_result_category === null
    ? {}
    : { providerResultCategory: row.provider_result_category }),
});

const mutationUnavailable = () => new SourceMutationUnavailable();

export const SourceMutationRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    SourceMutationRepository,
    SourceMutationRepository.of({
      register: (intent) =>
        Effect.tryPromise({
          try: async () => {
            if (
              intent.idempotencyKey.length < 1 ||
              intent.idempotencyKey.length > 512 ||
              intent.inputIdentity.length < 1 ||
              intent.inputIdentity.length > 16_384
            )
              throw new SourceMutationConflict({
                reason: "idempotency-conflict",
              });
            const idempotencyKeyHash = await hexHash(intent.idempotencyKey);
            const inputIdentityHash = await hexHash(intent.inputIdentity);
            const now = new Date().toISOString();
            const id = `scop_${crypto.randomUUID()}`;
            await db
              .prepare(`
                INSERT OR IGNORE INTO source_control_operation (
                  id, idempotency_key_hash, actor_user_id, project_id, thread_id,
                  provider, provider_repository_id, semantic_kind,
                  expected_remote_sha, intended_sha, input_identity_hash,
                  state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
              `)
              .bind(
                id,
                idempotencyKeyHash,
                intent.actorUserId,
                intent.projectId,
                intent.threadId,
                intent.provider,
                intent.providerRepositoryId,
                intent.kind,
                intent.expectedRemoteSha ?? null,
                intent.intendedSha ?? null,
                inputIdentityHash,
                now,
                now,
              )
              .run();
            const row = await db
              .prepare(`
                SELECT * FROM source_control_operation
                 WHERE thread_id = ? AND provider = ? AND provider_repository_id = ?
                   AND idempotency_key_hash = ? LIMIT 1
              `)
              .bind(
                intent.threadId,
                intent.provider,
                intent.providerRepositoryId,
                idempotencyKeyHash,
              )
              .first<OperationRow>();
            if (row === null) throw new Error("operation-not-found");
            const record = fromRow(row);
            if (
              record.actorUserId !== intent.actorUserId ||
              record.projectId !== intent.projectId ||
              record.provider !== intent.provider ||
              record.kind !== intent.kind ||
              record.expectedRemoteSha !== intent.expectedRemoteSha ||
              record.intendedSha !== intent.intendedSha ||
              record.inputIdentityHash !== inputIdentityHash
            )
              throw new SourceMutationConflict({
                reason: "idempotency-conflict",
              });
            return record;
          },
          catch: (cause) =>
            cause instanceof SourceMutationConflict
              ? cause
              : mutationUnavailable(),
        }),
      transition: (record, state, result) =>
        Effect.tryPromise({
          try: async () => {
            const now = new Date().toISOString();
            const terminal = state === "succeeded" || state === "failed";
            const updated = await db
              .prepare(`
                UPDATE source_control_operation
                   SET state = ?, attempt = attempt + ?, version = version + 1,
                       provider_result_opaque_id = ?, provider_result_category = ?,
                       updated_at = ?, completed_at = ?
                 WHERE id = ? AND version = ? AND thread_id = ?
              `)
              .bind(
                state,
                state === "executing" ? 1 : 0,
                result?.id ?? null,
                result?.category ?? null,
                now,
                terminal ? now : null,
                record.id,
                record.version,
                record.threadId,
              )
              .run();
            if (updated.meta.changes !== 1)
              throw new SourceMutationConflict({ reason: "state-conflict" });
            const row = await db
              .prepare("SELECT * FROM source_control_operation WHERE id = ?")
              .bind(record.id)
              .first<OperationRow>();
            if (row === null) throw new Error("operation-not-found");
            return fromRow(row);
          },
          catch: (cause) =>
            cause instanceof SourceMutationConflict
              ? cause
              : mutationUnavailable(),
        }),
    }),
  );

export type SourceReconciliation =
  | { readonly state: "applied"; readonly id?: string }
  | { readonly state: "not-observed" }
  | { readonly state: "conflict" }
  | { readonly state: "unknown" };

export interface SourceMutationServiceShape {
  readonly execute: <A>(input: {
    readonly intent: SourceMutationIntent;
    readonly reconcile: (
      record: SourceMutationRecord,
    ) => Effect.Effect<SourceReconciliation, unknown>;
    readonly mutate: (
      record: SourceMutationRecord,
    ) => Effect.Effect<
      { readonly value: A; readonly providerId?: string },
      unknown
    >;
  }) => Effect.Effect<A, SourceMutationError | unknown>;
}

export class SourceMutationService extends Context.Service<
  SourceMutationService,
  SourceMutationServiceShape
>()("@dx/core/source-control/SourceMutationService") {}

export const SourceMutationServiceLive = Layer.effect(
  SourceMutationService,
  Effect.gen(function* () {
    const repository = yield* SourceMutationRepository;
    return SourceMutationService.of({
      execute: <A>(input: {
        readonly intent: SourceMutationIntent;
        readonly reconcile: (
          record: SourceMutationRecord,
        ) => Effect.Effect<SourceReconciliation, unknown>;
        readonly mutate: (
          record: SourceMutationRecord,
        ) => Effect.Effect<
          { readonly value: A; readonly providerId?: string },
          unknown
        >;
      }) =>
        Effect.gen(function* () {
          let record = yield* repository.register(input.intent);
          if (record.state === "succeeded") return undefined as A;
          if (record.state === "failed")
            return yield* new SourceMutationConflict({
              reason: "remote-conflict",
            });
          if (
            record.state === "executing" ||
            record.state === "reconcile-required"
          ) {
            const reconciled = yield* input
              .reconcile(record)
              .pipe(
                Effect.catch(() =>
                  Effect.succeed({ state: "unknown" as const }),
                ),
              );
            if (reconciled.state === "applied") {
              yield* repository.transition(record, "succeeded", {
                ...(reconciled.id === undefined ? {} : { id: reconciled.id }),
                category: "applied",
              });
              return undefined as A;
            }
            if (reconciled.state === "conflict") {
              yield* repository.transition(record, "failed", {
                category: "conflict",
              });
              return yield* new SourceMutationConflict({
                reason: "remote-conflict",
              });
            }
            if (reconciled.state === "unknown") {
              if (record.state === "executing")
                yield* repository.transition(record, "reconcile-required", {
                  category: "unavailable",
                });
              return yield* new SourceMutationConflict({
                reason: "state-conflict",
              });
            }
            if (record.attempt >= 2)
              return yield* new SourceMutationConflict({
                reason: "state-conflict",
              });
            if (record.state === "executing")
              record = yield* repository.transition(
                record,
                "reconcile-required",
                { category: "not-observed" },
              );
          }
          record = yield* repository.transition(record, "executing");
          const outcome = yield* input.mutate(record).pipe(
            Effect.catch((cause) =>
              repository
                .transition(
                  record,
                  cause instanceof SourceMutationRejected
                    ? "failed"
                    : "reconcile-required",
                  {
                    category:
                      cause instanceof SourceMutationRejected
                        ? "rejected"
                        : "unavailable",
                  },
                )
                .pipe(Effect.flatMap(() => Effect.fail(cause))),
            ),
          );
          yield* repository.transition(record, "succeeded", {
            ...(outcome.providerId === undefined
              ? {}
              : { id: outcome.providerId }),
            category: "applied",
          });
          return outcome.value;
        }),
    });
  }),
);
