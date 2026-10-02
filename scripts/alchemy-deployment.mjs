import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import * as Output from "alchemy/Output";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import { alchemyStage } from "./alchemy-stage.mjs";

export const reservedBranches = new Set([
  "dev",
  "main",
  "master",
  "prod",
  "production",
  "staging",
]);

let hostedDeploymentPolicy;

export const configureHostedDeploymentPolicy = (policy) => {
  if (
    policy === null ||
    typeof policy !== "object" ||
    !/^[a-f0-9]{32}$/.test(policy.accountId) ||
    typeof policy.zone !== "string" ||
    !/^[a-z0-9.-]+$/.test(policy.zone) ||
    typeof policy.stagingDomain !== "string" ||
    !/^[a-z0-9.-]+$/.test(policy.stagingDomain) ||
    (policy.stagingDomain !== policy.zone &&
      !policy.stagingDomain.endsWith(`.${policy.zone}`)) ||
    typeof policy.authEmailFrom !== "string" ||
    !policy.authEmailFrom.endsWith(`@${policy.zone}`) ||
    typeof policy.reviewerEmailDomain !== "string" ||
    !/^[a-z0-9.-]+$/.test(policy.reviewerEmailDomain) ||
    policy.bootstrapRepository === null ||
    typeof policy.bootstrapRepository !== "object"
  )
    throw new Error("Hosted deployment policy is invalid.");
  hostedDeploymentPolicy = Object.freeze({
    ...policy,
    bootstrapRepository: Object.freeze({ ...policy.bootstrapRepository }),
  });
  return hostedDeploymentPolicy;
};

const hostedPolicy = () => {
  if (hostedDeploymentPolicy === undefined)
    throw new Error("Hosted deployment policy is not configured.");
  return hostedDeploymentPolicy;
};
const migrationDirectory = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../apps/core/migration-manifest.json"),
    "utf8",
  ),
).d1Directory;
const workerBindingContract = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../apps/core/production-bindings.json"),
    "utf8",
  ),
).bindings;
const workerBindingNames = workerBindingContract.map(({ name }) => name).sort();
const optionalWorkerBindingNames = new Set(
  workerBindingContract
    .filter(({ optional }) => optional)
    .map(({ name }) => name),
);
const interruptedWorkerBindingOmissions = new Set([
  "BETTER_AUTH_SECRET",
  "DB",
  "DX_CONFIG_ENCRYPTION_KEYS",
  "DX_STORAGE",
  "DX_WORKLOAD_IDENTITY_SIGNING_KEYS",
]);
const preWorkloadIdentityBindingOmissions = [
  "DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES",
  "DX_WORKLOAD_IDENTITY_ISSUER",
  "DX_WORKLOAD_IDENTITY_SIGNING_KEYS",
];
const preDeploymentTargetBindingOmission = "DX_DEPLOYMENT_TARGET";
const preSourceShallowCloneBindingOmission = "DX_SOURCE_SHALLOW_CLONE";
const preRealtimeHubBindingOmission = "REALTIME_HUB";
const preAuthenticationEmailBindingOmissions = ["DX_AUTH_EMAIL_FROM", "EMAIL"];
const preTurnstileBindingOmissions = [
  "DX_TURNSTILE_SECRET_KEY",
  "DX_TURNSTILE_SITE_KEY",
];
const destroyWorkerBindingOmissions = new Set([
  "BYOK_CREDENTIAL_COORDINATOR",
  "DX_AUTH_EMAIL_FROM",
  "DX_DEPLOYMENT_TARGET",
  "DX_GITHUB_COPILOT_CLIENT_ID",
  "DX_MODEL_DEPLOYMENT_PROVIDERS",
  "DX_MODEL_ENDPOINT_ALLOWLIST",
  "DX_MODEL_WORKERS_AI_ENABLED",
  "DX_SIGNUP_ENABLED",
  "DX_TURNSTILE_SECRET_KEY",
  "DX_TURNSTILE_SITE_KEY",
  "DX_WORKSPACE_INACTIVITY_MS",
  "EMAIL",
  "REALTIME_HUB",
]);
const preBranchPreviewIdentityBindingOmissions = [
  "DX_DEPLOYMENT_TARGET",
  "DX_MODEL_DEPLOYMENT_PROVIDERS",
  "DX_MODEL_ENDPOINT_ALLOWLIST",
  "DX_MODEL_WORKERS_AI_ENABLED",
  "DX_SIGNUP_ENABLED",
];
const deploymentBuildEnvironmentNames = new Set([
  "CARGO_HOME",
  "CI",
  "HOME",
  "PATH",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
]);
const workerDurableObjectBindings = [
  ["BYOK_CREDENTIAL_COORDINATOR", "ByokCredentialCoordinatorObject"],
  ["FLUE_DX_AGENT_AGENT", "FlueDxAgentAgent"],
  ["PLUGIN_TRIGGER_DELIVERY", "PluginTriggerDeliveryObject"],
  ["REALTIME_HUB", "RealtimeHub"],
  [
    "SUBSCRIPTION_CREDENTIAL_COORDINATOR",
    "SubscriptionCredentialCoordinatorObject",
  ],
  ["THREAD_EXECUTION", "ThreadExecutionObject"],
];
const commonDeploymentResourceTypes = new Map([
  ["AccessTurnstile", "Cloudflare.Turnstile.Widget"],
  ["BetterAuthSecret", "Alchemy.Random"],
  ["Bootstrap", "Command.Exec"],
  ["ConfigEncryptionKey", "Alchemy.Random"],
  ["Database", "Cloudflare.D1Database"],
  ["Storage", "Cloudflare.R2.Bucket"],
  ["Verify", "Command.Exec"],
  ["Worker", "Cloudflare.Worker"],
]);
const deploymentResourceTypes = (
  target,
  integrations = [],
  turnstileTestKeys = false,
  workersDevSubdomain = undefined,
) =>
  new Map([
    // The dxd ingress Worker is served on the account's workers.dev subdomain.
    ...(workersDevSubdomain === undefined
      ? []
      : [["DaemonIngress", "Cloudflare.Worker"]]),
    ...[...commonDeploymentResourceTypes].filter(
      ([id]) =>
        (target !== "selfhost" && !turnstileTestKeys) ||
        id !== "AccessTurnstile",
    ),
    ...(target === "branch" || target === "selfhost"
      ? [["WorkloadIdentitySigningKey", "Dx.WorkloadIdentitySigningKey"]]
      : []),
    ...(target === "selfhost"
      ? [
          ["AdminPassword", "Dx.HeldSecret"],
          ["E2BApiKey", "Dx.HeldSecret"],
          ["E2BProfiles", "Dx.E2BProfiles"],
          ...(integrations.includes("github")
            ? [["GitHubAppSecret", "Dx.HeldSecret"]]
            : []),
          ...(integrations.includes("bitbucket")
            ? [["BitbucketOAuthSecret", "Dx.HeldSecret"]]
            : []),
          ...(integrations.includes("sarvam")
            ? [["SarvamApiKey", "Dx.HeldSecret"]]
            : []),
        ]
      : []),
  ]);
const retiredRandomResourceIds = new Set([
  "ModelInvocationKey",
  "ModelReplayKey",
]);
const retiredWorkerBindings = new Map([
  ["ACCOUNT_SHELL", "durable_object_namespace"],
  ["DX_MODEL_INVOCATION_HMAC_KEYS", "secret_text"],
  ["DX_MODEL_REPLAY_SEAL_KEYS", "secret_text"],
  ["DX_WEB_PROVIDER", "plain_text"],
  ["EXA_API_KEY", "secret_text"],
  ["MODEL_EGRESS_COORDINATOR", "durable_object_namespace"],
]);
const cloudflareResourceIds = new Set([
  "DaemonIngress",
  "Database",
  "Storage",
  "Worker",
]);
const dictationMigrationAlias = Object.freeze({
  legacyName: "0079_dictation_jobs.sql",
  currentName: "0045_dictation_jobs.sql",
  hash: "4aa7b21c33fd4dd79de6c7ea64ab52f0331340a14ae7ad798a54c9b051f85397",
});
const branchAppearanceMigrationAliases = Object.freeze([
  {
    legacyName: "0050_personal_account_appearance.sql",
    currentName: "0053_personal_account_appearance.sql",
    hash: "cf810409d2eda248e2ad0ccfc103d3cc31d640f654b2e51ec2cbaacb79e7a08a",
  },
  {
    legacyName: "0051_terminal_theme_catalog.sql",
    currentName: "0054_terminal_theme_catalog.sql",
    hash: "8ccdb25e7b87fffa3f7c1712034347a9dfec37771c9c2e9801d360f6f753e9a4",
  },
]);

export const assertDeploymentAccount = (accountId) => {
  if (accountId !== hostedPolicy().accountId) {
    throw new Error("Cloudflare account is not approved for dx deployments.");
  }
};

export const resolveCloudflareDatabaseId = (databases, databaseName) => {
  if (!Array.isArray(databases))
    throw new Error("Cloudflare returned an invalid D1 identity response.");
  if (databases.some((database) => !database || typeof database !== "object"))
    throw new Error("Cloudflare returned an invalid D1 identity response.");
  const matches = databases.filter(({ name }) => name === databaseName);
  if (matches.length > 1)
    throw new Error("Cloudflare returned an ambiguous exact D1 identity.");
  if (matches.length === 0) return undefined;
  const databaseId = matches[0].uuid;
  if (!databaseId || typeof databaseId !== "string")
    throw new Error("Cloudflare returned an incomplete exact D1 identity.");
  return databaseId;
};

export const reconcileDeploymentMigrationAliases = async ({
  operation,
  query,
  target,
}) => {
  if (operation !== "deploy" || target === "selfhost") return;
  const aliases =
    target === "staging"
      ? [dictationMigrationAlias]
      : branchAppearanceMigrationAliases;
  for (const alias of aliases) {
    const select = `SELECT name, hash FROM __alchemy_migrations WHERE name IN ('${alias.legacyName}', '${alias.currentName}') ORDER BY name`;
    const validateCurrent = (rows) =>
      Array.isArray(rows) &&
      rows.length === 1 &&
      Object.keys(rows[0]).sort().join("|") === "hash|name" &&
      rows[0].name === alias.currentName &&
      rows[0].hash === alias.hash;
    const before = await query(select);
    if (validateCurrent(before)) continue;
    if (target === "branch" && Array.isArray(before) && before.length === 0)
      continue;
    const legacy =
      Array.isArray(before) &&
      before.length === 1 &&
      Object.keys(before[0]).sort().join("|") === "hash|name" &&
      before[0].name === alias.legacyName &&
      before[0].hash === alias.hash;
    if (!legacy)
      throw new Error("Deployment migration alias history is not approved.");
    await query(
      `UPDATE __alchemy_migrations SET name = '${alias.currentName}' WHERE name = '${alias.legacyName}' AND hash = '${alias.hash}'`,
    );
    if (!validateCurrent(await query(select)))
      throw new Error(
        "Deployment migration alias reconciliation did not settle.",
      );
  }
};

const selfhostNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

export const selfhostStage = (name) => {
  if (typeof name !== "string" || !selfhostNamePattern.test(name))
    throw new Error(
      "DX_DEPLOYMENT_NAME must be 2-40 lowercase letters, numbers, or hyphens.",
    );
  return `selfhost-${name}`;
};

export const assertDeploymentTarget = ({ branch, stage, target, selfhost }) => {
  if (target === "staging") {
    if (stage !== "staging")
      throw new Error("Staging deployment requires the exact staging stage.");
    return;
  }
  if (target === "selfhost") {
    if (selfhost === undefined || stage !== selfhostStage(selfhost.name))
      throw new Error(
        "Self-host deployment requires its exact derived stage from DX_DEPLOYMENT_NAME.",
      );
    return;
  }
  if (target !== "branch") throw new Error("Unknown deployment target.");
  if (branch === "" || reservedBranches.has(branch.trim().toLowerCase())) {
    throw new Error("Branch deployment requires a non-reserved named branch.");
  }
  if (stage !== alchemyStage(branch))
    throw new Error("Branch deployment must use its exact derived stage.");
};

export const assertE2BTemplate = (template) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(template)) {
    throw new Error("DX_E2B_TEMPLATE is not a valid E2B template name.");
  }
  if (template === "base")
    throw new Error("DX_E2B_TEMPLATE must not select E2B base.");
};

export const resolveE2BTemplateEvidence = async (template, listTemplates) => {
  assertE2BTemplate(template);
  const matches = (await listTemplates()).filter(({ names }) =>
    names.includes(template),
  );
  if (matches.length !== 1)
    throw new Error(
      `DX_E2B_TEMPLATE must name one existing E2B template: ${template}.`,
    );
  const selected = matches[0];
  if (selected.buildStatus !== "ready" || !selected.buildID)
    throw new Error(`E2B template ${template} has no immutable ready build.`);
  return { name: template, buildId: selected.buildID };
};

export const resourceName = (kind, stage, maximumLength = 63) => {
  const value = `dx-${kind}-${stage}`;
  if (value.length <= maximumLength) return value;
  const identity = createHash("sha256")
    .update(stage)
    .digest("hex")
    .slice(0, 12);
  return `${value.slice(0, maximumLength - identity.length - 1)}-${identity}`;
};

const assertSelfhostDomain = ({ domain, zone }) => {
  if (typeof domain !== "string" || domain === "" || domain.length > 253)
    throw new Error(
      "Self-host deployment requires DX_DEPLOYMENT_DOMAIN (a custom hostname or the worker's workers.dev hostname).",
    );
  let hostname;
  try {
    hostname = new URL(`https://${domain}`).hostname;
  } catch {
    throw new Error("DX_DEPLOYMENT_DOMAIN is not a valid hostname.");
  }
  if (hostname !== domain)
    throw new Error(
      "DX_DEPLOYMENT_DOMAIN must be a bare hostname without scheme or path.",
    );
  if (zone === undefined) {
    if (!hostname.endsWith(".workers.dev"))
      throw new Error(
        "A self-host deployment without DX_DEPLOYMENT_ZONE must deploy on workers.dev.",
      );
    return;
  }
  if (
    typeof zone !== "string" ||
    !/^[a-z0-9.-]+$/.test(zone) ||
    zone.length > 253
  )
    throw new Error("DX_DEPLOYMENT_ZONE is not a valid zone name.");
  if (hostname !== zone && !hostname.endsWith(`.${zone}`))
    throw new Error("DX_DEPLOYMENT_DOMAIN must belong to DX_DEPLOYMENT_ZONE.");
};

export const deploymentDomain = ({ branch, target, selfhost }) => {
  if (target === "staging") return hostedPolicy().stagingDomain;
  if (target === "selfhost") {
    assertSelfhostDomain(selfhost ?? {});
    return selfhost.domain;
  }
  const readable =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "branch";
  const identity = createHash("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, 8);
  return `dx-${readable}-${identity}.${hostedPolicy().zone}`;
};

export const assertDxdChecksum = (checksum) => {
  if (!/^[a-f0-9]{64}$/.test(checksum))
    throw new Error("DX_DXD_RELEASE_SHA256 must be an exact SHA-256 digest.");
};

export const parseDeploymentRevisionArgument = (arguments_) => {
  const values = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (values.length > 1)
    throw new Error(
      "Usage: pnpm alchemy:staging:deploy -- <selected-revision>",
    );
  return values[0];
};

export const bootstrapIdentity = (stage) => {
  const hash = createHash("sha256").update(stage).digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return {
    userId: `usr_${hash.slice(0, 32)}`,
    accountId: `acc_${hash.slice(0, 32)}`,
    projectId: `prj_${uuid}`,
  };
};

const branchBootstrapUsername = (stage) =>
  `branch-${createHash("sha256").update(stage).digest("hex").slice(0, 16)}`;

const sharedDeploymentCredentialSource = "project-reviewer-v1";
const sharedDeploymentUsernameFallback = "deployment-reviewer";
const validReviewerEmail = (email) =>
  /^[^\s@]+@[^\s@]+$/.test(email) &&
  email.endsWith(`@${hostedPolicy().reviewerEmailDomain}`);
const sharedDeploymentUsername = (email) => {
  const localPart = email.slice(0, email.indexOf("@"));
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(localPart)
    ? localPart
    : sharedDeploymentUsernameFallback;
};

const assertBootstrapUsername = (
  username,
  label = "Deployment reviewer username",
) => {
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(username))
    throw new Error(
      `${label} must be 3-32 lowercase letters, numbers, or hyphens.`,
    );
};

const sharedDeploymentCredentials = (environment, target) => {
  if (target === "selfhost") {
    const email = environment.DX_ADMIN_EMAIL?.trim().toLowerCase();
    const password = environment.DX_ADMIN_PASSWORD;
    if (
      !email ||
      email.length < 3 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+$/.test(email)
    )
      throw new Error("DX_ADMIN_EMAIL is required for a self-host deployment.");
    if (!password || password.trim().length === 0)
      throw new Error(
        "DX_ADMIN_PASSWORD is required for a self-host deployment.",
      );
    if (password.length < 8 || password.length > 128)
      throw new Error("DX_ADMIN_PASSWORD must be 8-128 characters.");
    const username = sharedDeploymentUsername(email);
    assertBootstrapUsername(username, "DX_ADMIN_USERNAME");
    return { email, password, username };
  }
  const configuredEmail = environment.DX_DEPLOYMENT_REVIEWER_EMAIL?.trim();
  const configuredPassword = environment.DX_DEPLOYMENT_REVIEWER_PASSWORD;
  if (configuredEmail !== undefined || configuredPassword !== undefined) {
    if (!configuredEmail)
      throw new Error("DX_DEPLOYMENT_REVIEWER_EMAIL is required.");
    if (!configuredPassword || configuredPassword.trim().length === 0)
      throw new Error("DX_DEPLOYMENT_REVIEWER_PASSWORD is required.");
    const email = configuredEmail.toLowerCase();
    if (email.length < 3 || email.length > 254 || !validReviewerEmail(email))
      throw new Error(
        "DX_DEPLOYMENT_REVIEWER_EMAIL must use the configured reviewer domain.",
      );
    const username = sharedDeploymentUsername(email);
    assertBootstrapUsername(username, "DX_DEPLOYMENT_REVIEWER_USERNAME");
    if (configuredPassword.length < 8 || configuredPassword.length > 128)
      throw new Error(
        "DX_DEPLOYMENT_REVIEWER_PASSWORD must be 8-128 characters.",
      );
    return { email, password: configuredPassword, username };
  }

  if (target === "staging") {
    const username = environment.DX_STAGING_TEST_USERNAME?.trim();
    const password = environment.DX_STAGING_TEST_PASSWORD;
    if (!username) throw new Error("DX_STAGING_TEST_USERNAME is required.");
    if (!password || password.trim().length === 0)
      throw new Error("DX_STAGING_TEST_PASSWORD is required.");
    assertBootstrapUsername(username, "DX_STAGING_TEST_USERNAME");
    if (password.length < 8 || password.length > 128)
      throw new Error("DX_STAGING_TEST_PASSWORD must be 8-128 characters.");
    return {
      email: `${username}@${hostedPolicy().reviewerEmailDomain}`,
      password,
      username,
    };
  }

  throw new Error(
    "DX_DEPLOYMENT_REVIEWER_EMAIL and DX_DEPLOYMENT_REVIEWER_PASSWORD are required for a new branch preview.",
  );
};

const readDeploymentCredentials = ({ credentialsFile, stage, target }) => {
  try {
    const existing = JSON.parse(readFileSync(credentialsFile, "utf8"));
    assertDeploymentCredentials(existing, stage, target);
    chmodSync(credentialsFile, 0o600);
    return existing;
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new Error("Deployment credentials are invalid.");
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

export const prepareDeploymentCredentials = ({
  credentialsFile,
  environment,
  stage,
  target,
  databaseId,
}) => {
  const existing = readDeploymentCredentials({
    credentialsFile,
    stage,
    target,
  });
  if (existing !== undefined) return existing;
  if (databaseId !== undefined)
    throw new Error(
      `The ${target} stage already has a D1 database, but its private credentials file is missing. Recover the exact credentials before deploying.`,
    );

  const ids = bootstrapIdentity(stage);
  const shared = sharedDeploymentCredentials(environment, target);
  return writePrivateCredentials(credentialsFile, {
    version: 2,
    source: sharedDeploymentCredentialSource,
    target,
    stage,
    ...shared,
    ...ids,
    ...(target === "selfhost"
      ? { bootstrapProject: false, displayName: "dx admin" }
      : {}),
  });
};

const assertStoredCredentials = (value, expected, label) => {
  const selfhost = expected.target === "selfhost";
  const versionValid =
    (!selfhost && value?.version === 1) ||
    (value?.version === 2 && value.source === sharedDeploymentCredentialSource);
  if (
    !versionValid ||
    value.target !== expected.target ||
    value.stage !== expected.stage ||
    typeof value.username !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(value.username) ||
    typeof value.email !== "string" ||
    value.email.length < 3 ||
    value.email.length > 254 ||
    (!selfhost && !validReviewerEmail(value.email)) ||
    (selfhost && !/^[^\s@]+@[^\s@]+$/.test(value.email)) ||
    (value.version === 1 &&
      value.email !==
        `${value.username}@${hostedPolicy().reviewerEmailDomain}`) ||
    (value.version === 2 &&
      value.username !== sharedDeploymentUsername(value.email)) ||
    typeof value.password !== "string" ||
    value.password.length < 8 ||
    value.password.length > 128 ||
    (expected.username !== undefined && value.username !== expected.username) ||
    value.userId !== expected.userId ||
    value.accountId !== expected.accountId ||
    value.projectId !== expected.projectId
  )
    throw new Error(`${label} credentials do not match this exact stage.`);
};

export const assertBranchDeploymentCredentials = (value, stage) => {
  assertStoredCredentials(
    value,
    {
      stage,
      target: "branch",
      username:
        value?.version === 1 ? branchBootstrapUsername(stage) : undefined,
      ...bootstrapIdentity(stage),
    },
    "Branch",
  );
  return value;
};

export const assertDeploymentCredentials = (value, stage, target) => {
  if (target === "branch")
    return assertBranchDeploymentCredentials(value, stage);
  if (target === "selfhost") {
    if (!stage.startsWith("selfhost-") || typeof value?.username !== "string")
      throw new Error("Deployment credentials target is invalid.");
    assertStoredCredentials(
      value,
      { stage, target, ...bootstrapIdentity(stage) },
      "Self-host",
    );
    return value;
  }
  if (
    target !== "staging" ||
    stage !== "staging" ||
    typeof value?.username !== "string"
  )
    throw new Error("Deployment credentials target is invalid.");
  assertStoredCredentials(
    value,
    {
      stage,
      target,
      ...bootstrapIdentity(stage),
    },
    "Staging",
  );
  return value;
};

const writePrivateCredentials = (credentialsFile, value) => {
  mkdirSync(resolve(credentialsFile, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(credentialsFile, 0o600);
  return value;
};

export const deploymentGitHubApp = ({ target, operation, environment }) => {
  // Self-host deployments may carry their own GitHub App configuration.
  if (target === "selfhost") {
    if (operation !== "deploy") return undefined;
    const value = environment.DX_INTEGRATION_GITHUB_APP?.trim();
    return value || undefined;
  }
  // Never forward the shared staging App to branch previews or destroy plans.
  if (target !== "staging" || operation !== "deploy") return "{}";
  const value = environment.DX_GITHUB_STAGING_APP;
  if (!value?.trim() || value.trim() === "{}")
    throw new Error(
      "DX_GITHUB_STAGING_APP is required for staging deployment.",
    );
  return value;
};

export const deploymentBitbucketOAuth = ({
  target,
  operation,
  environment,
}) => {
  // A shared OAuth consumer cannot use a branch-varying callback origin.
  if (target === "branch" && operation === "deploy") return "{}";
  if (operation !== "deploy") return undefined;
  const value = environment.DX_INTEGRATION_BITBUCKET_OAUTH;
  return value?.trim() ? value : undefined;
};

export const deploymentSelection = ({ branch, stage, target, selfhost }) => {
  assertDeploymentTarget({ branch, stage, target, selfhost });
  const domain = deploymentDomain({ branch, stage, target, selfhost });
  const selection = {
    accountId:
      target === "selfhost" ? selfhost.accountId : hostedPolicy().accountId,
    branch,
    target,
    stage,
    domain,
    zone: target === "selfhost" ? selfhost.zone : hostedPolicy().zone,
    ...(target === "selfhost" ? { selfhost } : {}),
    workerName:
      target === "staging" ? "dx-staging" : resourceName("app", stage),
    databaseName: resourceName("db", stage),
    bucketName: resourceName("storage", stage),
  };
  assertDeploymentSelection(selection);
  return selection;
};

export const loadSelfhostConfig = ({ environment, workspaceRoot }) => {
  const configPath =
    environment.DX_SELFHOST_CONFIG?.trim() || "deploy.selfhost.json";
  const absolute = resolve(workspaceRoot, configPath);
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      if (environment.DX_SELFHOST_CONFIG?.trim())
        throw new Error(`Self-host config not found: ${configPath}`);
    } else if (cause instanceof SyntaxError) {
      throw new Error(`Self-host config ${configPath} is not valid JSON.`);
    } else {
      throw cause;
    }
  }
  const config = validateSelfhostConfig({
    ...raw,
    ...(environment.DX_DEPLOYMENT_NAME?.trim()
      ? { name: environment.DX_DEPLOYMENT_NAME.trim() }
      : {}),
    ...(environment.DX_DEPLOYMENT_DOMAIN?.trim()
      ? { domain: environment.DX_DEPLOYMENT_DOMAIN.trim() }
      : {}),
    ...(environment.DX_DEPLOYMENT_ZONE?.trim()
      ? { zone: environment.DX_DEPLOYMENT_ZONE.trim() }
      : {}),
    ...(environment.DX_ADMIN_EMAIL?.trim()
      ? { adminEmail: environment.DX_ADMIN_EMAIL.trim() }
      : {}),
    ...(environment.DX_DEPLOYMENT_AUTH_EMAIL_FROM?.trim()
      ? {
          authEmailFrom: environment.DX_DEPLOYMENT_AUTH_EMAIL_FROM.trim(),
        }
      : {}),
    ...(environment.DX_DXD_BINARY?.trim()
      ? { dxdBinary: environment.DX_DXD_BINARY.trim() }
      : {}),
    ...(environment.DX_SIGNUP_ENABLED !== undefined
      ? { allowSignup: environment.DX_SIGNUP_ENABLED === "true" }
      : {}),
    ...(environment.DX_GITHUB_COPILOT_CLIENT_ID?.trim()
      ? {
          githubCopilotClientId: environment.DX_GITHUB_COPILOT_CLIENT_ID.trim(),
        }
      : {}),
    ...(environment.DX_MODEL_DEPLOYMENT_PROVIDERS?.trim()
      ? {
          modelDeploymentProviders:
            environment.DX_MODEL_DEPLOYMENT_PROVIDERS.trim(),
        }
      : {}),
    ...(environment.DX_MODEL_ENDPOINT_ALLOWLIST?.trim()
      ? {
          modelEndpointAllowlist:
            environment.DX_MODEL_ENDPOINT_ALLOWLIST.trim(),
        }
      : {}),
    ...(environment.DX_MODEL_WORKERS_AI_ENABLED !== undefined
      ? {
          workersAi: environment.DX_MODEL_WORKERS_AI_ENABLED !== "false",
        }
      : {}),
    ...(environment.DX_DEPLOYMENT_INTEGRATIONS?.trim()
      ? {
          integrations: environment.DX_DEPLOYMENT_INTEGRATIONS.split(","),
        }
      : {}),
  });
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId))
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required for self-host deploys.");
  if (
    config.cloudflareAccountId !== undefined &&
    config.cloudflareAccountId !== accountId
  )
    throw new Error(
      "cloudflareAccountId does not match the authenticated Cloudflare account.",
    );
  const environment_ = {
    ...environment,
    DX_ADMIN_EMAIL: config.adminEmail,
  };
  return {
    ...config,
    accountId,
    environment: environment_,
  };
};

export const assertCleanRevision = ({
  branch,
  gitStatus,
  headRevision,
  operation,
  selectedRevision,
  target,
}) => {
  if (gitStatus !== "")
    throw new Error("Alchemy deployment requires a clean Git commit.");
  if (target === "selfhost") return;
  if (target === "branch" && branch === "")
    throw new Error("Branch deployment requires a named Git branch.");
  if (target === "staging" && operation === "deploy") {
    if (!selectedRevision)
      throw new Error(
        "Staging deploy requires an operator-selected revision argument.",
      );
    if (selectedRevision !== headRevision)
      throw new Error(
        "Check out the selected staging revision in a clean worktree before deploying it.",
      );
  }
};

export const deploymentGitStatusArguments = ({
  environment,
  target,
  workspaceRoot,
}) => {
  const args = ["status", "--porcelain"];
  if (
    target !== "selfhost" ||
    environment.DX_SELFHOST_CONFIG_PROVISIONAL !== "1"
  )
    return args;
  const configPath = environment.DX_SELFHOST_CONFIG?.trim();
  if (!configPath) return args;
  const relativePath = relative(
    workspaceRoot,
    resolve(workspaceRoot, configPath),
  );
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    return args;
  return [
    ...args,
    "--",
    ".",
    `:(top,exclude,literal)${relativePath.split(sep).join("/")}`,
  ];
};

export const assertDeploymentSelection = (selection) => {
  if (selection.target !== "selfhost")
    assertDeploymentAccount(selection.accountId);
  assertDeploymentTarget(selection);
  const expectedDomain = deploymentDomain(selection);
  if (
    !new Set(["branch", "staging", "selfhost"]).has(selection.target) ||
    (selection.target === "staging" && selection.stage !== "staging") ||
    (selection.target === "branch" && !selection.stage.startsWith("branch-")) ||
    (selection.target === "selfhost" &&
      (!selection.stage.startsWith("selfhost-") ||
        typeof selection.accountId !== "string" ||
        !/^[a-f0-9]{32}$/.test(selection.accountId))) ||
    selection.domain !== expectedDomain ||
    (selection.target === "selfhost" &&
      ((selection.domain.endsWith(".workers.dev") &&
        selection.zone !== undefined) ||
        (!selection.domain.endsWith(".workers.dev") &&
          selection.zone === undefined))) ||
    (selection.target !== "selfhost" &&
      selection.zone !== hostedPolicy().zone) ||
    selection.workerName !==
      (selection.target === "staging"
        ? "dx-staging"
        : resourceName("app", selection.stage)) ||
    selection.databaseName !== resourceName("db", selection.stage) ||
    selection.bucketName !== resourceName("storage", selection.stage)
  )
    throw new Error(
      "Deployment target, stage, domain, or resource name is outside the exact allowlist.",
    );
};

const validateWorkerProps = (
  props,
  selection,
  current,
  representation,
  allowedMissingEnvironmentNames = new Set(),
  allowDestroyWorkerBindingOmissions = false,
) => {
  const domain = props.domain;
  const revision = props.version?.tag;
  const currentWorkerKeys = [
    "assets",
    "bundle",
    "compatibility",
    "crons",
    ...(selection.zone === undefined ? [] : ["domain"]),
    "env",
    "isExternal",
    "main",
    "name",
    "version",
    "workersDev",
  ];
  const currentWorkerFirst = ["/api/*", "/v1", "/v1/*", "/healthz", "/readyz"];
  const legacyWorkerFirst = [
    "/api/*",
    "/v1",
    "/v1/*",
    "/v2/threads",
    "/v2/threads/*",
    "/v2/model-catalog",
    "/v2/settings/personal/model-connections",
    "/v2/settings/personal/model-connections/*",
    "/v2/settings/workspaces/*/model-connections",
    "/v2/settings/workspaces/*/model-connections/*",
    "/v2/settings/personal/routing-configuration",
    "/v2/settings/workspaces/*/routing-configuration",
    "/v2/settings/personal/model-migration",
    "/v2/settings/workspaces/*/model-migration",
    "/healthz",
    "/readyz",
  ];
  const expectedCompatibility = {
    date: "2026-08-20",
    flags: ["nodejs_compat", "global_fetch_strictly_public"],
  };
  const compatibilityCurrent =
    JSON.stringify(props.compatibility) ===
    JSON.stringify(expectedCompatibility);
  const compatibilityPersisted =
    compatibilityCurrent ||
    JSON.stringify(props.compatibility) ===
      JSON.stringify({ date: "2026-08-20", flags: ["nodejs_compat"] });
  // Admit only the complete historical model-router Worker shape. Coupling the
  // removed observability, routes, and schedules prevents partial drift from
  // borrowing individual legacy exceptions.
  const legacyRouterWorker =
    !current &&
    (representation === "persisted" || representation === "prior") &&
    exactKeys(props, [...currentWorkerKeys, "observability"]) &&
    JSON.stringify(props.observability) ===
      JSON.stringify({
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
      }) &&
    JSON.stringify(props.compatibility) ===
      JSON.stringify({
        date: "2026-08-20",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      }) &&
    JSON.stringify(props.assets?.runWorkerFirst) ===
      JSON.stringify(legacyWorkerFirst) &&
    JSON.stringify(props.crons) ===
      JSON.stringify(
        selection.environment === "staging"
          ? ["17 3 * * *", "11 * * * *", "*/5 * * * *", "* * * * *"]
          : ["*/5 * * * *", "* * * * *"],
      );
  const observability = props.observability;
  const observabilityValid =
    exactKeys(observability, ["enabled", "logs", "traces"]) &&
    observability.enabled === true &&
    JSON.stringify(observability.logs) ===
      JSON.stringify({ enabled: true, invocationLogs: true }) &&
    exactKeys(observability.traces, [
      "enabled",
      "headSamplingRate",
      "persist",
    ]) &&
    typeof observability.traces.enabled === "boolean" &&
    observability.traces.headSamplingRate === 1 &&
    observability.traces.persist === true;
  const dxdReleaseUrl = props.env?.DX_DXD_RELEASE_URL;
  const dxdChecksum = props.env?.DX_DXD_RELEASE_SHA256;
  const dxdCurrent =
    dxdReleaseUrl === selection.dxdReleaseUrl &&
    dxdChecksum === selection.dxdChecksum;
  const emailBinding = props.env?.EMAIL;
  const emailSender = emailBinding?.allowedSenderAddresses?.[0];
  const emailBindingKeysValid =
    emailBinding !== null &&
    typeof emailBinding === "object" &&
    Object.keys(emailBinding).every((key) =>
      new Set([
        "allowedDestinationAddresses",
        "allowedSenderAddresses",
        "destinationAddress",
        "devRemote",
        "kind",
        "name",
      ]).has(key),
    ) &&
    emailBinding.allowedDestinationAddresses === undefined &&
    emailBinding.destinationAddress === undefined &&
    emailBinding.devRemote === undefined;
  const emailBindingCurrent =
    emailBindingKeysValid &&
    emailBinding.kind === "Cloudflare.Email.SendEmail" &&
    emailBinding.name === "MagicLinkEmail" &&
    JSON.stringify(emailBinding.allowedSenderAddresses) ===
      JSON.stringify([selection.authEmailFrom]) &&
    props.env?.DX_AUTH_EMAIL_FROM === selection.authEmailFrom;
  const emailBindingPersisted =
    emailBindingKeysValid &&
    emailBinding.kind === "Cloudflare.Email.SendEmail" &&
    emailBinding.name === "MagicLinkEmail" &&
    Array.isArray(emailBinding.allowedSenderAddresses) &&
    emailBinding.allowedSenderAddresses.length === 1 &&
    typeof emailSender === "string" &&
    emailSender.length <= 254 &&
    /^[^\s@]+@[^\s@]+$/.test(emailSender) &&
    props.env?.DX_AUTH_EMAIL_FROM === emailSender;
  const environmentNames =
    props.env !== null && typeof props.env === "object"
      ? Object.keys(props.env)
      : [];
  const missingEnvironmentNames = workerBindingNames.filter(
    (name) => !environmentNames.includes(name),
  );
  const extraEnvironmentNames = environmentNames.filter(
    (name) => !workerBindingNames.includes(name),
  );
  const destroyWorkerBindingOmissionsMatch =
    allowDestroyWorkerBindingOmissions &&
    !current &&
    (representation === "desired" || representation === "persisted") &&
    missingEnvironmentNames.length === destroyWorkerBindingOmissions.size &&
    missingEnvironmentNames.every((name) =>
      destroyWorkerBindingOmissions.has(name),
    );
  // Admit the complete pre-workload-identity shape only as historical state.
  // Desired/evaluated props must still contain every current binding.
  const preWorkloadIdentity =
    !current &&
    (representation === "persisted" || representation === "prior") &&
    preWorkloadIdentityBindingOmissions.every((name) =>
      missingEnvironmentNames.includes(name),
    );
  const preAuthenticationEmail =
    !current &&
    (representation === "persisted" || representation === "prior") &&
    preAuthenticationEmailBindingOmissions.every((name) =>
      missingEnvironmentNames.includes(name),
    );
  const preTurnstile =
    !current &&
    (representation === "persisted" || representation === "prior") &&
    preTurnstileBindingOmissions.every((name) =>
      missingEnvironmentNames.includes(name),
    );
  const preBranchPreviewIdentity =
    !current &&
    selection.target === "branch" &&
    (representation === "persisted" || representation === "prior") &&
    preBranchPreviewIdentityBindingOmissions.every((name) =>
      missingEnvironmentNames.includes(name),
    );
  const invalidMissingEnvironmentNames = missingEnvironmentNames.filter(
    (name) =>
      !destroyWorkerBindingOmissionsMatch &&
      !allowedMissingEnvironmentNames.has(name) &&
      !optionalWorkerBindingNames.has(name) &&
      !(
        !current &&
        (representation === "persisted" || representation === "prior") &&
        name === "DX_INTEGRATION_GITHUB_APP"
      ) &&
      !(!current && name === preDeploymentTargetBindingOmission) &&
      !(
        !current &&
        (representation === "persisted" || representation === "prior") &&
        name === preDeploymentTargetBindingOmission
      ) &&
      !(
        !current &&
        (representation === "persisted" || representation === "prior") &&
        name === preSourceShallowCloneBindingOmission
      ) &&
      !(
        !current &&
        (representation === "persisted" || representation === "prior") &&
        name === preRealtimeHubBindingOmission
      ) &&
      !(
        !current &&
        (representation === "persisted" || representation === "prior") &&
        name === preDeploymentTargetBindingOmission
      ) &&
      !(
        preWorkloadIdentity &&
        preWorkloadIdentityBindingOmissions.includes(name)
      ) &&
      !(
        preAuthenticationEmail &&
        preAuthenticationEmailBindingOmissions.includes(name)
      ) &&
      !(preTurnstile && preTurnstileBindingOmissions.includes(name)) &&
      !(
        preBranchPreviewIdentity &&
        preBranchPreviewIdentityBindingOmissions.includes(name)
      ),
  );
  const invalidExtraEnvironmentNames = extraEnvironmentNames.filter(
    (name) =>
      current ||
      (representation !== "persisted" && representation !== "prior") ||
      !retiredWorkerBindings.has(name),
  );
  const environmentIssue = `environment[missing=${missingEnvironmentNames.join("|")};extra=${extraEnvironmentNames.join("|")}]`;
  const dxdPersisted = (() => {
    try {
      const url = new URL(dxdReleaseUrl);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        /^[a-f0-9]{64}$/.test(dxdChecksum ?? "")
      );
    } catch {
      return false;
    }
  })();
  const issues = [
    [
      "keys",
      !exactKeys(props, [...currentWorkerKeys, "observability"]) &&
        // State written before explicit observability has no such key.
        !(!current && exactKeys(props, currentWorkerKeys)) &&
        !legacyRouterWorker,
    ],
    [
      "observability",
      observability === undefined
        ? current
        : !observabilityValid ||
          // The branch-controlled stack must honor the operator's traces choice.
          (current &&
            observability.traces.enabled !== (selection.workerTraces === true)),
    ],
    [
      "name",
      current && representation === "desired" && selection.target === "selfhost"
        ? !dependsOnlyOn(props.name, "Bootstrap")
        : props.name !== selection.workerName,
    ],
    ["external", props.isExternal !== true],
    ["main", props.main !== `${selection.packageDirectory}/worker/index.js`],
    ["bundle", props.bundle !== false],
    [
      "compatibility",
      current
        ? !compatibilityCurrent
        : !compatibilityPersisted && !legacyRouterWorker,
    ],
    ["version-keys", !exactKeys(props.version, ["message", "tag"])],
    [
      "revision",
      typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision),
    ],
    [
      "version-message",
      props.version?.message !== `Git ${revision?.slice(0, 12)}`,
    ],
    ["current-revision", current && revision !== selection.revision],
    [
      "asset-keys",
      !exactKeys(props.assets, [
        "directory",
        "notFoundHandling",
        "runWorkerFirst",
      ]),
    ],
    [
      "asset-directory",
      props.assets?.directory !== `${selection.packageDirectory}/assets`,
    ],
    [
      "asset-not-found",
      props.assets?.notFoundHandling !== "single-page-application",
    ],
    [
      "asset-worker-first",
      JSON.stringify(props.assets?.runWorkerFirst) !==
        JSON.stringify(currentWorkerFirst) && !legacyRouterWorker,
    ],
    [
      environmentIssue,
      invalidMissingEnvironmentNames.length > 0 ||
        invalidExtraEnvironmentNames.length > 0,
    ],
    [
      "authentication-email",
      selection.target === "selfhost"
        ? props.env?.DX_AUTH_EMAIL_FROM !== undefined ||
          props.env?.EMAIL !== undefined ||
          props.env?.DX_TURNSTILE_SECRET_KEY !== undefined ||
          props.env?.DX_TURNSTILE_SITE_KEY !== undefined
        : destroyWorkerBindingOmissionsMatch || preAuthenticationEmail
          ? false
          : current
            ? !emailBindingCurrent
            : !emailBindingPersisted,
    ],
    [
      "authentication-turnstile",
      selection.target === "selfhost"
        ? false
        : destroyWorkerBindingOmissionsMatch || preTurnstile
          ? false
          : props.env?.DX_TURNSTILE_SECRET_KEY === undefined ||
            props.env?.DX_TURNSTILE_SITE_KEY === undefined,
    ],
    ["dxd", current ? !dxdCurrent : !dxdPersisted],
    [
      "crons",
      JSON.stringify(props.crons) !==
        JSON.stringify(
          selection.environment === "staging" ? ["17 3 * * *"] : [],
        ) && !legacyRouterWorker,
    ],
    ["workers-dev", props.workersDev !== (selection.zone === undefined)],
    [
      "domain-keys",
      selection.zone !== undefined && !exactKeys(domain, ["name", "zoneName"]),
    ],
    [
      "domain-name",
      selection.zone !== undefined && domain?.name !== selection.domain,
    ],
    [
      "domain-zone",
      selection.zone !== undefined && domain?.zoneName !== selection.zone,
    ],
  ].flatMap(([issue, invalid]) => (invalid ? [issue] : []));
  if (issues.length > 0)
    throw new Error(
      `Worker ${representation} plan identity is outside the exact allowlist (${issues.join(", ")}).`,
    );
};

// workers.dev previews cap script names at 54 characters.
export const daemonIngressWorkerName = (stage) =>
  resourceName("dxd", stage, 54);

// The dxd ingress Worker: dependency-free source, one cross-script binding to
// the Core Worker's Thread execution namespace, served on workers.dev only.
// Nothing else may change.
const validateDaemonIngressProps = (props, selection, representation) => {
  const binding = props?.env?.THREAD_EXECUTION;
  const scriptName = binding?.scriptName;
  const issues = [
    exactKeys(props, [
      "compatibility",
      "env",
      "isExternal",
      "main",
      "name",
      "observability",
      "workersDev",
    ]) && props.isExternal === true
      ? undefined
      : `keys[${Object.keys(props ?? {})
          .sort()
          .join("|")}]`,
    props?.name === daemonIngressWorkerName(selection.stage)
      ? undefined
      : "name",
    props?.main === "apps/core/src/threads/daemon-ingress.ts"
      ? undefined
      : "main",
    JSON.stringify(props?.compatibility) ===
    JSON.stringify({ date: "2026-08-20" })
      ? undefined
      : "compatibility",
    props?.workersDev === true ? undefined : "workersDev",
    JSON.stringify(props?.observability) ===
    JSON.stringify({
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    })
      ? undefined
      : "observability",
    exactKeys(props?.env, ["THREAD_EXECUTION"]) &&
    binding?.className === "ThreadExecutionObject" &&
    (scriptName === selection.workerName ||
      // On a new stage the Worker is created in the same plan, so even the
      // evaluated binding still references it.
      (["desired", "evaluated"].includes(representation) &&
        dependsExactlyOn(scriptName, "Worker", "workerName")))
      ? undefined
      : `env[${Object.keys(binding ?? {})
          .sort()
          .join("|")}]`,
  ].filter((issue) => issue !== undefined);
  if (issues.length > 0)
    throw new Error(
      `DaemonIngress ${representation} plan identity is outside the exact allowlist (${issues.join(", ")}).`,
    );
};

const assertExactDaemonIngressIdentity = (node, operation, selection) => {
  if (operation === "deploy") {
    validateDaemonIngressProps(node.resource?.Props, selection, "desired");
    if (node.props !== undefined)
      validateDaemonIngressProps(node.props, selection, "evaluated");
  }
  if (node.state?.props !== undefined)
    validateDaemonIngressProps(node.state.props, selection, "persisted");
  if (node.state?.old?.props !== undefined)
    validateDaemonIngressProps(node.state.old.props, selection, "prior");
};

const assertInterruptedWorkerAttr = (attr, selection) => {
  const durableObjectNamespaces = attr?.durableObjectNamespaces;
  const expectedDurableObjectClasses = workerDurableObjectBindings
    .map(([, className]) => className)
    .sort();
  const durableObjectClasses = Object.keys(
    durableObjectNamespaces ?? {},
  ).sort();
  const expectedTags = [
    "alchemy:stack:dx-cloudflare",
    `alchemy:stage:${selection.stage}`,
    "alchemy:id:Worker",
    `alchemy:dos:${workerDurableObjectBindings
      .map(([name, className]) => `${name}=${className}`)
      .join(";")}`,
  ];
  if (
    !exactKeys(attr, [
      "accountId",
      "crons",
      "durableObjectNamespaces",
      "routes",
      "tags",
      "urls",
      "workerId",
      "workerName",
    ]) ||
    attr.accountId !== selection.accountId ||
    attr.workerName !== selection.workerName ||
    !/^[a-f0-9]{32}$/.test(attr.workerId ?? "") ||
    JSON.stringify(attr.crons) !== "[]" ||
    JSON.stringify(attr.routes) !== "[]" ||
    !(
      JSON.stringify(attr.urls) === "[]" ||
      (selection.target === "selfhost" &&
        JSON.stringify(attr.urls) ===
          JSON.stringify([`https://${selection.domain}`]))
    ) ||
    JSON.stringify(attr.tags) !== JSON.stringify(expectedTags) ||
    JSON.stringify(durableObjectClasses) !==
      JSON.stringify(expectedDurableObjectClasses) ||
    durableObjectClasses.some(
      (className) =>
        !/^[a-f0-9]{32}$/.test(durableObjectNamespaces[className] ?? ""),
    )
  )
    throw new Error(
      "Interrupted Worker identity is outside the exact allowlist.",
    );
};

const assertExactWorkerIdentity = (node, operation, selection) => {
  const interruptedCreate = node.state?.status === "creating";
  if (
    interruptedCreate &&
    (node.state.old !== undefined ||
      node.state.attr === undefined ||
      !(
        (operation === "deploy" && node.action === "create") ||
        (operation === "destroy" && node.action === "delete")
      ))
  )
    throw new Error(
      "Interrupted Worker plan identity is outside the exact allowlist.",
    );
  if (operation === "deploy") {
    validateWorkerProps(node.resource?.Props, selection, true, "desired");
    if (node.props !== undefined)
      validateWorkerProps(node.props, selection, true, "evaluated");
  } else {
    const resourceProps = node.resource?.Props;
    // Plan.destroy partially resolves an interrupted Worker create's desired
    // environment even though its persisted state records the bindings that
    // reached Cloudflare. Validate that persisted environment instead, while
    // retaining every desired non-environment identity check.
    const destroyProps =
      interruptedCreate &&
      node.state?.props?.env !== null &&
      typeof node.state?.props?.env === "object"
        ? { ...resourceProps, env: node.state.props.env }
        : resourceProps;
    validateWorkerProps(
      destroyProps,
      selection,
      false,
      interruptedCreate ? "persisted" : "desired",
      interruptedCreate ? interruptedWorkerBindingOmissions : new Set(),
      true,
    );
  }
  if (node.state?.props !== undefined)
    validateWorkerProps(
      node.state.props,
      selection,
      false,
      "persisted",
      interruptedCreate ? interruptedWorkerBindingOmissions : new Set(),
      operation === "destroy",
    );
  if (node.state?.old?.props !== undefined)
    validateWorkerProps(node.state.old.props, selection, false, "prior");
  if (interruptedCreate) {
    assertInterruptedWorkerAttr(node.state.attr, selection);
    return;
  }
  const attr = node.state?.attr ?? node.state?.old?.attr;
  if (node.state && node.action !== "create" && !attr)
    throw new Error("Persisted Worker identity is incomplete.");
  const persistedDomain = attr?.domain;
  if (
    attr &&
    (attr.accountId !== selection.accountId ||
      attr.workerName !== selection.workerName ||
      attr.url !== `https://${selection.domain}` ||
      attr.namespace !== undefined ||
      attr.versionOf !== undefined ||
      !Array.isArray(attr.routes) ||
      attr.routes.length !== 0 ||
      (attr.affinityZoneIds !== undefined &&
        (!Array.isArray(attr.affinityZoneIds) ||
          attr.affinityZoneIds.length !== 0)) ||
      (selection.zone !== undefined &&
        (typeof persistedDomain !== "object" ||
          persistedDomain?.name !== selection.domain ||
          persistedDomain?.zone !== selection.zone ||
          !Array.isArray(persistedDomain?.aliases) ||
          persistedDomain.aliases.length !== 0 ||
          !Array.isArray(persistedDomain?.redirects) ||
          persistedDomain.redirects.length !== 0)))
  )
    throw new Error(
      "Persisted Worker identity is outside the exact allowlist.",
    );
};

const assertExactRandomIdentity = (node, operation, id) => {
  const props =
    operation === "deploy"
      ? [
          node.resource?.Props,
          node.props,
          node.state?.props,
          node.state?.old?.props,
        ]
      : [node.resource?.Props, node.state?.props, node.state?.old?.props];
  if (
    props
      .filter((value) => value !== undefined)
      .some((value) => !exactKeys(value, []))
  )
    throw new Error(`${id} plan is outside the exact allowlist.`);
};

const assertExactHeldSecretIdentity = (node, operation, id) => {
  const props =
    operation === "deploy"
      ? [
          node.resource?.Props,
          node.props,
          node.state?.props,
          node.state?.old?.props,
        ]
      : [node.resource?.Props, node.state?.props, node.state?.old?.props];
  if (
    props
      .filter((value) => value !== undefined)
      .some(
        (value) =>
          !Object.keys(value).every((key) => key === "value") ||
          (Object.hasOwn(value, "value") && value.value === undefined),
      )
  )
    throw new Error(`${id} held-secret plan is outside the exact allowlist.`);
};

const assertExactE2BProfilesIdentity = (node, operation) => {
  const props =
    operation === "deploy"
      ? [
          node.resource?.Props,
          node.props,
          node.state?.props,
          node.state?.old?.props,
        ]
      : [node.resource?.Props, node.state?.props, node.state?.old?.props];
  for (const value of props.filter((candidate) => candidate !== undefined)) {
    if (
      !exactKeys(value, ["apiKey", "deploymentName", "recipeHash"]) ||
      (value.deploymentName !== undefined &&
        !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(value.deploymentName)) ||
      (value.recipeHash !== undefined &&
        !/^[a-f0-9]{64}$/.test(value.recipeHash))
    )
      throw new Error("E2B profile plan is outside the exact allowlist.");
  }
};

const assertExactStorageIdentity = (node, selection, kind) => {
  const expectedName =
    kind === "Database" ? selection.databaseName : selection.bucketName;
  for (const props of [
    node.resource?.Props,
    node.props,
    node.state?.props,
    node.state?.old?.props,
  ].filter(Boolean)) {
    if (
      props.name !== expectedName ||
      (kind === "Storage" &&
        (!exactKeys(props, ["forceDestroy", "name"]) ||
          props.forceDestroy !== false)) ||
      (kind === "Database" &&
        (!exactKeys(props, ["migrations", "name"]) ||
          props.migrations !== `apps/core/${migrationDirectory}`))
    )
      throw new Error(`${kind} plan identity is outside the exact allowlist.`);
  }
  const attr = node.state?.attr ?? node.state?.old?.attr;
  if (node.state && node.action !== "create" && !attr)
    throw new Error(`Persisted ${kind} identity is incomplete.`);
  const actualName =
    kind === "Database" ? attr?.databaseName : attr?.bucketName;
  if (
    attr &&
    (actualName !== expectedName ||
      attr.accountId !== selection.accountId ||
      (kind === "Database" &&
        (!selection.databaseId ||
          !attr.databaseId ||
          attr.databaseId !== selection.databaseId)))
  )
    throw new Error(
      `Persisted ${kind} identity is outside the exact allowlist.`,
    );
};

const assertExactTurnstileIdentity = (node, selection) => {
  const expectedProps = {
    domains: [selection.domain],
    mode: "managed",
    name: `dx access · ${selection.domain}`,
  };
  for (const props of [
    node.resource?.Props,
    node.props,
    node.state?.props,
    node.state?.old?.props,
  ].filter(Boolean)) {
    if (
      !exactKeys(props, ["domains", "mode", "name"]) ||
      JSON.stringify(props.domains) !== JSON.stringify(expectedProps.domains) ||
      props.mode !== expectedProps.mode ||
      props.name !== expectedProps.name
    )
      throw new Error(
        "AccessTurnstile plan identity is outside the exact allowlist.",
      );
  }
  const attr = node.state?.attr ?? node.state?.old?.attr;
  // A failed create (for example at the account widget cap) leaves state
  // without attributes; destroying that never-created widget is safe.
  if (
    node.state &&
    node.action !== "create" &&
    node.action !== "delete" &&
    !attr
  )
    throw new Error("Persisted AccessTurnstile identity is incomplete.");
  if (
    attr &&
    (!exactKeys(attr, [
      "accountId",
      "botFightMode",
      "clearanceLevel",
      "createdOn",
      "domains",
      "ephemeralId",
      "mode",
      "modifiedOn",
      "name",
      "offlabel",
      "region",
      "secret",
      "sitekey",
    ]) ||
      attr.accountId !== selection.accountId ||
      attr.name !== expectedProps.name ||
      JSON.stringify(attr.domains) !== JSON.stringify(expectedProps.domains) ||
      attr.mode !== expectedProps.mode ||
      attr.region !== "world" ||
      typeof attr.sitekey !== "string" ||
      attr.sitekey.length === 0 ||
      attr.secret === undefined)
  )
    throw new Error(
      "Persisted AccessTurnstile identity is outside the exact allowlist.",
    );
};

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());

const assertCompletePropRepresentations = (node, operation, id) => {
  const requiresEvaluated =
    operation === "deploy" &&
    (node.action === "create" || node.action === "update");
  if (
    node.resource?.Props === undefined ||
    (requiresEvaluated && node.props === undefined) ||
    (!requiresEvaluated && node.props !== undefined) ||
    (node.state !== undefined && node.state.props === undefined) ||
    (node.state?.old !== undefined && node.state.old?.props === undefined)
  )
    throw new Error(`${id} Plan prop representations are incomplete.`);
};

const dependsExactlyOn = (value, id, property) =>
  Output.isPropExpr(value) &&
  value.identifier === property &&
  JSON.stringify(Object.keys(Output.upstreamAny(value)).sort()) ===
    JSON.stringify([id]);

const deploymentLabel = (selection, revision) =>
  selection.target === "staging"
    ? `Staging · ${revision.slice(0, 12)}`
    : selection.target === "selfhost"
      ? `Self-host · ${selection.stage.slice("selfhost-".length)} · ${revision.slice(0, 12)}`
      : `Branch preview · ${selection.branch} · ${revision.slice(0, 12)}`;

const dependsOnlyOn = (value, id) =>
  Output.isExpr(value) &&
  JSON.stringify(Object.keys(Output.upstreamAny(value)).sort()) ===
    JSON.stringify([id]);

const assertCommandEnvelope = (props, id) => {
  if (
    !exactKeys(props, ["command", "cwd", "env", "memo", "timeout"]) ||
    props.cwd !== "." ||
    props.memo !== false ||
    props.timeout !== "3 minutes"
  )
    throw new Error(`${id} command plan is outside the exact allowlist.`);
};

const assertBootstrapCommand = (props, role, selection, context) => {
  assertCommandEnvelope(props, "Bootstrap");
  const databaseId = props.env?.DX_BOOTSTRAP_DATABASE_ID;
  const credentialsFile = props.env?.DX_BOOTSTRAP_CREDENTIALS_FILE;
  const repository = props.env?.DX_BOOTSTRAP_REPOSITORY;
  const runnerProfileId = props.env?.DX_BOOTSTRAP_RUNNER_PROFILE_ID;
  const expectedCredentialsFile = `.dx/alchemy/${selection.stage}/credentials.json`;
  const creating = role === "creating";
  if (selection.target === "selfhost") {
    const password = props.env?.DX_BOOTSTRAP_ADMIN_PASSWORD;
    if (
      props.command !== "node scripts/bootstrap-deployment.mjs" ||
      !exactKeys(props.env, [
        "DX_BOOTSTRAP_ADMIN_EMAIL",
        "DX_BOOTSTRAP_ADMIN_PASSWORD",
        "DX_BOOTSTRAP_ADMIN_PASSWORD_RESET",
        ...(creating ? [] : ["DX_BOOTSTRAP_DATABASE_ID"]),
        "DX_BOOTSTRAP_RUNNER_PROFILE_ID",
        "DX_BOOTSTRAP_STAGE",
      ]) ||
      props.env.DX_BOOTSTRAP_ADMIN_EMAIL !== selection.adminEmail ||
      (props.env.DX_BOOTSTRAP_ADMIN_PASSWORD_RESET !== "false" &&
        props.env.DX_BOOTSTRAP_ADMIN_PASSWORD_RESET !== "true") ||
      props.env.DX_BOOTSTRAP_RUNNER_PROFILE_ID !== "a1.medium" ||
      props.env.DX_BOOTSTRAP_STAGE !== selection.stage ||
      (role === "desired" && !dependsOnlyOn(password, "AdminPassword")) ||
      (!creating &&
        (role === "desired"
          ? !dependsExactlyOn(databaseId, "Database", "databaseId")
          : role === "evaluated"
            ? !(
                context.databaseIds.has(databaseId) ||
                dependsExactlyOn(databaseId, "Database", "databaseId")
              )
            : !context.databaseIds.has(databaseId)))
    )
      throw new Error("Bootstrap command plan is outside the exact allowlist.");
    return;
  }
  const bootstrapEnvKeys = creating
    ? ["DX_BOOTSTRAP_CREDENTIALS_FILE", "DX_BOOTSTRAP_REPOSITORY"]
    : [
        "DX_BOOTSTRAP_CREDENTIALS_FILE",
        "DX_BOOTSTRAP_DATABASE_ID",
        "DX_BOOTSTRAP_REPOSITORY",
      ];
  const hasAcceptedBootstrapEnvironment =
    exactKeys(props.env, bootstrapEnvKeys) ||
    (runnerProfileId === "a1.medium" &&
      exactKeys(props.env, [
        ...bootstrapEnvKeys,
        "DX_BOOTSTRAP_RUNNER_PROFILE_ID",
      ]));
  if (
    props.command !== "node scripts/bootstrap-deployment.mjs" ||
    !hasAcceptedBootstrapEnvironment ||
    repository !== JSON.stringify(hostedPolicy().bootstrapRepository) ||
    !(
      credentialsFile === expectedCredentialsFile ||
      (role === "persisted" &&
        typeof credentialsFile === "string" &&
        isAbsolute(credentialsFile) &&
        normalize(credentialsFile) === credentialsFile &&
        credentialsFile.endsWith(`/${expectedCredentialsFile}`))
    ) ||
    (!creating &&
      (role === "desired"
        ? !dependsExactlyOn(databaseId, "Database", "databaseId")
        : role === "evaluated"
          ? !(
              context.databaseIds.has(databaseId) ||
              dependsExactlyOn(databaseId, "Database", "databaseId")
            )
          : !context.databaseIds.has(databaseId)))
  )
    throw new Error("Bootstrap command plan is outside the exact allowlist.");
};

const validPersistedVerifyIdentity = (props, selection) => {
  const revision = props.env?.DX_PREVIEW_REVISION;
  return (
    typeof revision === "string" &&
    /^[a-f0-9]{40}$/.test(revision) &&
    props.env.DX_PREVIEW_DEPLOYMENT_LABEL ===
      deploymentLabel(selection, revision) &&
    props.env.DX_PREVIEW_STAGE === selection.stage &&
    props.env.DX_PREVIEW_PROOF_FILE ===
      `.dx/alchemy/${selection.stage}/proof.json` &&
    typeof props.env.DX_PREVIEW_E2B_TEMPLATE_BUILD_ID === "string" &&
    props.env.DX_PREVIEW_E2B_TEMPLATE_BUILD_ID.length > 0 &&
    props.env.DX_PREVIEW_E2B_TEMPLATE_BUILD_ID.length <= 256 &&
    /^[a-f0-9]{64}$/.test(props.env.DX_PREVIEW_DXD_CHECKSUM ?? "")
  );
};

const validPersistedVerifyLabel = (label, selection) => {
  if (typeof label !== "string") return false;
  if (selection.target === "staging")
    return /^Staging · [a-f0-9]{12}$/.test(label);
  if (selection.target === "selfhost")
    return /^Self-host · [a-z0-9-]+ · [a-f0-9]{12}$/.test(label);
  const prefix = `Branch preview · ${selection.branch} · `;
  return (
    label.length === prefix.length + 12 &&
    label.startsWith(prefix) &&
    /^[a-f0-9]{12}$/.test(label.slice(-12))
  );
};

const assertVerifyCommand = (props, role, selection, context) => {
  assertCommandEnvelope(props, "Verify");
  const workerId = props.env?.DX_PREVIEW_WORKER_ID;
  const bootstrapReady = props.env?.DX_PREVIEW_BOOTSTRAP;
  const creating = role === "creating";
  const legacy = props.env?.DX_PREVIEW_PROOF_FILE !== undefined;
  const packagedDxd = props.env?.DX_PREVIEW_DXD_SHA256;
  const expectsCurrentPackagedDxd =
    selection.target !== "staging" &&
    (role === "desired" || role === "evaluated");
  const invalidPackagedDxd = expectsCurrentPackagedDxd
    ? packagedDxd !== selection.dxdChecksum
    : selection.target !== "staging" && role === "creating"
      ? !/^[a-f0-9]{64}$/.test(packagedDxd ?? "")
      : packagedDxd !== undefined && !/^[a-f0-9]{64}$/.test(packagedDxd);
  if (
    props.command !== "node scripts/verify-alchemy-preview.mjs" ||
    !exactKeys(props.env, [
      ...(creating ? [] : ["DX_PREVIEW_BOOTSTRAP"]),
      "DX_PREVIEW_DEPLOYMENT_LABEL",
      ...(packagedDxd === undefined ? [] : ["DX_PREVIEW_DXD_SHA256"]),
      ...(legacy
        ? [
            "DX_PREVIEW_DXD_CHECKSUM",
            "DX_PREVIEW_E2B_TEMPLATE_BUILD_ID",
            "DX_PREVIEW_PROOF_FILE",
            "DX_PREVIEW_REVISION",
            "DX_PREVIEW_STAGE",
          ]
        : []),
      "DX_PREVIEW_URL",
      ...(creating ? [] : ["DX_PREVIEW_WORKER_ID"]),
    ]) ||
    props.env.DX_PREVIEW_URL !== selection.origin ||
    invalidPackagedDxd ||
    (role === "desired" &&
      (!dependsExactlyOn(workerId, "Worker", "workerId") ||
        !dependsOnlyOn(bootstrapReady, "Bootstrap"))) ||
    (role === "evaluated" &&
      (!(
        context.workerIds.has(workerId) ||
        dependsExactlyOn(workerId, "Worker", "workerId")
      ) ||
        !(
          (bootstrapReady === "ready" && context.commandIds.has("Bootstrap")) ||
          dependsOnlyOn(bootstrapReady, "Bootstrap")
        ))) ||
    (role === "persisted" &&
      (!context.workerIds.has(workerId) ||
        bootstrapReady !== "ready" ||
        !context.commandIds.has("Bootstrap"))) ||
    (role === "persisted" || creating
      ? legacy
        ? !validPersistedVerifyIdentity(props, selection)
        : !validPersistedVerifyLabel(
            props.env.DX_PREVIEW_DEPLOYMENT_LABEL,
            selection,
          )
      : props.env.DX_PREVIEW_DEPLOYMENT_LABEL !== selection.deploymentLabel)
  )
    throw new Error("Verify command plan is outside the exact allowlist.");
};

const assertExactCommandIdentity = (
  node,
  operation,
  selection,
  id,
  context,
) => {
  const validate =
    id === "Bootstrap" ? assertBootstrapCommand : assertVerifyCommand;
  const desired = node.resource?.Props;
  const evaluated = node.props;
  const interruptedCreate = node.state?.status === "creating";
  if (
    interruptedCreate &&
    (node.state.old !== undefined ||
      node.state.attr !== undefined ||
      !(
        (operation === "deploy" && node.action === "create") ||
        (operation === "destroy" && node.action === "delete")
      ))
  )
    throw new Error(`${id} command plan is outside the exact allowlist.`);
  if (desired === undefined)
    throw new Error(`${id} command plan is outside the exact allowlist.`);
  if (operation === "deploy") {
    validate(desired, "desired", selection, context);
    if (node.action === "noop") {
      if (evaluated !== undefined)
        throw new Error(`${id} command plan is outside the exact allowlist.`);
    } else {
      if (evaluated === undefined)
        throw new Error(`${id} command plan is outside the exact allowlist.`);
      validate(evaluated, "evaluated", selection, context);
    }
  } else {
    if (evaluated !== undefined)
      throw new Error(`${id} command plan is outside the exact allowlist.`);
    validate(
      desired,
      interruptedCreate ? "creating" : "persisted",
      selection,
      context,
    );
  }
  if (node.state?.props !== undefined)
    validate(
      node.state.props,
      interruptedCreate ? "creating" : "persisted",
      selection,
      context,
    );
  if (node.state?.old?.props !== undefined)
    validate(node.state.old.props, "persisted", selection, context);
};

const assertRetiredRandomDeletion = (fqn, node) => {
  const id = node.resource?.LogicalId ?? node.state?.logicalId;
  const state = node.state;
  if (
    !retiredRandomResourceIds.has(fqn) ||
    id !== fqn ||
    node.resource?.FQN !== fqn ||
    node.resource?.Type !== "Alchemy.Random" ||
    node.action !== "delete" ||
    node.mode !== undefined ||
    node.bindings.length !== 0 ||
    !exactKeys(node.resource.Props, []) ||
    node.props !== undefined ||
    state?.fqn !== fqn ||
    state.logicalId !== fqn ||
    state.resourceType !== "Alchemy.Random" ||
    state.status !== "created" ||
    state.old !== undefined ||
    !exactKeys(state.props, []) ||
    !exactKeys(state.attr, ["text"]) ||
    state.attr.text === undefined
  )
    throw new Error("Alchemy plan selected an unapproved retired resource.");
};

const isRetiredWorkerBindingDeletion = (binding) => {
  const expectedType = retiredWorkerBindings.get(binding.sid);
  const bindings = binding.data?.bindings;
  return (
    binding.action === "delete" &&
    expectedType !== undefined &&
    Array.isArray(bindings) &&
    bindings.length === 1 &&
    bindings[0]?.name === binding.sid &&
    bindings[0]?.type === expectedType
  );
};

const assertRetiredWorkerBindingCoverage = (node) => {
  const historicalNames = new Set(
    [node.state?.props, node.state?.old?.props]
      .flatMap((props) => Object.keys(props?.env ?? {}))
      .filter((name) => retiredWorkerBindings.has(name)),
  );
  const deletedNames = node.bindings
    .filter(
      (binding) =>
        binding.action === "delete" && retiredWorkerBindings.has(binding.sid),
    )
    .map(({ sid }) => sid);
  if (
    new Set(deletedNames).size !== deletedNames.length ||
    JSON.stringify([...historicalNames].sort()) !==
      JSON.stringify([...deletedNames].sort())
  )
    throw new Error(
      "Retired Worker binding deletions do not match historical state.",
    );
};

const validateResourceNode = (fqn, node, operation, selection, context) => {
  if (retiredRandomResourceIds.has(fqn)) {
    assertRetiredRandomDeletion(fqn, node);
    return;
  }
  const id = node.resource?.LogicalId ?? node.state?.logicalId;
  const type = node.resource?.Type ?? node.state?.resourceType;
  const nodeFqn = node.resource?.FQN ?? node.state?.fqn;
  if (
    !id ||
    fqn !== id ||
    nodeFqn !== id ||
    deploymentResourceTypes(
      selection.target,
      selection.integrations,
      selection.turnstileTestKeys,
      selection.workersDevSubdomain,
    ).get(id) !== type
  )
    throw new Error(`Alchemy plan selected an unapproved resource: ${id}.`);
  if (cloudflareResourceIds.has(id) && node.mode !== "live")
    throw new Error(`Alchemy plan selected a non-live provider for ${id}.`);
  if (id === "AccessTurnstile" && node.mode !== undefined)
    throw new Error(
      "Alchemy plan selected an unexpected Turnstile provider mode.",
    );

  const allowedActions =
    operation === "deploy"
      ? new Set(["create", "update", "noop"])
      : new Set(["delete", "noop"]);
  if (!allowedActions.has(node.action))
    throw new Error(`${operation} rejects ${node.action} for ${id}.`);
  if (
    node.bindings.some(
      (binding) =>
        !allowedActions.has(binding.action) &&
        !(
          operation === "deploy" &&
          id === "Worker" &&
          isRetiredWorkerBindingDeletion(binding)
        ),
    )
  )
    throw new Error(`${operation} rejects a binding action for ${id}.`);
  assertCompletePropRepresentations(node, operation, id);

  if (id === "Worker") assertExactWorkerIdentity(node, operation, selection);
  if (id === "DaemonIngress")
    assertExactDaemonIngressIdentity(node, operation, selection);
  if (
    id === "BetterAuthSecret" ||
    id === "ConfigEncryptionKey" ||
    id === "WorkloadIdentitySigningKey"
  )
    assertExactRandomIdentity(node, operation, id);
  if (
    id === "AdminPassword" ||
    id === "BitbucketOAuthSecret" ||
    id === "E2BApiKey" ||
    id === "GitHubAppSecret" ||
    id === "SarvamApiKey"
  )
    assertExactHeldSecretIdentity(node, operation, id);
  if (id === "E2BProfiles") assertExactE2BProfilesIdentity(node, operation);
  if (id === "Database" || id === "Storage")
    assertExactStorageIdentity(node, selection, id);
  if (id === "AccessTurnstile") assertExactTurnstileIdentity(node, selection);
  if (id === "Bootstrap" || id === "Verify")
    assertExactCommandIdentity(node, operation, selection, id, context);
};

export const validateAlchemyPlan = (plan, operation, selection) => {
  if (!new Set(["deploy", "destroy"]).has(operation))
    throw new Error("Unknown Alchemy operation; no write is safe.");
  const deployResourceIds = Object.keys(plan.resources).sort();
  const expectedDeployResourceIds = [
    ...deploymentResourceTypes(
      selection.target,
      selection.integrations,
      selection.turnstileTestKeys,
      selection.workersDevSubdomain,
    ).keys(),
  ].sort();
  const deletionIds = Object.keys(plan.deletions);
  const onlyRetiredRandomDeletions = deletionIds.every((id) =>
    retiredRandomResourceIds.has(id),
  );
  if (
    plan.defaultMode !== "live" ||
    Boolean(plan.destroy) !== (operation === "destroy") ||
    Object.keys(plan.actions).length !== 0 ||
    Object.keys(plan.actionDeletions).length !== 0 ||
    (operation === "deploy" && !onlyRetiredRandomDeletions) ||
    (operation === "deploy" &&
      JSON.stringify(deployResourceIds) !==
        JSON.stringify(expectedDeployResourceIds)) ||
    (operation === "destroy" && Object.keys(plan.resources).length !== 0)
  )
    throw new Error("Alchemy plan shape or provider mode is not approved.");

  const nodes = [
    ...Object.entries(plan.resources),
    ...Object.entries(plan.deletions),
  ];
  const databaseNode =
    operation === "deploy" ? plan.resources.Database : plan.deletions.Database;
  const workerNode =
    operation === "deploy" ? plan.resources.Worker : plan.deletions.Worker;
  if (operation === "deploy") assertRetiredWorkerBindingCoverage(workerNode);
  const context = {
    databaseIds: new Set(
      [
        ...(operation === "deploy" ? [selection.databaseId] : []),
        databaseNode?.state?.attr?.databaseId,
        databaseNode?.state?.old?.attr?.databaseId,
      ].filter(Boolean),
    ),
    workerIds: new Set(
      [
        workerNode?.state?.attr?.workerId,
        workerNode?.state?.old?.attr?.workerId,
      ].filter(Boolean),
    ),
    commandIds: new Set(
      Object.keys(
        operation === "deploy" ? plan.resources : plan.deletions,
      ).filter((id) => id === "Bootstrap" || id === "Verify"),
    ),
  };
  for (const [fqn, node] of nodes)
    validateResourceNode(fqn, node, operation, selection, context);
  return plan;
};

export const applyValidatedAlchemyPlan = ({
  apply,
  operation,
  plan,
  selection,
}) => {
  validateAlchemyPlan(plan, operation, selection);
  return apply(plan);
};

export const prepareDeploymentPackage = ({ buildPackage, operation }) => {
  if (operation === "deploy") buildPackage();
};

export const securePrivateDeploymentState = (privateRoot) => {
  const directory = resolve(privateRoot);
  const parent = resolve(directory, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  chmodSync(directory, 0o700);
};

export const isolatedDeploymentBuildEnvironment = (inherited) =>
  Object.fromEntries(
    Object.entries(inherited).filter(([name]) => {
      return deploymentBuildEnvironmentNames.has(name);
    }),
  );

export const assertPostApplyVerification = ({ error, status }) => {
  if (error || status !== 0)
    throw new Error(
      "Deployment verification failed after provider writes; the stage outcome may be uncertain. Inspect the recorded stage before any retry or cleanup.",
      error ? { cause: error } : undefined,
    );
};

export const isolatedAlchemyEnvironment = (inherited, deployment) => ({
  ...Object.fromEntries(
    Object.entries(inherited).filter(
      ([name]) =>
        !name.startsWith("ALCHEMY_") &&
        !name.startsWith("DX_GITHUB_STAGING_") &&
        !new Set([
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_API_KEY",
          "CLOUDFLARE_API_TOKEN",
          "CLOUDFLARE_EMAIL",
          "DX_ADMIN_PASSWORD",
          "DX_ADMIN_PASSWORD_RESET",
          "DX_INTEGRATION_GITHUB_APP",
          "DX_INTEGRATION_BITBUCKET_OAUTH",
          "DX_DEPLOYMENT_REVIEWER_EMAIL",
          "DX_DEPLOYMENT_REVIEWER_PASSWORD",
          "DX_STAGING_TEST_PASSWORD",
          "DX_STAGING_TEST_USERNAME",
          "E2B_API_KEY",
          "HOME",
          "SARVAM_API_KEY",
          "USERPROFILE",
          "XDG_CONFIG_HOME",
        ]).has(name),
    ),
  ),
  ALCHEMY_PROFILE: deployment.profile ?? "dx-deployment",
  ALCHEMY_TELEMETRY_DISABLED: "1",
  CLOUDFLARE_ACCOUNT_ID: deployment.accountId,
  ...(deployment.apiToken === undefined
    ? {}
    : { CLOUDFLARE_API_TOKEN: deployment.apiToken }),
  HOME: deployment.authHome,
  USERPROFILE: deployment.authHome,
  XDG_CONFIG_HOME: `${deployment.authHome}/.config`,
});

export const writeDeploymentAlchemyProfile = (authHome) => {
  const alchemyDirectory = resolve(authHome, ".alchemy");
  mkdirSync(alchemyDirectory, { recursive: true, mode: 0o700 });
  chmodSync(authHome, 0o700);
  chmodSync(alchemyDirectory, 0o700);
  const profilePath = resolve(alchemyDirectory, "profiles.json");
  writeFileSync(
    profilePath,
    `${JSON.stringify({
      version: 0,
      profiles: { "dx-deployment": { Cloudflare: { method: "env" } } },
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(profilePath, 0o600);
};
