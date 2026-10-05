import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ApiClient, ConnectionConfig, Template } from "e2b";
import { dxOrbTemplate } from "../deploy/e2b/template.mjs";
import { assertDockerAvailable } from "../deploy/orb/containers.mjs";
import {
  adminCredentialPath,
  writeAdminCredentialFile,
} from "../deploy/selfhost/admin-credentials.mjs";
import { loadAlchemyCloudflareAuth } from "../deploy/selfhost/cloudflare-auth.mjs";
import {
  downloadDxdRelease,
  loadDxdRelease,
  verifyDxdBytes,
} from "../deploy/selfhost/dxd-release.mjs";
import e2bOrbProfiles from "../packages/domain/e2b-orb-profiles.json" with {
  type: "json",
};
import {
  assertCleanRevision,
  assertDeploymentAccount,
  assertDxdChecksum,
  assertPostApplyVerification,
  configureHostedDeploymentPolicy,
  daemonIngressWorkerName,
  deploymentBitbucketOAuth,
  deploymentGitHubApp,
  deploymentGitStatusArguments,
  deploymentSelection,
  isolatedAlchemyEnvironment,
  isolatedDeploymentBuildEnvironment,
  loadSelfhostConfig,
  orbWorkerName,
  parseDeploymentRevisionArgument,
  parseOrbProviders,
  prepareDeploymentCredentials,
  prepareDeploymentPackage,
  reconcileDeploymentMigrationAliases,
  resolveCloudflareDatabaseId,
  resolveE2BTemplateEvidence,
  resourceName,
  securePrivateDeploymentState,
  selfhostStage,
  writeDeploymentAlchemyProfile,
} from "./alchemy-deployment.mjs";
import { alchemyStage } from "./alchemy-stage.mjs";
import { buildTarget, GUEST_TARGET } from "./build-dxd.mjs";
import { loadMigrationManifest } from "./migration-manifest.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const operation = process.argv[2];
const target = process.argv[3] ?? "branch";
const hostedPolicy =
  target === "selfhost"
    ? undefined
    : JSON.parse(required("DX_PRIVATE_DEPLOYMENT_POLICY"));
if (hostedPolicy !== undefined) configureHostedDeploymentPolicy(hostedPolicy);
const selectedStagingRevision = parseDeploymentRevisionArgument(
  process.argv.slice(4),
);
if (!new Set(["deploy", "destroy"]).has(operation))
  throw new Error(
    "Usage: run-alchemy-deployment.mjs <deploy|destroy> [branch|staging|selfhost] [revision]",
  );
if (!new Set(["branch", "staging", "selfhost"]).has(target))
  throw new Error("Deployment target must be branch, staging, or selfhost.");
if (
  target === "selfhost" &&
  operation === "deploy" &&
  process.env.DX_DEPLOY_APPROVE !== "1"
)
  throw new Error(
    "Self-host apply requires DX_DEPLOY_APPROVE=1 after reviewing the noninteractive inputs.",
  );

const deploymentBuildEnvironment = isolatedDeploymentBuildEnvironment(
  process.env,
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
const git = (...args) =>
  execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();

const gitStatus = git(
  ...deploymentGitStatusArguments({
    environment: process.env,
    target,
    workspaceRoot,
  }),
);
const branch = git("branch", "--show-current");
const headRevision = git("rev-parse", "HEAD");
let revision = headRevision;
if (target === "staging" && operation === "deploy") {
  if (!selectedStagingRevision) revision = "";
  else revision = git("rev-parse", `${selectedStagingRevision}^{commit}`);
}
assertCleanRevision({
  branch,
  gitStatus,
  headRevision,
  operation,
  selectedRevision: revision,
  target,
});

const selfhostCloudflareAuth =
  target === "selfhost" ? loadAlchemyCloudflareAuth() : undefined;
const selfhostConfig =
  target === "selfhost"
    ? loadSelfhostConfig({
        environment: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: selfhostCloudflareAuth.accountId,
        },
        workspaceRoot,
      })
    : undefined;
const operatorEnvironment = selfhostConfig?.environment ?? process.env;

const stage =
  target === "staging"
    ? "staging"
    : target === "selfhost"
      ? selfhostStage(selfhostConfig.name)
      : alchemyStage(branch);
const githubApp =
  target === "selfhost" && !selfhostConfig.integrations.includes("github")
    ? undefined
    : deploymentGitHubApp({
        target,
        operation,
        environment: operatorEnvironment,
      });
const bitbucketOAuth =
  target === "selfhost" && !selfhostConfig.integrations.includes("bitbucket")
    ? undefined
    : deploymentBitbucketOAuth({
        target,
        operation,
        environment: operatorEnvironment,
      });
const sarvamApiKey =
  target !== "selfhost" || selfhostConfig.integrations.includes("sarvam")
    ? operatorEnvironment.SARVAM_API_KEY?.trim()
    : undefined;
// Search's deployment-scope Exa key. Hosted targets install Search and use
// the operator key when present; self-host only when the installer chose it.
const exaApiKey =
  target !== "selfhost" || selfhostConfig.integrations.includes("exa")
    ? operatorEnvironment.EXA_API_KEY?.trim()
    : undefined;
// Orb providers: self-host records them; previews and staging read
// DX_ORB_PROVIDERS (e2b, cloudflare, or both; E2B by default).
const orbProviders =
  target === "selfhost"
    ? parseOrbProviders(selfhostConfig.orbProviders.join(","))
    : parseOrbProviders(process.env.DX_ORB_PROVIDERS?.trim() || "e2b");
const e2bInstalled = orbProviders.includes("e2b");
const cloudflareInstalled = orbProviders.includes("cloudflare");
if (operation === "deploy" && cloudflareInstalled) assertDockerAvailable();
const deploymentLabel =
  target === "staging"
    ? `Staging · ${revision.slice(0, 12)}`
    : target === "selfhost"
      ? `Self-host · ${selfhostConfig.name} · ${revision.slice(0, 12)}`
      : `Branch preview · ${branch} · ${revision.slice(0, 12)}`;
if (
  operation === "destroy" &&
  target === "staging" &&
  process.env.DX_CONFIRM_STAGING_DESTROY !== "staging"
)
  throw new Error(
    "Staging destroy requires DX_CONFIRM_STAGING_DESTROY=staging after exporting D1.",
  );

const credentialsPath = `.dx/alchemy/${stage}/credentials.json`;
const credentialsFile = resolve(workspaceRoot, credentialsPath);

await loadMigrationManifest();
const accountId =
  selfhostCloudflareAuth?.accountId ?? required("CLOUDFLARE_ACCOUNT_ID");
if (target !== "selfhost") assertDeploymentAccount(accountId);
const apiToken =
  target === "selfhost"
    ? selfhostCloudflareAuth.headers.Authorization?.replace(/^Bearer /, "")
    : required("CLOUDFLARE_API_TOKEN");
if (!apiToken)
  throw new Error("Self-host deployment requires OAuth or an API token.");
const cloudflareHeaders =
  target === "selfhost"
    ? selfhostCloudflareAuth.headers
    : { Authorization: `Bearer ${apiToken}` };

const cloudflare = async (path) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: cloudflareHeaders,
  });
  const body = await response.json();
  if (!response.ok || body.success !== true)
    throw new Error(`Cloudflare preflight read failed (${response.status}).`);
  return body.result;
};

// The dxd ingress Worker is served on the account's workers.dev subdomain;
// without one, Core keeps serving daemon ingress itself.
const workersDevSubdomain = await (async () => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    { headers: cloudflareHeaders },
  );
  if (response.status === 404) return "";
  const body = await response.json();
  if (!response.ok || body.success !== true)
    throw new Error(
      `Cloudflare workers.dev preflight read failed (${response.status}).`,
    );
  const subdomain = body.result?.subdomain ?? "";
  if (subdomain !== "" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain))
    throw new Error("Cloudflare workers.dev subdomain is invalid.");
  return subdomain;
})();

// A self-host deployment resolves its origin before selection: either a
// caller-supplied hostname under an active account zone, or the worker's
// workers.dev hostname under the account subdomain.
let selfhostDomain;
let selfhostZone;
if (target === "selfhost") {
  if (selfhostConfig.domain !== undefined) {
    selfhostDomain = selfhostConfig.domain;
    if (selfhostConfig.zone !== undefined) {
      const zones = await cloudflare(
        `/zones?account.id=${accountId}&name=${selfhostConfig.zone}&status=active`,
      );
      if (!Array.isArray(zones) || zones.length !== 1)
        throw new Error(
          `Zone ${selfhostConfig.zone} is not active in this Cloudflare account.`,
        );
      selfhostZone = selfhostConfig.zone;
    } else {
      const zones = await cloudflare(
        `/zones?account.id=${accountId}&status=active&per_page=100`,
      );
      const names = (Array.isArray(zones) ? zones : [])
        .map((zone) => zone?.name)
        .filter(
          (name) =>
            typeof name === "string" &&
            (selfhostDomain === name || selfhostDomain.endsWith(`.${name}`)),
        );
      if (names.length !== 1)
        throw new Error(
          `Could not resolve an active zone for ${selfhostDomain} in this Cloudflare account.`,
        );
      selfhostZone = names[0];
    }
  } else {
    const result = await cloudflare(`/accounts/${accountId}/workers/subdomain`);
    const subdomain =
      typeof result?.subdomain === "string" ? result.subdomain : undefined;
    if (!subdomain)
      throw new Error(
        "This Cloudflare account has no workers.dev subdomain. Set `domain`/`zone` in deploy.selfhost.json or create the subdomain first.",
      );
    selfhostDomain = `${resourceName("app", stage)}.${subdomain}.workers.dev`;
  }
}
const selection = deploymentSelection({
  branch,
  stage,
  target,
  selfhost:
    target === "selfhost"
      ? {
          name: selfhostConfig.name,
          accountId,
          domain: selfhostDomain,
          zone: selfhostZone,
        }
      : undefined,
});

let dxdBinary;
let dxdChecksum = "0".repeat(64);
let dxdReleaseUrl = "https://destroy.invalid/dxd";
if (operation === "deploy") {
  if (
    process.env.DX_DXD_RELEASE_URL?.trim() ||
    process.env.DX_DXD_RELEASE_SHA256?.trim()
  )
    throw new Error(
      "Deployments package dxd from the selected clean revision; external dxd release settings are not accepted.",
    );
  if (selfhostConfig?.dxdBinary !== undefined) {
    dxdBinary = resolve(workspaceRoot, selfhostConfig.dxdBinary);
    if (!existsSync(dxdBinary))
      throw new Error(`dxd binary not found: ${selfhostConfig.dxdBinary}`);
  } else if (target === "selfhost") {
    const release = loadDxdRelease(workspaceRoot);
    const bytes = await downloadDxdRelease(release, {
      githubToken: process.env.DX_DXD_GITHUB_TOKEN,
    });
    verifyDxdBytes(bytes, release);
    const releaseDirectory = resolve(
      workspaceRoot,
      `.dx/alchemy/${stage}/dxd-release`,
    );
    mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
    dxdBinary = resolve(releaseDirectory, release.asset);
    writeFileSync(dxdBinary, bytes, { mode: 0o700 });
  } else {
    // The same build path as the published release asset: a static musl
    // binary linked through zig (scripts/build-dxd.mjs), from any host.
    const targetDirectory = resolve(
      workspaceRoot,
      `.dx/alchemy/${stage}/dxd-target`,
    );
    rmSync(targetDirectory, { recursive: true, force: true });
    dxdBinary = buildTarget(GUEST_TARGET, {
      targetDirectory,
      environment: deploymentBuildEnvironment,
    }).binary;
  }
  dxdChecksum = createHash("sha256")
    .update(readFileSync(dxdBinary))
    .digest("hex");
  dxdReleaseUrl = `https://${selection.domain}/dxd`;
}

const authEmailFrom =
  target === "selfhost"
    ? selfhostConfig.authEmailFrom
    : operation === "deploy"
      ? hostedPolicy.authEmailFrom
      : "destroy@invalid.example";

const packageDirectory = `.dx/alchemy/${stage}/package`;
prepareDeploymentPackage({
  operation,
  buildPackage: () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/build-production-package.mjs",
        "--output",
        packageDirectory,
        "--stage",
        stage,
        "--deployment-label",
        deploymentLabel,
        "--revision",
        revision,
        "--target",
        target,
        "--dxd-sha256",
        dxdChecksum,
        "--dxd-binary",
        dxdBinary,
      ],
      {
        cwd: workspaceRoot,
        env: deploymentBuildEnvironment,
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        "Hermetic production-package build or smoke failed before planning.",
      );
  },
});
securePrivateDeploymentState(resolve(workspaceRoot, ".dx", "alchemy", stage));

const [account, zones, databases] = await Promise.all([
  cloudflare(`/accounts/${accountId}`),
  target === "selfhost" && authEmailFrom === undefined
    ? Promise.resolve([{ name: selection.zone ?? "workers.dev" }])
    : cloudflare(
        `/zones?account.id=${accountId}&name=${selection.zone}&status=active`,
      ),
  cloudflare(
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(selection.databaseName)}&per_page=100`,
  ),
]);
if (account.id !== accountId || !Array.isArray(zones) || zones.length !== 1)
  throw new Error(
    target === "selfhost"
      ? "The Cloudflare account was not found."
      : "The exact dx Cloudflare account and zone were not found.",
  );
const databaseId = resolveCloudflareDatabaseId(
  databases,
  selection.databaseName,
);
if (operation === "deploy" && target !== "selfhost")
  prepareDeploymentCredentials({
    credentialsFile,
    databaseId,
    environment: operatorEnvironment,
    stage,
    target,
  });
if (databaseId !== undefined) {
  await reconcileDeploymentMigrationAliases({
    operation,
    target,
    query: async (sql) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          headers: {
            ...cloudflareHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sql }),
        },
      );
      const body = await response.json();
      if (!response.ok || body.success !== true)
        throw new Error(
          `Cloudflare D1 migration preflight failed (${response.status}).`,
        );
      return body.result?.[0]?.results ?? [];
    },
  });
}

let e2bApiKey = "destroy-does-not-select-e2b";
let workloadIdentitySigningKeys;
let templateEvidence = {
  name: "destroy-does-not-select-e2b",
  buildId: "destroy-does-not-select-e2b",
};
const profileTemplateName = (template, templateSuffix) =>
  `${template}-${templateSuffix}`;
const buildE2BOrbTemplates = async (templateEvidence, apiKey) => {
  const baseTemplate = `${templateEvidence.name}:${templateEvidence.buildId}`;
  for (const profile of e2bOrbProfiles) {
    await Template.build(
      dxOrbTemplate(baseTemplate),
      profileTemplateName(templateEvidence.name, profile.templateSuffix),
      {
        apiKey,
        cpuCount: profile.resources.cpuCores,
        memoryMB: profile.resources.memoryMb,
      },
    );
  }
};
if (target === "staging" && operation === "destroy")
  workloadIdentitySigningKeys = JSON.stringify({
    version: 1,
    activeKid: "destroy01",
    keys: [],
  });
if (operation === "deploy" && !e2bInstalled) {
  e2bApiKey = "";
  templateEvidence = { name: "not-installed", buildId: "not-installed" };
  if (target === "staging")
    workloadIdentitySigningKeys = required("DX_WORKLOAD_IDENTITY_SIGNING_KEYS");
  assertDxdChecksum(dxdChecksum);
} else if (operation === "deploy") {
  e2bApiKey =
    target === "selfhost"
      ? process.env.E2B_API_KEY?.trim() || ""
      : required("E2B_API_KEY");
  if (target === "staging")
    workloadIdentitySigningKeys = required("DX_WORKLOAD_IDENTITY_SIGNING_KEYS");
  assertDxdChecksum(dxdChecksum);
  const e2bTemplate =
    target === "selfhost"
      ? "alchemy-held-selfhost-template"
      : required("DX_E2B_TEMPLATE");
  if (!e2bTemplate)
    throw new Error(
      target === "selfhost"
        ? "e2bTemplate is required in deploy.selfhost.json (or DX_E2B_TEMPLATE)."
        : "DX_E2B_TEMPLATE is required.",
    );
  templateEvidence =
    target === "selfhost"
      ? {
          name: e2bTemplate,
          buildId: "alchemy-held-selfhost-build",
        }
      : await resolveE2BTemplateEvidence(e2bTemplate, async () => {
          const config = new ConnectionConfig({ apiKey: e2bApiKey });
          const response = await new ApiClient(config).api.GET("/templates");
          if (!response.data)
            throw new Error(
              `E2B template preflight read failed (${response.response.status}).`,
            );
          return response.data;
        });
  if (target !== "selfhost")
    await buildE2BOrbTemplates(templateEvidence, e2bApiKey);
}

console.log(`Cloudflare account: ${account.name}`);
console.log(`Git revision: ${revision}`);
console.log(`Deployment target: ${target}`);
console.log(`Alchemy stage: ${stage}`);
console.log(`Worker: ${selection.workerName}`);
console.log(`URL: https://${selection.domain}`);
console.log(`Orb providers: ${orbProviders.join(", ")}`);
if (operation === "deploy" && e2bInstalled)
  console.log(
    `E2B template: ${templateEvidence.name} (${templateEvidence.buildId})`,
  );

const authHome =
  target === "selfhost" && selfhostCloudflareAuth.method === "alchemy-oauth"
    ? process.env.HOME
    : resolve(workspaceRoot, `.dx/alchemy/${stage}/auth-home`);
if (target !== "selfhost" || selfhostCloudflareAuth.method !== "alchemy-oauth")
  writeDeploymentAlchemyProfile(authHome);

const applyStartedFile = resolve(
  workspaceRoot,
  `.dx/alchemy/${stage}/apply-started`,
);
rmSync(applyStartedFile, { force: true });
const environment = {
  ...isolatedAlchemyEnvironment(process.env, {
    accountId,
    apiToken,
    authHome,
    profile:
      target === "selfhost" && selfhostCloudflareAuth.method === "alchemy-oauth"
        ? "dx-selfhost"
        : "dx-deployment",
  }),
  CI: "1",
  ...(e2bApiKey ? { E2B_API_KEY: e2bApiKey } : {}),
  ...(githubApp === undefined ? {} : { DX_INTEGRATION_GITHUB_APP: githubApp }),
  ...(bitbucketOAuth === undefined
    ? {}
    : { DX_INTEGRATION_BITBUCKET_OAUTH: bitbucketOAuth }),
  ...(sarvamApiKey ? { SARVAM_API_KEY: sarvamApiKey } : {}),
  ...(exaApiKey ? { EXA_API_KEY: exaApiKey } : {}),
  ...(process.env.DX_ADMIN_PASSWORD
    ? { DX_ADMIN_PASSWORD: process.env.DX_ADMIN_PASSWORD }
    : {}),
  ...(workloadIdentitySigningKeys === undefined
    ? {}
    : { DX_WORKLOAD_IDENTITY_SIGNING_KEYS: workloadIdentitySigningKeys }),
  DX_ALCHEMY_APPLY_STARTED_FILE: applyStartedFile,
  DX_ALCHEMY_OPERATION: operation,
  DX_DEPLOYMENT_BRANCH: branch,
  DX_DEPLOYMENT_LABEL: deploymentLabel,
  ...(authEmailFrom === undefined
    ? {}
    : { DX_DEPLOYMENT_AUTH_EMAIL_FROM: authEmailFrom }),
  DX_DEPLOYMENT_ENVIRONMENT:
    target === "selfhost"
      ? "selfhost"
      : target === "staging"
        ? "staging"
        : "preview",
  DX_DEPLOYMENT_DOMAIN: selection.domain,
  DX_DEPLOYMENT_ZONE: selection.zone ?? "",
  DX_DEPLOYMENT_WORKERS_DEV_SUBDOMAIN: workersDevSubdomain,
  DX_DEPLOYMENT_DAEMON_INGRESS_NAME: daemonIngressWorkerName(stage),
  DX_DEPLOYMENT_NAME: selfhostConfig?.name ?? "",
  ...(selfhostConfig !== undefined
    ? { DX_ADMIN_EMAIL: selfhostConfig.environment.DX_ADMIN_EMAIL }
    : {}),
  ...(selfhostConfig !== undefined
    ? { DX_DEPLOYMENT_INTEGRATIONS: selfhostConfig.integrations.join(",") }
    : {}),
  ...(selfhostConfig !== undefined
    ? { DX_DEPLOYMENT_PLUGINS: (selfhostConfig.plugins ?? []).join(",") }
    : {}),
  ...(process.env.DX_ADMIN_PASSWORD_RESET === "true"
    ? { DX_ADMIN_PASSWORD_RESET: "true" }
    : {}),
  ...(selfhostConfig?.allowSignup ? { DX_SIGNUP_ENABLED: "true" } : {}),
  ...(selfhostConfig?.githubCopilotClientId !== undefined
    ? { DX_GITHUB_COPILOT_CLIENT_ID: selfhostConfig.githubCopilotClientId }
    : {}),
  ...(selfhostConfig?.modelDeploymentProviders !== undefined
    ? {
        DX_MODEL_DEPLOYMENT_PROVIDERS: selfhostConfig.modelDeploymentProviders,
      }
    : {}),
  ...(selfhostConfig?.modelEndpointAllowlist !== undefined
    ? {
        DX_MODEL_ENDPOINT_ALLOWLIST: selfhostConfig.modelEndpointAllowlist,
      }
    : {}),
  ...(selfhostConfig !== undefined
    ? {
        DX_MODEL_WORKERS_AI_ENABLED: selfhostConfig.workersAi
          ? "true"
          : "false",
      }
    : {}),
  // Self-host config is authoritative; previews inherit the operator's env.
  ...(selfhostConfig !== undefined
    ? {
        DX_DEPLOYMENT_WORKER_TRACES:
          selfhostConfig.workerTraces === true ? "true" : "false",
      }
    : {}),
  DX_DEPLOYMENT_PACKAGE_DIR: packageDirectory,
  DX_DEPLOYMENT_ORIGIN: `https://${selection.domain}`,
  DX_DEPLOYMENT_REVISION: revision,
  DX_DEPLOYMENT_WORKER_NAME: selection.workerName,
  DX_DEPLOYMENT_DATABASE_NAME: selection.databaseName,
  DX_DEPLOYMENT_DATABASE_ID: databaseId ?? "",
  DX_DEPLOYMENT_BUCKET_NAME: selection.bucketName,
  DX_DEPLOYMENT_CREDENTIALS_FILE: credentialsPath,
  DX_DEPLOYMENT_BOOTSTRAP_REPOSITORY:
    target === "selfhost"
      ? ""
      : JSON.stringify(hostedPolicy.bootstrapRepository),
  DX_DEPLOYMENT_ORB_PROVIDERS: orbProviders.join(","),
  DX_DEPLOYMENT_ORB_WORKER_NAME: orbWorkerName(stage),
  DX_DEPLOYMENT_E2B_TEMPLATE: templateEvidence.name,
  DX_DEPLOYMENT_E2B_TEMPLATE_BUILD_ID: templateEvidence.buildId,
  DX_DEPLOYMENT_DXD_CHECKSUM: dxdChecksum,
  DX_DEPLOYMENT_DXD_RELEASE_URL: dxdReleaseUrl,
  DX_DEPLOYMENT_STAGE: stage,
  DX_DEPLOYMENT_TARGET: target,
};
const result =
  target === "selfhost"
    ? spawnSync(
        process.execPath,
        [
          "node_modules/alchemy/bin/cli.js",
          operation,
          "alchemy.run.ts",
          "--stage",
          stage,
          "--yes",
        ],
        {
          cwd: workspaceRoot,
          env: environment,
          stdio: "inherit",
        },
      )
    : spawnSync(process.execPath, ["scripts/execute-guarded-alchemy.mjs"], {
        cwd: workspaceRoot,
        env: environment,
        stdio: "inherit",
      });
if (result.error) throw result.error;
if (result.status !== 0) {
  if (target !== "selfhost" && existsSync(applyStartedFile))
    throw new Error(
      "Alchemy stopped after exact-plan validation and apply began; the stage outcome may be uncertain. Inspect the recorded stage before any retry or cleanup.",
    );
  throw new Error(
    target === "selfhost"
      ? "Alchemy self-host deployment failed. Inspect its output and recorded stage before retrying."
      : "Alchemy stopped before provider writes began.",
  );
}
if (operation === "deploy") {
  const verification = spawnSync(
    process.execPath,
    [
      target === "selfhost"
        ? "deploy/selfhost/verify-deployment.mjs"
        : "scripts/verify-alchemy-preview.mjs",
    ],
    {
      cwd: workspaceRoot,
      env: {
        DX_PREVIEW_URL: `https://${selection.domain}`,
        DX_PREVIEW_DEPLOYMENT_LABEL: deploymentLabel,
        DX_PREVIEW_DXD_SHA256: dxdChecksum,
      },
      stdio: "inherit",
      timeout: 180_000,
    },
  );
  assertPostApplyVerification(verification);
  if (target === "selfhost") {
    const credentials = adminCredentialPath(workspaceRoot);
    if (process.env.DX_ADMIN_PASSWORD)
      writeAdminCredentialFile({
        path: credentials,
        url: `https://${selection.domain}`,
        email: selfhostConfig.adminEmail,
        password: process.env.DX_ADMIN_PASSWORD,
      });
    console.log("\nSelf-host administrator");
    console.log(`URL: https://${selection.domain}`);
    console.log(`Login email: ${selfhostConfig.adminEmail}`);
    if (selfhostConfig.authEmailFrom === undefined) {
      console.log(
        `Credential file: ${credentials}${existsSync(credentials) ? "" : " (not present on this machine)"}`,
      );
      console.log("Reset password: pnpm dx:deploy -- --reset-admin");
    } else {
      console.log("Authentication: approved-email magic link");
    }
  }
}
rmSync(applyStartedFile, { force: true });
if (operation === "destroy") rmSync(credentialsFile, { force: true });
