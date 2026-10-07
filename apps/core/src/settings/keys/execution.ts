import {
  CommitSigningPreference,
  GitAuthorEmail,
  GitAuthorName,
  type RunnerAdapterKind,
  RunnerProfileId,
  type SigningKeyFingerprint,
  SigningKeyRepository,
  type SigningPrivateKeyPlaintext,
  type SigningPublicKey,
  ThreadId,
  UserId,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  loadRunnerProfileCatalog,
  selectRunnerProfile,
} from "../../execution/runner-profiles/catalog.js";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { threadProjectReachableSql } from "../members/membership-sql.js";
import { requireManagedSigning } from "./backend.js";
import { decryptSigningPrivateKey } from "./encryption.js";
import { SigningKeyRepositoryD1 } from "./repository-d1.js";

const ExecutionSigningRow = Schema.Struct({
  owner_user_id: UserId,
  commit_author_name: GitAuthorName,
  commit_author_email: GitAuthorEmail,
  signing_preference: CommitSigningPreference,
  runner_profile_id: Schema.String,
});

export class ExecutionSigningUnavailable extends Schema.TaggedError<ExecutionSigningUnavailable>()(
  "ExecutionSigningUnavailable",
  {},
) {}

export interface SigningExecutionPlan {
  readonly policy: typeof CommitSigningPreference.Type;
  readonly author: {
    readonly name: typeof GitAuthorName.Type;
    readonly email: typeof GitAuthorEmail.Type;
  };
  readonly runnerProfileId: typeof RunnerProfileId.Type;
  readonly runnerProfileVersion: number;
  readonly runnerAdapter: RunnerAdapterKind;
  readonly credential?: {
    readonly backend: "managed-ssh-ed25519";
    readonly privateKey: SigningPrivateKeyPlaintext;
    readonly publicKey: SigningPublicKey;
    readonly fingerprint: SigningKeyFingerprint;
  };
}

export const resolveExecutionSigningPlan = Effect.fn(
  "resolveExecutionSigningPlan",
)(function* (bindings: Bindings, rawThreadId: string) {
  const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
    rawThreadId,
  ).pipe(Effect.mapError(() => new ExecutionSigningUnavailable()));
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(() => new ExecutionSigningUnavailable()),
  );
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT threads.owner_user_id,
             -- A member's Thread in another member's workspace Project uses
             -- the member's own account identity, as project defaults do,
             -- when the Project asks for the user.
             CASE WHEN projects.commit_author_preference = 'user'
                    AND projects.owner_user_id != threads.owner_user_id
                  THEN COALESCE(account.display_name, owner.name)
                  ELSE projects.commit_author_name END
               AS commit_author_name,
             CASE WHEN projects.commit_author_preference = 'user'
                    AND projects.owner_user_id != threads.owner_user_id
                  THEN owner.email ELSE projects.commit_author_email END
               AS commit_author_email,
             projects.signing_preference,
             COALESCE(threads.runner_profile_id, projects.runner_profile_id)
               AS runner_profile_id
           FROM threads
           INNER JOIN "user" AS owner ON owner.id = threads.owner_user_id
           LEFT JOIN personal_account AS account
             ON account.user_id = threads.owner_user_id
           INNER JOIN projects ON projects.id = threads.project_id
             AND ${threadProjectReachableSql("projects", "threads.owner_user_id")}
           WHERE threads.id = ?
           LIMIT 1`,
        )
        .bind(threadId)
        .first(),
    catch: () => new ExecutionSigningUnavailable(),
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new ExecutionSigningUnavailable())
        : Schema.decodeUnknownEffect(ExecutionSigningRow)(value).pipe(
            Effect.mapError(() => new ExecutionSigningUnavailable()),
          ),
    ),
  );
  const catalog = yield* loadRunnerProfileCatalog(bindings).pipe(
    Effect.mapError(() => new ExecutionSigningUnavailable()),
  );
  const runnerProfileId = yield* Schema.decodeUnknownEffect(RunnerProfileId)(
    row.runner_profile_id,
  ).pipe(Effect.mapError(() => new ExecutionSigningUnavailable()));
  const runnerProfile = yield* selectRunnerProfile(
    catalog,
    runnerProfileId,
  ).pipe(Effect.mapError(() => new ExecutionSigningUnavailable()));
  const base = {
    policy: row.signing_preference,
    author: {
      name: row.commit_author_name,
      email: row.commit_author_email,
    },
    runnerProfileId: runnerProfile.id,
    runnerProfileVersion: catalog.configuration.version,
    runnerAdapter: runnerProfile.adapter,
  } satisfies SigningExecutionPlan;
  if (row.signing_preference === "disabled") return base;

  const keyring = yield* Effect.option(requireManagedSigning(bindings));
  if (Option.isNone(keyring)) return base;
  const stored = yield* Effect.gen(function* () {
    const repository = yield* SigningKeyRepository;
    return yield* repository.findActiveManaged(row.owner_user_id);
  }).pipe(
    Effect.provide(SigningKeyRepositoryD1(db)),
    Effect.mapError(() => new ExecutionSigningUnavailable()),
  );
  if (stored === undefined) return base;
  const privateKey = yield* Effect.option(
    decryptSigningPrivateKey(
      keyring.value,
      {
        id: stored.id,
        userId: stored.userId,
        publicKey: stored.publicKey,
        fingerprint: stored.fingerprint,
      },
      stored.privateKeyEnvelope,
    ),
  );
  if (Option.isNone(privateKey)) return base;
  return {
    ...base,
    credential: {
      backend: "managed-ssh-ed25519",
      privateKey: privateKey.value,
      publicKey: stored.publicKey,
      fingerprint: stored.fingerprint,
    },
  } satisfies SigningExecutionPlan;
});
