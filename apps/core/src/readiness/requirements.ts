import { Config, ConfigProvider, Effect, Predicate, Schema } from "effect";
import migrationManifest from "../../migration-manifest.json" with {
  type: "json",
};
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import { loadE2BRequirements } from "../execution/e2b/requirements.js";
import { validateLocalRuntimeConfiguration } from "../execution/local/adapter.js";
import { loadRunnerProfileCatalog } from "../execution/runner-profiles/catalog.js";
import type { Bindings } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { loadRuntimeConfiguration } from "../runtime/composition.js";
import { loadConfigEncryptionKeyring } from "../settings/environment-variables/encryption.js";
import { loadBitbucketConfiguration } from "../source-control/bitbucket/configuration.js";
import { loadGitHubAppConfiguration } from "../source-control/github/configuration.js";
import { workloadIdentityBroker } from "../workload-identity/broker.js";

const sourceControlSchemaObjects = [
  ["table", "github_user_authorization"],
  ["table", "github_installation"],
  ["table", "github_owner_grant"],
  ["table", "github_installation_repository"],
  ["table", "github_owner_repository_selection"],
  ["table", "github_setup_transaction"],
  ["table", "github_webhook_delivery"],
  ["table", "github_authorization_epoch"],
  ["table", "github_oauth_transaction"],
  ["table", "bitbucket_connection"],
  ["table", "bitbucket_oauth_state"],
  ["table", "bitbucket_repository"],
  ["table", "bitbucket_git_lease"],
  ["table", "project_repository"],
  ["table", "project_source_authority"],
  ["table", "source_admission_assertion"],
  ["table", "thread_source_snapshot"],
  ["table", "thread_source_authority"],
  ["table", "thread_source_intent"],
  ["table", "thread_source_finalization_assertion"],
  ["table", "thread_source_intent_assertion"],
  ["table", "source_control_operation_audit"],
  ["table", "source_control_audit_retention_gate"],
  ["table", "source_control_operation"],
  ["view", "project_read_model"],
  ["index", "github_user_authorization_user_idx"],
  ["index", "github_installation_account_idx"],
  ["index", "github_owner_grant_owner_idx"],
  ["index", "github_installation_repository_entitled_idx"],
  ["index", "github_setup_transaction_expiry_idx"],
  ["index", "github_oauth_transaction_expiry_idx"],
  ["index", "github_webhook_delivery_state_idx"],
  ["index", "bitbucket_connection_user_live_idx"],
  ["index", "bitbucket_git_lease_expiry_idx"],
  ["index", "project_source_authority_grant_idx"],
  ["index", "project_source_authority_owner_idx"],
  ["index", "thread_source_snapshot_project_idx"],
  ["index", "thread_source_authority_grant_idx"],
  ["index", "thread_source_intent_project_idx"],
  ["index", "source_control_audit_thread_time_idx"],
  ["index", "source_control_audit_actor_time_idx"],
  ["index", "source_control_audit_outcome_time_idx"],
  ["index", "threads_source_operation_tenant_idx"],
  ["index", "source_control_operation_thread_time_idx"],
  ["index", "source_control_operation_reconcile_idx"],
  ["trigger", "thread_source_snapshot_immutable_update"],
  ["trigger", "thread_source_snapshot_immutable_delete"],
  ["trigger", "thread_source_authority_immutable_update"],
  ["trigger", "thread_source_authority_immutable_delete"],
  ["trigger", "thread_source_intent_immutable_update"],
  ["trigger", "thread_source_intent_finalized_delete"],
  ["trigger", "source_control_operation_audit_validate_capabilities"],
  ["trigger", "source_control_operation_audit_immutable_update"],
  ["trigger", "source_control_operation_audit_immutable_delete"],
  ["trigger", "source_control_operation_intent_immutable"],
  ["trigger", "source_control_operation_transition"],
  ["trigger", "source_control_operation_terminal_immutable"],
  ["trigger", "source_control_operation_no_delete"],
] as const;

const workloadIdentitySchemaObjects = [
  ["table", "workload_identity_issuance_audit"],
  ["table", "workload_identity_audit_retention_gate"],
  ["index", "workload_identity_audit_thread_time_idx"],
  ["index", "workload_identity_audit_actor_time_idx"],
  ["index", "workload_identity_audit_outcome_time_idx"],
  ["trigger", "workload_identity_issuance_audit_immutable_update"],
  ["trigger", "workload_identity_issuance_audit_immutable_delete"],
] as const;

export const SOURCE_CONTROL_SCHEMA_VERSION = /^(\d{4})_/.exec(
  migrationManifest.d1.at(-1)?.filename ?? "",
)?.[1];
if (SOURCE_CONTROL_SCHEMA_VERSION === undefined)
  throw new Error("Migration manifest has no source-control schema version.");

export const sourceControlSchemaRows = [
  ...sourceControlSchemaObjects,
  ...workloadIdentitySchemaObjects,
].map(([type, name]) => ({ type, name }));

export class ReadinessError extends Schema.TaggedError<ReadinessError>()(
  "ReadinessError",
  {
    category: Schema.Literals([
      "configuration",
      "authentication_configuration",
      "config_encryption_configuration",
      "workload_identity_configuration",
      "github_app_binding_missing",
      "github_app_configuration_malformed",
      "github_app_origin_drift",
      "github_app_permission_drift",
      "github_app_event_drift",
      "github_app_expiring_token_drift",
      "bitbucket_oauth_configuration_malformed",
      "execution_workspace_configuration",
      "local_workspace_configuration",
      "runner_profile_configuration",
      "runner_template_configuration",
      "deployment_identity_configuration",
      "dxd_release_configuration",
      "migration_configuration",
      "source_control_schema_configuration",
      "workload_identity_schema_configuration",
      "agent_binding",
      "durable_object_binding",
      "ai_binding",
      "d1_binding",
      "r2_binding",
      "thread_execution_binding",
    ]),
  },
) {}

export type ReadinessRequirements =
  | { readonly dxEnv: string }
  | {
      readonly dxEnv: string;
      readonly runtimeMode: string;
      readonly revision: string;
      readonly e2bTemplateBuildId: string;
      readonly migrationManifestVersion: string;
      readonly dxdPublicUrl: string;
      readonly dxdReleaseUrl: string;
      readonly dxdReleaseSha256: string;
    };

const deploymentReadinessRequirements = Config.all({
  dxEnv: Config.nonEmptyString("DX_ENV"),
  runtimeMode: Config.nonEmptyString("DX_RUNTIME_MODE"),
  revision: Config.nonEmptyString("DX_DEPLOYMENT_REVISION"),
  e2bTemplateBuildId: Config.nonEmptyString("DX_E2B_TEMPLATE_BUILD_ID"),
  migrationManifestVersion: Config.nonEmptyString(
    "DX_MIGRATION_MANIFEST_VERSION",
  ),
  dxdPublicUrl: Config.nonEmptyString("DX_DXD_PUBLIC_URL"),
  dxdReleaseUrl: Config.nonEmptyString("DX_DXD_RELEASE_URL"),
  dxdReleaseSha256: Config.nonEmptyString("DX_DXD_RELEASE_SHA256"),
});

const decodeEnvironment = Effect.fn("decodeReadinessEnvironment")(function* (
  bindings: Bindings,
) {
  return yield* Config.nonEmptyString("DX_ENV")
    .parse(ConfigProvider.fromUnknown(bindings))
    .pipe(
      Effect.mapError(() => new ReadinessError({ category: "configuration" })),
    );
});

const decodeDeploymentRequirements = Effect.fn(
  "decodeDeploymentReadinessRequirements",
)(function* (bindings: Bindings) {
  return yield* deploymentReadinessRequirements
    .parse(ConfigProvider.fromUnknown(bindings))
    .pipe(
      Effect.mapError(() => new ReadinessError({ category: "configuration" })),
    );
});

type ReadinessNamespace = Pick<DurableObjectNamespace, "get" | "idFromName">;

const isReadinessNamespace = (
  binding: unknown,
): binding is ReadinessNamespace =>
  Predicate.isObject(binding) &&
  Predicate.isFunction(binding.idFromName) &&
  Predicate.isFunction(binding.get);

const validateAgentBinding = Effect.fn("validateAgentBinding")(function* (
  binding: unknown,
) {
  if (!isReadinessNamespace(binding)) {
    return yield* new ReadinessError({ category: "agent_binding" });
  }
  const namespace = binding;
  yield* Effect.try({
    try: () => namespace.get(namespace.idFromName("dx-readiness")),
    catch: () => new ReadinessError({ category: "agent_binding" }),
  });
});

const validateDurableObjectBinding = Effect.fn("validateDurableObjectBinding")(
  function* (binding: unknown) {
    if (!isReadinessNamespace(binding))
      return yield* new ReadinessError({
        category: "durable_object_binding",
      });
    const namespace = binding;
    yield* Effect.try({
      try: () => namespace.get(namespace.idFromName("dx-readiness")),
      catch: () => new ReadinessError({ category: "durable_object_binding" }),
    });
  },
);

const validateAiBinding = Effect.fn("validateAiBinding")(function* (
  binding: unknown,
) {
  if (!Predicate.isObject(binding) || !Predicate.isFunction(binding.run)) {
    return yield* new ReadinessError({ category: "ai_binding" });
  }
});

const validateLocalBindings = Effect.fn("validateLocalBindings")(function* (
  bindings: Bindings,
) {
  if (
    !Predicate.isObject(bindings.DX_STORAGE) ||
    !Predicate.isFunction(bindings.DX_STORAGE.get) ||
    !Predicate.isFunction(bindings.DX_STORAGE.put)
  )
    return yield* new ReadinessError({ category: "r2_binding" });
  if (
    !Predicate.isObject(bindings.THREAD_EXECUTION) ||
    !Predicate.isFunction(bindings.THREAD_EXECUTION.idFromName) ||
    !Predicate.isFunction(bindings.THREAD_EXECUTION.get)
  )
    return yield* new ReadinessError({ category: "thread_execution_binding" });
});

const validateLocalDxdPublicUrl = (value: string | undefined) => {
  if (value === undefined)
    throw new Error("Local dxd callback is unavailable.");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Local dxd callback is unavailable.");
};

const githubConfigurationCategory = (
  bindings: Bindings,
): ReadinessError["category"] | undefined => {
  const encoded = bindings.DX_INTEGRATION_GITHUB_APP;
  if (encoded === undefined || encoded.length === 0)
    return "github_app_binding_missing";
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return "github_app_configuration_malformed";
  }
  if (!Predicate.isObject(value)) return "github_app_configuration_malformed";
  if (
    value.version !== 1 ||
    typeof value.appId !== "string" ||
    typeof value.appSlug !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.clientSecret !== "string" ||
    typeof value.privateKeyPem !== "string" ||
    typeof value.webhookSecret !== "string" ||
    typeof value.callbackUrl !== "string" ||
    typeof value.setupUrl !== "string" ||
    typeof value.webhookUrl !== "string"
  )
    return "github_app_configuration_malformed";
  const repositoryPermissions = value.repositoryPermissions;
  const organizationPermissions = value.organizationPermissions;
  const expectedRepositoryPermissions = {
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
    workflows: "write",
  };
  if (
    !Predicate.isObject(repositoryPermissions) ||
    !Predicate.isObject(organizationPermissions) ||
    Object.keys(repositoryPermissions).length !==
      Object.keys(expectedRepositoryPermissions).length ||
    Object.entries(expectedRepositoryPermissions).some(
      ([name, level]) => repositoryPermissions[name] !== level,
    ) ||
    Object.keys(organizationPermissions).length !== 1 ||
    organizationPermissions.projects !== "write" ||
    value.permissionManifestVersion !== 1
  )
    return "github_app_permission_drift";
  if (JSON.stringify(value.events) !== JSON.stringify(["repository"]))
    return "github_app_event_drift";
  if (value.expiringUserTokens !== true)
    return "github_app_expiring_token_drift";
  try {
    const origin = bindings.DX_AUTH_URL;
    if (
      origin === undefined ||
      value.callbackUrl !==
        new URL("/v1/integrations/github/oauth/callback", origin).toString() ||
      value.setupUrl !==
        new URL("/v1/integrations/github/setup", origin).toString() ||
      value.webhookUrl !==
        new URL("/v1/integrations/github/webhooks", origin).toString()
    )
      return "github_app_origin_drift";
  } catch {
    return "github_app_origin_drift";
  }
  return undefined;
};

/** Checks local configuration and bound D1 schema without external provider calls. */
export const loadReadinessRequirements = Effect.fn("loadReadinessRequirements")(
  function* (bindings: Bindings) {
    const dxEnv = yield* decodeEnvironment(bindings);
    const runtime = yield* loadRuntimeConfiguration(bindings).pipe(
      Effect.mapError(() => new ReadinessError({ category: "configuration" })),
    );
    const authentication = yield* loadAuthenticationRequirements(bindings).pipe(
      Effect.mapError(
        () => new ReadinessError({ category: "authentication_configuration" }),
      ),
    );
    if (
      runtime.mode === "deployed" &&
      (dxEnv !== "selfhost" || bindings.DX_AUTH_EMAIL_FROM !== undefined) &&
      (bindings.DX_AUTH_EMAIL_FROM?.trim() === "" ||
        bindings.DX_AUTH_EMAIL_FROM === undefined ||
        !Predicate.isObject(bindings.EMAIL) ||
        !Predicate.isFunction(bindings.EMAIL.send))
    )
      return yield* new ReadinessError({
        category: "authentication_configuration",
      });
    let config: ReadinessRequirements;
    if (runtime.mode === "local") {
      if (dxEnv !== "local")
        return yield* new ReadinessError({ category: "configuration" });
      config = { dxEnv };
    } else {
      const deploymentConfig = yield* decodeDeploymentRequirements(bindings);
      if (
        !new Set(["preview", "staging", "test", "selfhost"]).has(
          deploymentConfig.dxEnv,
        ) ||
        deploymentConfig.runtimeMode !== "deployed" ||
        !/^[a-f0-9]{40}$/.test(deploymentConfig.revision) ||
        deploymentConfig.e2bTemplateBuildId.length > 256
      )
        return yield* new ReadinessError({
          category: "deployment_identity_configuration",
        });
      try {
        const authOrigin = new URL(authentication.authUrl).origin;
        const publicUrl = new URL(deploymentConfig.dxdPublicUrl);
        const releaseUrl = new URL(deploymentConfig.dxdReleaseUrl);
        if (
          publicUrl.protocol !== "https:" ||
          // Core itself, or the dedicated dxd ingress Worker on workers.dev.
          (publicUrl.origin !== authOrigin &&
            !publicUrl.hostname.endsWith(".workers.dev")) ||
          publicUrl.pathname !== "/" ||
          publicUrl.username !== "" ||
          publicUrl.password !== "" ||
          publicUrl.search !== "" ||
          publicUrl.hash !== "" ||
          releaseUrl.protocol !== "https:" ||
          releaseUrl.username !== "" ||
          releaseUrl.password !== "" ||
          releaseUrl.hash !== "" ||
          !/^[a-f0-9]{64}$/.test(deploymentConfig.dxdReleaseSha256)
        )
          throw new Error("invalid dxd metadata");
      } catch {
        return yield* new ReadinessError({
          category: "dxd_release_configuration",
        });
      }
      if (
        deploymentConfig.migrationManifestVersion !==
        String(migrationManifest.version)
      )
        return yield* new ReadinessError({
          category: "migration_configuration",
        });
      config = deploymentConfig;
    }
    const runnerCatalog = yield* loadRunnerProfileCatalog(bindings).pipe(
      Effect.mapError(
        () => new ReadinessError({ category: "runner_profile_configuration" }),
      ),
    );
    const defaultRunner = runnerCatalog.configuration.profiles.find(
      ({ id }) => id === runnerCatalog.configuration.defaultProfileId,
    );
    if (runtime.mode === "local") {
      if (defaultRunner?.adapter !== "local")
        return yield* new ReadinessError({
          category: "runner_profile_configuration",
        });
      yield* Effect.try({
        try: () => {
          validateLocalRuntimeConfiguration(bindings);
          validateLocalDxdPublicUrl(bindings.DX_DXD_PUBLIC_URL);
        },
        catch: () =>
          new ReadinessError({ category: "local_workspace_configuration" }),
      });
    } else {
      const e2bRequirements = yield* loadE2BRequirements(bindings).pipe(
        Effect.mapError(
          () =>
            new ReadinessError({
              category: "execution_workspace_configuration",
            }),
        ),
      );
      if (
        defaultRunner?.adapter !== "e2b" ||
        defaultRunner.template !== e2bRequirements.template
      )
        return yield* new ReadinessError({
          category: "runner_template_configuration",
        });
    }
    yield* loadConfigEncryptionKeyring(bindings).pipe(
      Effect.mapError(
        () =>
          new ReadinessError({ category: "config_encryption_configuration" }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => workloadIdentityBroker.validateConfiguration(bindings),
      catch: () =>
        new ReadinessError({ category: "workload_identity_configuration" }),
    });
    if (
      bindings.DX_INTEGRATION_GITHUB_APP !== undefined &&
      bindings.DX_INTEGRATION_GITHUB_APP !== "{}"
    ) {
      const githubCategory = githubConfigurationCategory(bindings);
      if (githubCategory !== undefined)
        return yield* new ReadinessError({ category: githubCategory });
      yield* loadGitHubAppConfiguration(bindings).pipe(
        Effect.mapError(
          () =>
            new ReadinessError({
              category: "github_app_configuration_malformed",
            }),
        ),
      );
    }
    if (
      bindings.DX_INTEGRATION_BITBUCKET_OAUTH &&
      bindings.DX_INTEGRATION_BITBUCKET_OAUTH !== "{}"
    ) {
      yield* loadBitbucketConfiguration(bindings).pipe(
        Effect.mapError(
          () =>
            new ReadinessError({
              category: "bitbucket_oauth_configuration_malformed",
            }),
        ),
      );
    }
    if (
      bindings.DX_SOURCE_CONTROL_SCHEMA_VERSION !==
      SOURCE_CONTROL_SCHEMA_VERSION
    )
      return yield* new ReadinessError({
        category: "source_control_schema_configuration",
      });
    yield* validateAgentBinding(bindings.FLUE_DX_AGENT_AGENT);
    if (runtime.mode === "deployed") {
      for (const binding of [
        bindings.PLUGIN_TRIGGER_DELIVERY,
        bindings.THREAD_EXECUTION,
        bindings.SUBSCRIPTION_CREDENTIAL_COORDINATOR,
        bindings.REALTIME_HUB,
      ])
        yield* validateDurableObjectBinding(binding);
      yield* validateAiBinding(bindings.AI);
      const storage = bindings.DX_STORAGE;
      if (!Predicate.isObject(storage) || !Predicate.isFunction(storage.head))
        return yield* new ReadinessError({ category: "r2_binding" });
      yield* Effect.tryPromise({
        try: () => storage.head("__dx_readiness__"),
        catch: () => new ReadinessError({ category: "r2_binding" }),
      });
    } else yield* validateLocalBindings(bindings);
    const database = yield* decodeD1Binding(bindings.DB).pipe(
      Effect.mapError(() => new ReadinessError({ category: "d1_binding" })),
    );
    const schemaRows = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(
            `SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view')`,
          )
          .all<{ readonly type: string; readonly name: string }>(),
      catch: () => new ReadinessError({ category: "d1_binding" }),
    });
    const actual = new Set(
      schemaRows.results.map(({ type, name }) => `${type}:${name}`),
    );
    if (
      sourceControlSchemaObjects.some(
        ([type, name]) => !actual.has(`${type}:${name}`),
      )
    )
      return yield* new ReadinessError({
        category: "source_control_schema_configuration",
      });
    if (
      workloadIdentitySchemaObjects.some(
        ([type, name]) => !actual.has(`${type}:${name}`),
      )
    )
      return yield* new ReadinessError({
        category: "workload_identity_schema_configuration",
      });
    if (runtime.mode === "deployed") {
      const migrationRows = yield* Effect.tryPromise({
        try: () =>
          database
            .prepare(
              "SELECT name, hash FROM __alchemy_migrations ORDER BY name",
            )
            .all<{ readonly name: string; readonly hash: string }>(),
        catch: () => new ReadinessError({ category: "d1_binding" }),
      });
      const expectedMigrations = migrationManifest.d1.map(
        ({ filename: name, sha256: hash }) => ({ name, hash }),
      );
      if (
        JSON.stringify(migrationRows.results) !==
        JSON.stringify(expectedMigrations)
      )
        return yield* new ReadinessError({
          category: "migration_configuration",
        });
    }
    return config;
  },
);
