import {
  type OrbProviderCredentials,
  RunnerProfileId,
  ThreadId,
  UserId,
  withPinnedOrbTarget,
} from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import {
  decryptOrbCredentials,
  type StoredOrbCredentials,
  storedCredentialsFromRow,
} from "../../plugins/execution/connections-d1.js";
import { isLocalRuntime } from "../../plugins/registry.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import { activeMemberSql } from "../../settings/members/membership-sql.js";
import {
  ownerPolicyFrom,
  ownerPolicyStatements,
} from "../../settings/workspace-policy/repository-d1.js";
import { workspacePolicyDenial } from "../../settings/workspace-policy/service.js";
import { loadRunnerProfileCatalog, selectRunnerProfile } from "./catalog.js";

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);

const ExecutionRunnerRow = Schema.Struct({
  thread_runner_profile_id: Schema.NullOr(RunnerProfileId),
  project_runner_profile_id: RunnerProfileId,
  owner_user_id: UserId,
  project_workspace_id: NullableString,
  pin_provider: NullableString,
  pin_runner_profile_id: Schema.NullOr(RunnerProfileId),
  account_scope: Schema.NullOr(
    Schema.Literals(["deployment", "workspace", "personal"]),
  ),
  account_owner_id: NullableString,
  provider_account: NullableString,
  provider_template: NullableString,
  connection_provider_id: NullableString,
  key_version: NullableNumber,
  value_nonce: NullableString,
  ciphertext: NullableString,
  wrapped_key_nonce: NullableString,
  wrapped_key: NullableString,
  connection_account: NullableString,
  allow_personal_plugin_overrides: NullableNumber,
  allow_personal_execution_overrides: NullableNumber,
  owner_is_member: NullableNumber,
});

export type ExecutionRunnerRow = typeof ExecutionRunnerRow.Type;

export class ExecutionRunnerProfileUnavailable extends Schema.TaggedError<ExecutionRunnerProfileUnavailable>()(
  "ExecutionRunnerProfileUnavailable",
  {},
) {}

/** Why a Thread's pinned credential no longer resolves. */
export type ExecutionCredentialUnavailableReason =
  | "removed"
  | "policy-denied"
  | "account-changed"
  | "not-a-member"
  | "local-runtime";

/**
 * The credential a Thread's workspace runs on, re-resolved for its owner on
 * every provider operation. `deployment` uses the deployment's own key
 * (bindings). A person's or workspace's connection is used only while it
 * still resolves to the pinned account; otherwise the operation fails
 * closed.
 */
export type ExecutionTargetCredential =
  | { readonly scope: "deployment" }
  | {
      readonly scope: "personal" | "workspace";
      readonly ownerId: string;
      readonly account: string;
      readonly credentials: Redacted.Redacted<OrbProviderCredentials>;
    }
  | {
      readonly scope: "unavailable";
      readonly reason: ExecutionCredentialUnavailableReason;
    };

type PinnedCredential =
  | { readonly scope: "deployment" }
  | {
      readonly scope: "personal" | "workspace";
      readonly ownerId: string;
      readonly account: string;
      readonly stored: StoredOrbCredentials;
    }
  | {
      readonly scope: "unavailable";
      readonly reason: ExecutionCredentialUnavailableReason;
    };

/**
 * The pin rules, from the one D1 row an activation reads (pure, so the
 * rules are tested without D1):
 *
 * - No pin (Threads from before 4b, local runtime) or a deployment pin uses
 *   the deployment's key.
 * - Local runtime never uses a person's or workspace's connection.
 * - The pinned scope's connection must still exist for the pinned
 *   provider: removed means unavailable.
 * - A personal key on a workspace project needs the workspace's explicit
 *   opt-in (`allowPersonalPluginOverrides` and
 *   `allowPersonalExecutionOverrides`); the general flag alone, whose
 *   default is true, is not an opt-in. Personal projects always honor it.
 * - A workspace key needs the Thread owner to still be a member.
 * - The connection must name the pinned account (the E2B team or
 *   Cloudflare account the Thread's workspace lives in); credentials
 *   rotated within that account are used.
 */
export const pinnedCredential = (
  row: ExecutionRunnerRow,
  options: { readonly localRuntime: boolean },
): PinnedCredential => {
  const scope = row.account_scope;
  if (scope === null || scope === "deployment") return { scope: "deployment" };
  if (options.localRuntime)
    return { scope: "unavailable", reason: "local-runtime" };
  const ownerId = row.account_owner_id;
  const account = row.provider_account;
  if (
    ownerId === null ||
    account === null ||
    row.connection_provider_id === null ||
    row.connection_provider_id !== row.pin_provider ||
    row.key_version === null ||
    row.value_nonce === null ||
    row.ciphertext === null ||
    row.wrapped_key_nonce === null ||
    row.wrapped_key === null
  )
    return { scope: "unavailable", reason: "removed" };
  if (
    scope === "personal" &&
    row.project_workspace_id !== null &&
    !(
      row.allow_personal_plugin_overrides === 1 &&
      row.allow_personal_execution_overrides === 1
    )
  )
    return { scope: "unavailable", reason: "policy-denied" };
  if (scope === "workspace" && row.owner_is_member !== 1)
    return { scope: "unavailable", reason: "not-a-member" };
  if (row.connection_account !== account)
    return { scope: "unavailable", reason: "account-changed" };
  return {
    scope,
    ownerId,
    account,
    stored: storedCredentialsFromRow({
      scope,
      target_id: ownerId,
      provider_id: row.connection_provider_id,
      key_version: row.key_version,
      value_nonce: row.value_nonce,
      ciphertext: row.ciphertext,
      wrapped_key_nonce: row.wrapped_key_nonce,
      wrapped_key: row.wrapped_key,
    }),
  };
};

/**
 * One D1 read per activation: the Thread's runner profile inputs, its pin
 * on `execution_workspace`, the pinned scope's connection, the project's
 * workspace policy, and the owner's membership.
 */
const targetQuery = `SELECT threads.runner_profile_id AS thread_runner_profile_id,
        projects.runner_profile_id AS project_runner_profile_id,
        threads.owner_user_id,
        projects.workspace_id AS project_workspace_id,
        pin.provider AS pin_provider,
        pin.runner_profile_id AS pin_runner_profile_id,
        pin.account_scope,
        pin.account_owner_id,
        pin.provider_account,
        pin.provider_template,
        connection.provider_id AS connection_provider_id,
        connection.key_version,
        connection.value_nonce,
        connection.ciphertext,
        connection.wrapped_key_nonce,
        connection.wrapped_key,
        connection.account AS connection_account,
        policy.allow_personal_plugin_overrides,
        policy.allow_personal_execution_overrides,
        CASE WHEN pin.account_scope = 'workspace' THEN ${activeMemberSql(
          "pin.account_owner_id",
          "threads.owner_user_id",
        )} ELSE NULL END AS owner_is_member
   FROM threads
   -- A Thread's Project is fixed; access is checked before activation, and
   -- releasing must still resolve after the owner leaves the workspace.
   INNER JOIN projects ON projects.id = threads.project_id
   LEFT JOIN execution_workspace AS pin ON pin.thread_id = threads.id
   LEFT JOIN orb_connection AS connection
     ON connection.scope = pin.account_scope
    AND connection.target_id = pin.account_owner_id
    AND connection.provider_id = pin.provider
   LEFT JOIN workspace_policy AS policy
     ON policy.workspace_id = projects.workspace_id
  WHERE threads.id = ?
  LIMIT 1`;

/**
 * The runner profile and credential a Thread's workspace uses. A pinned
 * Thread uses its pinned size; earlier Threads use the Thread's or the
 * project's profile, as before. `admission: false` is for releasing an
 * existing workspace: it neither requires the profile to be available nor
 * evaluates workspace policy, so archive is never blocked by a profile in
 * maintenance or a policy change.
 */
export const resolveExecutionTarget = Effect.fn("resolveExecutionTarget")(
  function* (
    bindings: Bindings,
    rawThreadId: string,
    options: {
      readonly admission: boolean;
      /**
       * Return the workspace policy check instead of running it, for a caller
       * that runs it beside its own reads and before the Orb starts.
       */
      readonly deferPolicy?: boolean;
    } = { admission: true },
  ) {
    const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(
      rawThreadId,
    ).pipe(Effect.mapError(() => new ExecutionRunnerProfileUnavailable()));
    const db = yield* decodeD1Binding(bindings.DB).pipe(
      Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
    );
    const catalog = yield* loadRunnerProfileCatalog(bindings).pipe(
      Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
    );
    // Admission also reads the owner's membership and its workspace policy
    // in the same batch, so the policy check costs no round trip of its own
    // (#1589). Releasing reads the target alone.
    const [target, ...ownerPolicy] = yield* Effect.tryPromise({
      try: () =>
        options.admission
          ? db.batch([
              db.prepare(targetQuery).bind(threadId),
              ...ownerPolicyStatements(
                db,
                "(SELECT owner_user_id FROM threads WHERE id = ?1)",
                [threadId],
              ),
            ])
          : db
              .prepare(targetQuery)
              .bind(threadId)
              .all()
              .then((result) => [result]),
      catch: () => new ExecutionRunnerProfileUnavailable(),
    });
    const row = yield* Effect.succeed(target?.results[0] ?? null).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(new ExecutionRunnerProfileUnavailable())
          : Schema.decodeUnknownEffect(ExecutionRunnerRow)(value).pipe(
              Effect.mapError(() => new ExecutionRunnerProfileUnavailable()),
            ),
      ),
    );
    const pinned = row.account_scope !== null;
    const selected = yield* selectRunnerProfile(
      catalog,
      (pinned ? row.pin_runner_profile_id : null) ??
        row.thread_runner_profile_id ??
        row.project_runner_profile_id,
      options.admission,
    ).pipe(Effect.mapError(() => new ExecutionRunnerProfileUnavailable()));
    // A pin always names the provider of its profile; anything else is not
    // this Thread's workspace.
    if (pinned && row.pin_provider !== selected.adapter)
      return yield* new ExecutionRunnerProfileUnavailable();
    const resolved = pinnedCredential(row, {
      localRuntime: isLocalRuntime(bindings),
    });
    const credential: ExecutionTargetCredential =
      resolved.scope === "deployment" || resolved.scope === "unavailable"
        ? resolved
        : yield* Effect.gen(function* () {
            const keyring = yield* loadConfigEncryptionKeyring(bindings);
            const credentials = yield* Effect.tryPromise(() =>
              decryptOrbCredentials(keyring, resolved.stored),
            );
            return {
              scope: resolved.scope,
              ownerId: resolved.ownerId,
              account: resolved.account,
              credentials: Redacted.make(credentials),
            } as const;
          }).pipe(
            // A key that no longer decrypts is as good as removed.
            Effect.orElseSucceed(
              () =>
                ({
                  scope: "unavailable",
                  reason: "removed",
                }) as const,
            ),
          );
    // A connection, or the deployment's account of a provider prepared at
    // runtime, runs the Thread on the target its preparation made for the
    // size, which the pin recorded.
    const profile =
      row.provider_template !== null
        ? withPinnedOrbTarget(selected, row.provider_template)
        : selected;
    if (!options.admission) return { profile, credential };
    const [membership, policyRow] = ownerPolicy;
    // As `WorkspacePolicyService.evaluateForUser`: no workspace admits, two
    // memberships or a member's workspace without a policy row refuse.
    const policy = Effect.gen(function* () {
      if (membership === undefined || policyRow === undefined)
        return yield* new ExecutionRunnerProfileUnavailable();
      const ownerPolicy = yield* ownerPolicyFrom(membership, policyRow);
      if (ownerPolicy === undefined) return;
      const denial = workspacePolicyDenial(ownerPolicy, {
        kind: "execution.admit",
        runnerProfileId: profile.id,
        runnerAdapter: profile.adapter,
      });
      if (denial !== undefined) return yield* denial;
    });
    if (options.deferPolicy === true) return { profile, credential, policy };
    yield* policy;
    return { profile, credential };
  },
);

/** The runner profile a Thread's workspace uses (see resolveExecutionTarget). */
export const resolveExecutionRunnerProfile = (
  bindings: Bindings,
  rawThreadId: string,
  options: { readonly admission: boolean } = { admission: true },
) =>
  resolveExecutionTarget(bindings, rawThreadId, options).pipe(
    Effect.map(({ profile }) => profile),
  );
