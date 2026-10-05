import type { PluginScope, ThreadExecutionPin } from "@dx/domain";
import { Effect, Schema } from "effect";
import type { TeamTemplateState } from "../../execution/e2b/team-templates.js";
import { readyProfileTemplates } from "../../execution/e2b/team-templates.js";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import type { Bindings } from "../../http/types.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import {
  type ExecutionProviderId,
  type ResolvedExecutionProvider,
  resolveExecutionProviders,
} from "./provider.js";

/**
 * Bring-your-own keys for key-based Orb providers (E2B). Execution resolves
 * to the set of providers a person can start a Thread on in a project's
 * scope, not to one winner: every deployment provider, plus E2B on a
 * workspace or permitted personal key. For each provider the usual
 * precedence picks the credential (personal over workspace over
 * deployment); the deployment provider stays required. The set is only for
 * the new-Thread picker and Thread creation; a Thread pins its member and
 * never resolves the set again.
 */

export type OrbKeyScope = "personal" | "workspace";

export interface OrbTemplateRecord extends TeamTemplateState {
  readonly configuredAt: string;
  readonly recipe: string;
  readonly revision: number;
  readonly updatedAt: string;
}

/** A person's or workspace's own key for a key-based provider. */
export interface OrbKeyConfiguration {
  readonly scope: OrbKeyScope;
  readonly targetId: string;
  readonly providerId: ExecutionProviderId;
  readonly configuredAt: string;
  /** Null until the first save recorded a build. */
  readonly template: OrbTemplateRecord | null;
}

export type OrbTemplateStatus = "ready" | "building" | "failed";

/**
 * The template a key's Threads can create from, for the current recipe and
 * the current key. A record from another recipe or an earlier key means the
 * templates must be (re)built first.
 */
export const orbTemplateStatus = (
  configuration: OrbKeyConfiguration,
  recipe: string,
): OrbTemplateStatus => {
  const template = configuration.template;
  if (
    template === null ||
    template.configuredAt !== configuration.configuredAt ||
    template.recipe !== recipe
  )
    return "building";
  return template.state;
};

export interface OrbProviderMember {
  readonly providerId: ExecutionProviderId;
  readonly scope: PluginScope;
  /** The person or workspace whose key pays; null for the deployment. */
  readonly ownerId: string | null;
  /** The provider account (E2B team) a key belongs to. */
  readonly account: string | null;
  readonly status: OrbTemplateStatus;
  /** Size → template in the key's account; only for a ready key. */
  readonly templates?: ReadonlyMap<string, string>;
}

export interface OrbProviderSetInput {
  readonly deploymentProviders: ReadonlyArray<ResolvedExecutionProvider>;
  /** Adapters that have at least one runner profile in the catalog. */
  readonly profileAdapters: ReadonlySet<string>;
  readonly personal: ReadonlyArray<OrbKeyConfiguration>;
  readonly workspace: ReadonlyArray<OrbKeyConfiguration>;
  /** The project's workspace; null for a personal project. */
  readonly projectWorkspaceId: string | null;
  /** That workspace's policy flags; null when it has no policy row. */
  readonly policy: {
    readonly allowPersonalPluginOverrides: boolean;
    readonly allowPersonalExecutionOverrides: boolean;
  } | null;
  readonly localRuntime: boolean;
  readonly recipe: string;
}

/**
 * Personal Orb keys are denied on workspace projects unless the workspace
 * explicitly opted in. `allowPersonalPluginOverrides` defaults to true, so
 * on its own it is not an opt-in: Execution also needs
 * `allowPersonalExecutionOverrides`, which defaults to false. Personal
 * projects always honor personal keys.
 */
export const personalOrbKeysAllowed = (
  input: Pick<OrbProviderSetInput, "projectWorkspaceId" | "policy">,
) =>
  input.projectWorkspaceId === null ||
  (input.policy?.allowPersonalPluginOverrides === true &&
    input.policy.allowPersonalExecutionOverrides === true);

const keyMember = (
  configuration: OrbKeyConfiguration,
  recipe: string,
): OrbProviderMember => {
  const status = orbTemplateStatus(configuration, recipe);
  const templates =
    status === "ready" && configuration.template !== null
      ? readyProfileTemplates(configuration.template)
      : undefined;
  return {
    providerId: configuration.providerId,
    scope: configuration.scope,
    ownerId: configuration.targetId,
    account: configuration.template?.account ?? null,
    status,
    ...(templates === undefined ? {} : { templates }),
  };
};

/** The providers a person can start a Thread on, in registry order. */
export const orbProviderSet = (
  input: OrbProviderSetInput,
): ReadonlyArray<OrbProviderMember> => {
  const plugin = findPlugin("execution");
  if (plugin === undefined) return [];
  const personalAllowed = personalOrbKeysAllowed(input);
  return plugin.providers.flatMap((provider): Array<OrbProviderMember> => {
    const providerId = provider.id as ExecutionProviderId;
    if (!input.profileAdapters.has(providerId)) return [];
    const deployment = input.deploymentProviders.some(
      (candidate) => candidate.providerId === providerId,
    );
    // Local runtime ignores personal and workspace keys: `pnpm dev` never
    // reaches a key-based provider.
    if (provider.credentialLabel !== null && !input.localRuntime) {
      const personal = personalAllowed
        ? input.personal.find((key) => key.providerId === providerId)
        : undefined;
      if (personal !== undefined) return [keyMember(personal, input.recipe)];
      const workspace = input.workspace.find(
        (key) => key.providerId === providerId,
      );
      if (workspace !== undefined) return [keyMember(workspace, input.recipe)];
    }
    return deployment
      ? [
          {
            providerId,
            scope: "deployment",
            ownerId: null,
            account: null,
            status: "ready",
          },
        ]
      : [];
  });
};

interface TemplateRow {
  readonly scope: OrbKeyScope;
  readonly target_id: string;
  readonly provider_id: string;
  readonly configured_at: string;
  readonly template_configured_at: string | null;
  readonly recipe: string | null;
  readonly account: string | null;
  readonly state: TeamTemplateState["state"] | null;
  readonly builds_json: string | null;
  readonly error: string | null;
  readonly revision: number | null;
  readonly updated_at: string | null;
}

const configurationFromRow = (row: TemplateRow): OrbKeyConfiguration => ({
  scope: row.scope,
  targetId: row.target_id,
  providerId: row.provider_id as ExecutionProviderId,
  configuredAt: row.configured_at,
  template:
    row.template_configured_at === null ||
    row.recipe === null ||
    row.state === null ||
    row.builds_json === null ||
    row.revision === null ||
    row.updated_at === null
      ? null
      : {
          configuredAt: row.template_configured_at,
          recipe: row.recipe,
          account: row.account,
          state: row.state,
          builds: JSON.parse(row.builds_json),
          error: row.error,
          revision: row.revision,
          updatedAt: row.updated_at,
        },
});

export interface OrbScopeContext {
  /** The person's workspace, if any. */
  readonly memberWorkspaceId: string | null;
  /** The project's workspace (a projectless Thread uses the person's). */
  readonly projectWorkspaceId: string | null;
  /** The project's own runner profile, when a project was named. */
  readonly projectRunnerProfileId: string | null;
  readonly policy: OrbProviderSetInput["policy"];
  readonly personal: ReadonlyArray<OrbKeyConfiguration>;
  readonly workspace: ReadonlyArray<OrbKeyConfiguration>;
}

/**
 * Everything the set needs, in one D1 round trip: membership, the
 * project's workspace and policy, and the person's and workspace's Orb keys
 * with their template builds. `projectId` null means a projectless Thread.
 */
export const loadOrbScope = async (
  db: D1Database,
  userId: string,
  projectId: string | null,
): Promise<OrbScopeContext> => {
  const [scopeResult, keysResult] = await db.batch([
    db
      .prepare(
        `WITH scope AS (
           SELECT
             (SELECT organizationId FROM member WHERE userId = ?1 LIMIT 1)
               AS member_workspace_id,
             (SELECT workspace_id FROM projects
               WHERE id = ?2 AND owner_user_id = ?1) AS named_workspace_id,
             (SELECT runner_profile_id FROM projects
               WHERE id = ?2 AND owner_user_id = ?1) AS project_runner_profile_id
         )
         SELECT scope.member_workspace_id,
                CASE WHEN ?2 IS NULL THEN scope.member_workspace_id
                     ELSE scope.named_workspace_id END AS project_workspace_id,
                scope.project_runner_profile_id,
                policy.allow_personal_plugin_overrides,
                policy.allow_personal_execution_overrides
           FROM scope
           LEFT JOIN workspace_policy AS policy
             ON policy.workspace_id = CASE WHEN ?2 IS NULL
               THEN scope.member_workspace_id ELSE scope.named_workspace_id END`,
      )
      .bind(userId, projectId),
    db
      .prepare(
        `SELECT setting.scope, setting.target_id, setting.provider_id,
                setting.configured_at,
                template.configured_at AS template_configured_at,
                template.recipe, template.account, template.state,
                template.builds_json, template.error, template.revision,
                template.updated_at
           FROM plugin_setting AS setting
           LEFT JOIN execution_account_template AS template
             ON template.scope = setting.scope
            AND template.target_id = setting.target_id
            AND template.provider_id = setting.provider_id
          WHERE setting.plugin_id = 'execution'
            AND setting.provider_id IS NOT NULL
            AND setting.configured_at IS NOT NULL
            AND ((setting.scope = 'personal' AND setting.target_id = ?1)
              OR (setting.scope = 'workspace' AND setting.target_id =
                (SELECT organizationId FROM member WHERE userId = ?1 LIMIT 1)))`,
      )
      .bind(userId),
  ]);
  const scope = (scopeResult?.results[0] ?? {}) as {
    readonly member_workspace_id?: string | null;
    readonly project_workspace_id?: string | null;
    readonly project_runner_profile_id?: string | null;
    readonly allow_personal_plugin_overrides?: number | null;
    readonly allow_personal_execution_overrides?: number | null;
  };
  const keys = ((keysResult?.results ?? []) as Array<TemplateRow>).map(
    configurationFromRow,
  );
  return {
    memberWorkspaceId: scope.member_workspace_id ?? null,
    projectWorkspaceId: scope.project_workspace_id ?? null,
    projectRunnerProfileId: scope.project_runner_profile_id ?? null,
    policy:
      scope.allow_personal_plugin_overrides == null
        ? null
        : {
            allowPersonalPluginOverrides:
              scope.allow_personal_plugin_overrides === 1,
            allowPersonalExecutionOverrides:
              scope.allow_personal_execution_overrides === 1,
          },
    personal: keys.filter(({ scope }) => scope === "personal"),
    workspace: keys.filter(({ scope }) => scope === "workspace"),
  };
};

/** Writes a key's template record; `expectedRevision` guards a race. */
export const putOrbTemplate = (
  db: D1Database,
  key: Pick<OrbKeyConfiguration, "scope" | "targetId" | "providerId">,
  record: Omit<OrbTemplateRecord, "revision" | "updatedAt">,
  now: string,
  expectedRevision?: number,
) =>
  expectedRevision === undefined
    ? db
        .prepare(
          `INSERT INTO execution_account_template (
             scope, target_id, provider_id, configured_at, recipe, account,
             state, builds_json, error, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT (scope, target_id, provider_id) DO UPDATE SET
             configured_at = excluded.configured_at,
             recipe = excluded.recipe,
             account = excluded.account,
             state = excluded.state,
             builds_json = excluded.builds_json,
             error = excluded.error,
             revision = execution_account_template.revision + 1,
             updated_at = excluded.updated_at`,
        )
        .bind(
          key.scope,
          key.targetId,
          key.providerId,
          record.configuredAt,
          record.recipe,
          record.account,
          record.state,
          JSON.stringify(record.builds),
          record.error,
          now,
        )
    : db
        .prepare(
          `UPDATE execution_account_template SET
             configured_at = ?, recipe = ?, account = ?, state = ?,
             builds_json = ?, error = ?, revision = revision + 1,
             updated_at = ?
           WHERE scope = ? AND target_id = ? AND provider_id = ?
             AND revision = ?`,
        )
        .bind(
          record.configuredAt,
          record.recipe,
          record.account,
          record.state,
          JSON.stringify(record.builds),
          record.error,
          now,
          key.scope,
          key.targetId,
          key.providerId,
          expectedRevision,
        );

/** Claims a key's template record for one advance; false when raced. */
export const claimOrbTemplate = async (
  db: D1Database,
  key: Pick<OrbKeyConfiguration, "scope" | "targetId" | "providerId">,
  template: Pick<OrbTemplateRecord, "revision">,
  now: string,
  notAfter: string,
) =>
  (
    await db
      .prepare(
        `UPDATE execution_account_template
            SET revision = revision + 1, updated_at = ?
          WHERE scope = ? AND target_id = ? AND provider_id = ?
            AND revision = ? AND updated_at <= ?`,
      )
      .bind(
        now,
        key.scope,
        key.targetId,
        key.providerId,
        template.revision,
        notAfter,
      )
      .run()
  ).meta.changes === 1;

export const deleteOrbTemplate = (
  db: D1Database,
  key: Pick<OrbKeyConfiguration, "scope" | "targetId" | "providerId">,
) =>
  db
    .prepare(
      `DELETE FROM execution_account_template
        WHERE scope = ? AND target_id = ? AND provider_id = ?`,
    )
    .bind(key.scope, key.targetId, key.providerId);

/**
 * A new Thread's Orb runs on a person's or workspace's key whose template
 * is not ready in its account yet (or failed). Never retried on the
 * deployment's key.
 */
export class OrbUnavailable extends Schema.TaggedError<OrbUnavailable>()(
  "OrbUnavailable",
  { reason: Schema.Literals(["template-building", "template-failed"]) },
) {}

/**
 * The pin a new Thread records: resolves the provider set once, at
 * creation, for the Thread's size (the requested profile, else the
 * project's) and takes that provider's member. Undefined for the local
 * runtime's provider, a size the catalog does not know, a provider that
 * does not resolve, or no catalog, which keep the pre-4b behavior
 * (deployment; activation fails closed if nothing serves the size).
 */
export const resolveThreadExecutionPin = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly userId: string;
  readonly projectId: string | null;
  readonly runnerProfileId: string | undefined;
  /** A projectless Thread's project defaults to this size. */
  readonly projectlessRunnerProfileId?: string;
  readonly recipe: string;
}): Promise<ThreadExecutionPin | undefined> => {
  // Without a catalog no size resolves, and activation fails closed as
  // before; creation itself does not depend on it.
  const catalog = await Effect.runPromise(
    loadRunnerProfileCatalog(input.bindings).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (catalog === undefined) return undefined;
  const scope = await loadOrbScope(input.db, input.userId, input.projectId);
  const profileId =
    input.runnerProfileId ??
    (input.projectId === null
      ? input.projectlessRunnerProfileId
      : scope.projectRunnerProfileId);
  const profile = catalog.configuration.profiles.find(
    ({ id }) => id === profileId,
  );
  if (
    profile === undefined ||
    (profile.adapter !== "e2b" && profile.adapter !== "cloudflare")
  )
    return undefined;
  const member = orbProviderSet({
    deploymentProviders: resolveExecutionProviders(input.bindings),
    profileAdapters: new Set(
      catalog.configuration.profiles.map(({ adapter }) => adapter as string),
    ),
    personal: scope.personal,
    workspace: scope.workspace,
    projectWorkspaceId: scope.projectWorkspaceId,
    policy: scope.policy,
    localRuntime: isLocalRuntime(input.bindings),
    recipe: input.recipe,
  }).find(({ providerId }) => providerId === profile.adapter);
  // A size whose provider does not resolve keeps the pre-4b behavior: the
  // Thread is created and its first activation fails closed.
  if (member === undefined) return undefined;
  if (member.status !== "ready")
    throw new OrbUnavailable({
      reason:
        member.status === "failed" ? "template-failed" : "template-building",
    });
  if (member.scope === "deployment")
    return {
      provider: profile.adapter,
      runnerProfileId: profile.id,
      credentialScope: "deployment",
      credentialOwnerId: null,
      credentialAccount: null,
      providerTemplate: null,
    };
  const template = member.templates?.get(profile.id);
  if (
    template === undefined ||
    member.ownerId === null ||
    member.account === null
  )
    throw new OrbUnavailable({ reason: "template-building" });
  return {
    provider: profile.adapter,
    runnerProfileId: profile.id,
    credentialScope: member.scope,
    credentialOwnerId: member.ownerId,
    credentialAccount: member.account,
    providerTemplate: template,
  };
};
