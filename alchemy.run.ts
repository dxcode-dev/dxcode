import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import migrationManifest from "./apps/core/migration-manifest.json" with {
  type: "json",
};
import productionBindingContract from "./apps/core/production-bindings.json" with {
  type: "json",
};
import {
  E2BProfiles,
  e2bRecipeHash,
  HeldSecret,
  selfhostProviders,
} from "./deploy/selfhost/alchemy-resources.ts";
import { E2B_ORB_PROFILES } from "./packages/domain/src/settings/runner-profile.ts";
import { decodeGitHubAppDeploymentConfiguration } from "./packages/domain/src/source-control/github-app-configuration.ts";

type RecordValue<T> = T extends Record<string, infer Value> ? Value : never;
type WorkloadIdentitySigningKey = Alchemy.Resource<
  "Dx.WorkloadIdentitySigningKey",
  Record<string, never>,
  { keyring: Redacted.Redacted<string> }
>;

const WorkloadIdentitySigningKey = Alchemy.Resource<WorkloadIdentitySigningKey>(
  "Dx.WorkloadIdentitySigningKey",
);

const createWorkloadIdentitySigningKeyring = () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(12).toString("base64url");
  return JSON.stringify({
    version: 1,
    activeKid: kid,
    keys: [
      {
        kid,
        privateKeyPkcs8: keyPair.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        publicJwk: {
          ...keyPair.publicKey.export({ format: "jwk" }),
          use: "sig",
          alg: "RS256",
          kid,
        },
      },
    ],
  });
};

const workloadIdentitySigningKeyProvider = () =>
  Provider.succeed(WorkloadIdentitySigningKey, {
    reconcile: ({ output }) =>
      Effect.sync(() =>
        output?.keyring === undefined
          ? { keyring: Redacted.make(createWorkloadIdentitySigningKeyring()) }
          : output,
      ),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  });

const sourceControlSchemaVersion = /^\d{4}/.exec(
  migrationManifest.d1.at(-1)?.filename ?? "",
)?.[0];
if (sourceControlSchemaVersion === undefined)
  throw new Error("Migration manifest has no source-control schema version.");

const defaultE2BOrbProfile = E2B_ORB_PROFILES.find(
  ({ id }) => id === "a1.medium",
);
if (defaultE2BOrbProfile === undefined)
  throw new Error("The default E2B Orb profile is missing from the catalog.");

const productionWorkerBindings = <
  Groups extends Record<string, Record<string, unknown>>,
>(
  groups: Groups,
): Record<string, RecordValue<RecordValue<Groups>>> => {
  const contract = productionBindingContract.bindings
    .map(({ name, type }) => ({
      name,
      type,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actual = Object.entries(groups)
    .flatMap(([type, values]) =>
      Object.keys(values).map((name) => ({ name, type })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const required = productionBindingContract.bindings
    .filter((binding) => !("optional" in binding && binding.optional))
    .map(({ name, type }) => ({ name, type }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    productionBindingContract.version !== 1 ||
    new Set(contract.map(({ name }) => name)).size !== contract.length ||
    required.some(
      (binding) =>
        !actual.some(
          (candidate) =>
            candidate.name === binding.name && candidate.type === binding.type,
        ),
    ) ||
    actual.some(
      (binding) =>
        !contract.some(
          (candidate) =>
            candidate.name === binding.name && candidate.type === binding.type,
        ),
    )
  )
    throw new Error(
      "Alchemy Worker bindings drifted from the production binding contract.",
    );
  return Object.fromEntries(
    productionBindingContract.bindings.flatMap(({ name, type }) =>
      Object.hasOwn(groups[type] ?? {}, name)
        ? [[name, groups[type]?.[name]]]
        : [],
    ),
  ) as Record<string, RecordValue<RecordValue<Groups>>>;
};

const productionBindingByType = (type: string) => {
  const matches = productionBindingContract.bindings.filter(
    (binding) => binding.type === type,
  );
  if (matches.length !== 1)
    throw new Error(`Production binding contract must contain one ${type}.`);
  return matches[0];
};

const requiredHostedAuthenticationValue = <Value>(
  value: Value | undefined,
): Value => {
  if (value === undefined)
    throw new Error("Hosted authentication resource is unavailable.");
  return value;
};

const durableObjectBindingContract = () => {
  const contractBindings = productionBindingContract.bindings.filter(
    ({ type }) => type === "durable-object",
  );
  const authoredWrangler = JSON.parse(
    readFileSync(
      new URL("./apps/core/wrangler.jsonc", import.meta.url),
      "utf8",
    ),
  ) as {
    durable_objects?: {
      bindings?: Array<{ name: string; class_name: string }>;
    };
  };
  const authoredBindings = authoredWrangler.durable_objects?.bindings ?? [];
  const authoredContractNames = contractBindings
    .filter(({ provenance }) => provenance === "authored-wrangler")
    .map(({ name }) => name)
    .sort();
  const authoredNames = authoredBindings.map(({ name }) => name).sort();
  const generatedBindings = contractBindings.filter(
    ({ provenance }) => provenance === "generated-flue",
  );
  const canonicalClasses = migrationManifest.durableObjects.flatMap(
    ({ newSqliteClasses }) => newSqliteClasses,
  );
  const authoredClasses = authoredBindings.map(({ class_name }) => class_name);
  const generatedClasses = canonicalClasses.filter(
    (className) => !authoredClasses.includes(className),
  );

  if (
    JSON.stringify(authoredNames) !== JSON.stringify(authoredContractNames) ||
    new Set(canonicalClasses).size !== canonicalClasses.length ||
    authoredClasses.some(
      (className) => !canonicalClasses.includes(className),
    ) ||
    generatedBindings.length !== 1 ||
    generatedClasses.length !== 1
  )
    throw new Error(
      "Production Durable Object bindings do not match Wrangler and migration authorities.",
    );

  return [
    ...authoredBindings.map(({ name, class_name: className }) => ({
      name,
      className,
    })),
    { name: generatedBindings[0].name, className: generatedClasses[0] },
  ];
};

export default Alchemy.Stack(
  "dx-cloudflare",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Command.providers(),
      workloadIdentitySigningKeyProvider(),
      selfhostProviders(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stack = yield* Stack;
    const configuration = yield* Config.all({
      environment: Config.string("DX_DEPLOYMENT_ENVIRONMENT"),
      deploymentTarget: Config.string("DX_DEPLOYMENT_TARGET"),
      deploymentLabel: Config.string("DX_DEPLOYMENT_LABEL"),
      deploymentName: Config.option(
        Config.nonEmptyString("DX_DEPLOYMENT_NAME"),
      ),
      adminEmail: Config.option(Config.nonEmptyString("DX_ADMIN_EMAIL")),
      adminPassword: Config.option(Config.redacted("DX_ADMIN_PASSWORD")),
      adminPasswordReset: Config.withDefault(
        Config.boolean("DX_ADMIN_PASSWORD_RESET"),
        false,
      ),
      integrations: Config.withDefault(
        Config.string("DX_DEPLOYMENT_INTEGRATIONS"),
        "",
      ),
      origin: Config.string("DX_DEPLOYMENT_ORIGIN"),
      authEmailFrom: Config.option(
        Config.nonEmptyString("DX_DEPLOYMENT_AUTH_EMAIL_FROM"),
      ),
      revision: Config.string("DX_DEPLOYMENT_REVISION"),
      workerName: Config.string("DX_DEPLOYMENT_WORKER_NAME"),
      databaseName: Config.string("DX_DEPLOYMENT_DATABASE_NAME"),
      bucketName: Config.string("DX_DEPLOYMENT_BUCKET_NAME"),
      credentialsFile: Config.string("DX_DEPLOYMENT_CREDENTIALS_FILE"),
      bootstrapRepository: Config.withDefault(
        Config.string("DX_DEPLOYMENT_BOOTSTRAP_REPOSITORY"),
        "",
      ),
      packageDirectory: Config.string("DX_DEPLOYMENT_PACKAGE_DIR"),
      e2bTemplate: Config.string("DX_DEPLOYMENT_E2B_TEMPLATE"),
      e2bTemplateBuildId: Config.string("DX_DEPLOYMENT_E2B_TEMPLATE_BUILD_ID"),
      dxdChecksum: Config.string("DX_DEPLOYMENT_DXD_CHECKSUM"),
      dxdReleaseUrl: Config.string("DX_DEPLOYMENT_DXD_RELEASE_URL"),
      sourceShallowClone: Config.withDefault(
        Config.boolean("DX_DEPLOYMENT_SOURCE_SHALLOW_CLONE"),
        true,
      ),
      workspaceInactivityMs: Config.option(
        Config.number("DX_DEPLOYMENT_WORKSPACE_INACTIVITY_MS"),
      ),
      e2bApiKey: Config.option(Config.redacted("E2B_API_KEY")),
      githubApp: Config.option(Config.redacted("DX_INTEGRATION_GITHUB_APP")),
      sarvamApiKey: Config.option(Config.redacted("SARVAM_API_KEY")),
      workloadIdentitySigningKeys: Config.option(
        Config.redacted("DX_WORKLOAD_IDENTITY_SIGNING_KEYS"),
      ),
      bitbucketOAuth: Config.option(
        Config.redacted("DX_INTEGRATION_BITBUCKET_OAUTH"),
      ),
      deploymentZone: Config.option(
        Config.nonEmptyString("DX_DEPLOYMENT_ZONE"),
      ),
      signupEnabled: Config.withDefault(
        Config.boolean("DX_SIGNUP_ENABLED"),
        false,
      ),
      githubCopilotClientId: Config.option(
        Config.nonEmptyString("DX_GITHUB_COPILOT_CLIENT_ID"),
      ),
      modelDeploymentProviders: Config.option(
        Config.nonEmptyString("DX_MODEL_DEPLOYMENT_PROVIDERS"),
      ),
      modelEndpointAllowlist: Config.option(
        Config.nonEmptyString("DX_MODEL_ENDPOINT_ALLOWLIST"),
      ),
      workersAiEnabled: Config.withDefault(
        Config.boolean("DX_MODEL_WORKERS_AI_ENABLED"),
        true,
      ),
      workerTraces: Config.withDefault(
        Config.boolean("DX_DEPLOYMENT_WORKER_TRACES"),
        false,
      ),
    });

    const hostedAuthentication = Option.isSome(configuration.authEmailFrom);
    const expectedEnvironment =
      configuration.deploymentTarget === "branch"
        ? "preview"
        : configuration.deploymentTarget === "staging" ||
            configuration.deploymentTarget === "selfhost"
          ? configuration.deploymentTarget
          : undefined;
    if (
      expectedEnvironment === undefined ||
      configuration.environment !== expectedEnvironment
    )
      return yield* Effect.die(
        "DX_DEPLOYMENT_TARGET does not match DX_DEPLOYMENT_ENVIRONMENT.",
      );
    const authEmailFrom = Option.getOrUndefined(configuration.authEmailFrom);
    const selfhost = configuration.environment === "selfhost";
    const integrations = new Set(
      configuration.integrations.split(",").filter(Boolean),
    );
    const e2bApiKey = selfhost
      ? (yield* HeldSecret("E2BApiKey", {
          value: Option.getOrUndefined(configuration.e2bApiKey),
        })).value
      : Option.isSome(configuration.e2bApiKey)
        ? configuration.e2bApiKey.value
        : yield* Effect.die("E2B_API_KEY is required.");
    const githubApp = selfhost
      ? integrations.has("github")
        ? (yield* HeldSecret("GitHubAppSecret", {
            value: Option.getOrUndefined(configuration.githubApp),
          })).value
        : Redacted.make("{}")
      : Option.isSome(configuration.githubApp)
        ? configuration.githubApp.value
        : yield* Effect.die("DX_INTEGRATION_GITHUB_APP is required.");
    const adminPassword =
      selfhost && !hostedAuthentication
        ? (yield* HeldSecret("AdminPassword", {
            value: Option.getOrUndefined(configuration.adminPassword),
          })).value
        : undefined;
    const bitbucketOAuth =
      selfhost && integrations.has("bitbucket")
        ? (yield* HeldSecret("BitbucketOAuthSecret", {
            value: Option.getOrUndefined(configuration.bitbucketOAuth),
          })).value
        : Option.getOrUndefined(configuration.bitbucketOAuth);
    const sarvamApiKey =
      selfhost && integrations.has("sarvam")
        ? (yield* HeldSecret("SarvamApiKey", {
            value: Option.getOrUndefined(configuration.sarvamApiKey),
          })).value
        : Option.getOrUndefined(configuration.sarvamApiKey);
    const selfhostProfiles = selfhost
      ? yield* E2BProfiles("E2BProfiles", {
          apiKey: e2bApiKey,
          deploymentName: Option.getOrElse(
            configuration.deploymentName,
            () => "",
          ),
          recipeHash: yield* Effect.promise(() => e2bRecipeHash()),
        } as never)
      : undefined;

    if (Option.isSome(configuration.workspaceInactivityMs)) {
      const inactivityMs = configuration.workspaceInactivityMs.value;
      if (configuration.environment !== "preview")
        return yield* Effect.die(
          "DX_DEPLOYMENT_WORKSPACE_INACTIVITY_MS is restricted to previews.",
        );
      if (
        !Number.isInteger(inactivityMs) ||
        inactivityMs < 60_000 ||
        inactivityMs > 3_600_000
      )
        return yield* Effect.die(
          "DX_DEPLOYMENT_WORKSPACE_INACTIVITY_MS must be an integer from 60000 through 3600000.",
        );
    }

    if (
      !selfhost &&
      Redacted.value(githubApp as Redacted.Redacted<string>) !== "{}"
    ) {
      const input = yield* Effect.try({
        try: () =>
          JSON.parse(Redacted.value(githubApp as Redacted.Redacted<string>)),
        catch: () => new Error("Invalid GitHub App configuration JSON."),
      }).pipe(Effect.orDie);
      yield* decodeGitHubAppDeploymentConfiguration(
        input,
        configuration.origin,
        configuration.environment,
      ).pipe(Effect.orDie);
    }

    const deploymentHostname = new URL(configuration.origin).hostname;
    const database = yield* Cloudflare.D1.Database("Database", {
      name: configuration.databaseName,
      migrations: `apps/core/${migrationManifest.d1Directory}`,
    });
    const bucket = yield* Cloudflare.R2.Bucket("Storage", {
      name: configuration.bucketName,
      forceDestroy: false,
    });
    const turnstile = hostedAuthentication
      ? yield* Cloudflare.Turnstile.Widget("AccessTurnstile", {
          name: `dx access · ${deploymentHostname}`,
          domains: [deploymentHostname],
          mode: "managed",
        })
      : undefined;
    const email = hostedAuthentication
      ? yield* Cloudflare.Email.SendEmail("MagicLinkEmail", {
          allowedSenderAddresses: [
            requiredHostedAuthenticationValue(authEmailFrom),
          ],
        })
      : undefined;

    const authSecret = yield* Alchemy.Random("BetterAuthSecret", {});
    const encryptionSecret = yield* Alchemy.Random("ConfigEncryptionKey", {});
    const workloadIdentitySigningKeys = Option.isSome(
      configuration.workloadIdentitySigningKeys,
    )
      ? configuration.workloadIdentitySigningKeys.value
      : configuration.environment === "staging"
        ? yield* Effect.die(
            "DX_WORKLOAD_IDENTITY_SIGNING_KEYS is required for staging.",
          )
        : (yield* WorkloadIdentitySigningKey("WorkloadIdentitySigningKey", {}))
            .keyring;
    const encryptionKeyring = Output.map(encryptionSecret.text, (secret) =>
      Redacted.make(
        JSON.stringify({
          activeVersion: 1,
          keys: {
            1: Buffer.from(Redacted.value(secret), "hex").toString("base64"),
          },
        }),
      ),
    );
    const d1Binding = productionBindingByType("d1");
    const r2Binding = productionBindingByType("r2");
    const aiBinding = productionBindingByType("workers-ai");
    const durableObjectBindings = Object.fromEntries(
      durableObjectBindingContract().map(({ name, className }) => [
        name,
        Cloudflare.DurableObject(name, { className }),
      ]),
    );

    const workerBindings = productionWorkerBindings({
      text: {
        DX_ENV: configuration.environment,
        DX_DEPLOYMENT_TARGET: configuration.deploymentTarget,
        DX_RUNTIME_MODE: "deployed",
        ...(hostedAuthentication
          ? {
              DX_AUTH_EMAIL_FROM:
                requiredHostedAuthenticationValue(authEmailFrom),
              DX_TURNSTILE_SITE_KEY:
                requiredHostedAuthenticationValue(turnstile).sitekey,
            }
          : {}),
        DX_AUTH_URL: configuration.origin,
        DX_AUTH_TRUSTED_ORIGINS: configuration.origin,
        DX_E2B_TEMPLATE:
          selfhostProfiles?.defaultTemplate ??
          `${configuration.e2bTemplate}-${defaultE2BOrbProfile.templateSuffix}`,
        DX_E2B_TEMPLATE_BUILD_ID:
          selfhostProfiles?.defaultBuildId ?? configuration.e2bTemplateBuildId,
        DX_E2B_TIMEOUT_MS: "600000",
        ...(Option.isSome(configuration.workspaceInactivityMs)
          ? {
              DX_WORKSPACE_INACTIVITY_MS: String(
                configuration.workspaceInactivityMs.value,
              ),
            }
          : {}),
        DX_DEPLOYMENT_REVISION: configuration.revision,
        DX_DXD_PUBLIC_URL: configuration.origin,
        DX_DXD_RELEASE_URL: configuration.dxdReleaseUrl,
        DX_DXD_RELEASE_SHA256: configuration.dxdChecksum,
        DX_MIGRATION_MANIFEST_VERSION: String(migrationManifest.version),
        DX_RUNNER_PROFILE_CATALOG:
          selfhostProfiles === undefined
            ? JSON.stringify({
                version: 1,
                defaultProfileId: defaultE2BOrbProfile.id,
                profiles: E2B_ORB_PROFILES.map((profile) => ({
                  ...profile,
                  adapter: "e2b",
                  template: `${configuration.e2bTemplate}-${profile.templateSuffix}`,
                  isolation: "sandbox",
                  availability: "available",
                  capabilities: [
                    "git",
                    "environment-variables",
                    "internet-access",
                    "persistent-workspace",
                    "pause-resume",
                  ],
                })),
              })
            : Output.map(selfhostProfiles.profilesJson, (profilesJson) =>
                JSON.stringify({
                  version: 1,
                  defaultProfileId: defaultE2BOrbProfile.id,
                  profiles: JSON.parse(profilesJson).map(
                    (profile: Record<string, unknown>) => ({
                      ...profile,
                      adapter: "e2b",
                      isolation: "sandbox",
                      availability: "available",
                      capabilities: [
                        "git",
                        "environment-variables",
                        "internet-access",
                        "persistent-workspace",
                        "pause-resume",
                      ],
                    }),
                  ),
                }),
              ),
        DX_SOURCE_CONTROL_SCHEMA_VERSION: sourceControlSchemaVersion,
        DX_SOURCE_SHALLOW_CLONE: configuration.sourceShallowClone
          ? "true"
          : "false",
        DX_MANAGED_SSH_SIGNING_ENABLED: "true",
        ...(configuration.signupEnabled ? { DX_SIGNUP_ENABLED: "true" } : {}),
        ...(Option.isSome(configuration.githubCopilotClientId)
          ? {
              DX_GITHUB_COPILOT_CLIENT_ID:
                configuration.githubCopilotClientId.value,
            }
          : {}),
        ...(Option.isSome(configuration.modelDeploymentProviders)
          ? {
              DX_MODEL_DEPLOYMENT_PROVIDERS:
                configuration.modelDeploymentProviders.value,
            }
          : {}),
        ...(Option.isSome(configuration.modelEndpointAllowlist)
          ? {
              DX_MODEL_ENDPOINT_ALLOWLIST:
                configuration.modelEndpointAllowlist.value,
            }
          : {}),
        ...(configuration.workersAiEnabled
          ? {}
          : { DX_MODEL_WORKERS_AI_ENABLED: "false" }),
        DX_WORKLOAD_IDENTITY_ISSUER: `${configuration.origin}/api/workload-identity`,
        DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: JSON.stringify({
          version: 1,
          // Portable dxd-channel baseline, not an audience allowlist. Recipients
          // authorize claims; native-attestation integrations remain disabled.
          policies: [],
        }),
      },
      secret: {
        BETTER_AUTH_SECRET: authSecret.text,
        ...(hostedAuthentication
          ? {
              DX_TURNSTILE_SECRET_KEY:
                requiredHostedAuthenticationValue(turnstile).secret,
            }
          : {}),
        DX_CONFIG_ENCRYPTION_KEYS: encryptionKeyring,
        DX_INTEGRATION_GITHUB_APP: githubApp,
        DX_WORKLOAD_IDENTITY_SIGNING_KEYS: workloadIdentitySigningKeys,
        E2B_API_KEY: e2bApiKey,
        ...(sarvamApiKey !== undefined ? { SARVAM_API_KEY: sarvamApiKey } : {}),
        ...(bitbucketOAuth !== undefined
          ? {
              DX_INTEGRATION_BITBUCKET_OAUTH: bitbucketOAuth,
            }
          : {}),
      },
      d1: { [d1Binding.name]: database },
      r2: { [r2Binding.name]: bucket },
      "send-email": hostedAuthentication
        ? { EMAIL: requiredHostedAuthenticationValue(email) }
        : {},
      "workers-ai": {
        [aiBinding.name]: Cloudflare.Workers.AI(aiBinding.name),
      },
      "durable-object": durableObjectBindings,
    });

    const bootstrap = yield* Command.Exec("Bootstrap", {
      command: "node scripts/bootstrap-deployment.mjs",
      cwd: ".",
      env: {
        ...(selfhost && hostedAuthentication
          ? {
              DX_BOOTSTRAP_ADMIN_EMAIL: Option.getOrElse(
                configuration.adminEmail,
                () => "",
              ),
              DX_BOOTSTRAP_HOSTED_AUTH: "true",
              DX_BOOTSTRAP_STAGE: stack.stage,
            }
          : selfhost
            ? {
                DX_BOOTSTRAP_ADMIN_EMAIL: Option.getOrElse(
                  configuration.adminEmail,
                  () => "",
                ),
                DX_BOOTSTRAP_ADMIN_PASSWORD: adminPassword ?? Redacted.make(""),
                DX_BOOTSTRAP_ADMIN_PASSWORD_RESET:
                  configuration.adminPasswordReset ? "true" : "false",
                DX_BOOTSTRAP_STAGE: stack.stage,
              }
            : {
                DX_BOOTSTRAP_CREDENTIALS_FILE: configuration.credentialsFile,
                DX_BOOTSTRAP_REPOSITORY: configuration.bootstrapRepository,
              }),
        DX_BOOTSTRAP_DATABASE_ID: database.databaseId,
        DX_BOOTSTRAP_RUNNER_PROFILE_ID: defaultE2BOrbProfile.id,
      },
      memo: false,
      timeout: "3 minutes",
    });

    const deployedWorkerBindings = selfhost
      ? {
          ...workerBindings,
          DX_ENV: Output.map(
            bootstrap.hash.input,
            () => configuration.environment,
          ),
        }
      : workerBindings;

    const worker = yield* Cloudflare.Worker("Worker", {
      // Bootstrap admits the configured first user before exposing the Worker.
      name: configuration.workerName,
      main: `${configuration.packageDirectory}/worker/index.js`,
      bundle: false,
      compatibility: {
        date: "2026-08-20",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      version: {
        tag: configuration.revision,
        message: `Git ${configuration.revision.slice(0, 12)}`,
      },
      assets: {
        directory: `${configuration.packageDirectory}/assets`,
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/v1", "/v1/*", "/healthz", "/readyz"],
      },
      env: deployedWorkerBindings,
      // Logs match Alchemy's default; traces are an explicit operator opt-in.
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        traces: {
          enabled: configuration.workerTraces,
          headSamplingRate: 1,
          persist: true,
        },
      },
      crons: configuration.environment === "staging" ? ["17 3 * * *"] : [],
      workersDev: !Option.isSome(configuration.deploymentZone),
      ...(Option.isSome(configuration.deploymentZone)
        ? {
            domain: {
              name: new URL(configuration.origin).hostname,
              zoneName: configuration.deploymentZone.value,
            },
          }
        : {}),
    });

    if (!selfhost)
      yield* Command.Exec("Verify", {
        command: "node scripts/verify-alchemy-preview.mjs",
        cwd: ".",
        env: {
          DX_PREVIEW_URL: configuration.origin,
          DX_PREVIEW_DEPLOYMENT_LABEL: configuration.deploymentLabel,
          ...(configuration.environment !== "staging"
            ? { DX_PREVIEW_DXD_SHA256: configuration.dxdChecksum }
            : {}),
          DX_PREVIEW_WORKER_ID: worker.workerId,
          DX_PREVIEW_BOOTSTRAP: Output.map(bootstrap.hash.input, () => "ready"),
        },
        memo: false,
        timeout: "3 minutes",
      });

    return {
      stage: stack.stage,
      url: worker.url,
      workerName: worker.workerName,
      workerId: worker.workerId,
      databaseName: database.databaseName,
      databaseId: database.databaseId,
      bucketName: bucket.bucketName,
      revision: configuration.revision,
    };
  }),
);
