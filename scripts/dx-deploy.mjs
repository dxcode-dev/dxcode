import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { collectAdminPassword } from "../deploy/selfhost/admin-credentials.mjs";
import {
  loadAlchemyCloudflareAuth,
  preflightCloudflareDeployment,
} from "../deploy/selfhost/cloudflare-auth.mjs";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import { createHiddenPrompt } from "./hidden-prompt.mjs";

export const collectDeploymentConfig = async ({
  answer,
  yes,
  secret,
  environment,
  defaults = {},
  authEmailFrom: providedAuthEmailFrom,
}) => {
  const name = defaults.name ?? (await answer("Deployment name", "my-dx"));
  const hostedAuthentication =
    defaults.hostedAuthentication === true ||
    defaults.authEmailFrom !== undefined;
  const customDomain =
    defaults.domain !== undefined || (await yes("Use a custom domain"));
  const domain =
    defaults.domain ?? (customDomain ? await answer("Domain") : undefined);
  const zone =
    defaults.zone ??
    (customDomain ? await answer("Cloudflare zone") : undefined);
  const adminEmail = await answer("First administrator email");
  const authEmailFrom =
    providedAuthEmailFrom ??
    (hostedAuthentication
      ? await answer("Magic-link sender email", defaults.authEmailFrom)
      : undefined);
  if (!hostedAuthentication)
    environment.DX_ADMIN_PASSWORD = await collectAdminPassword({
      readSecret: secret,
    });
  environment.E2B_API_KEY = await secret("E2B API key");
  const integrations = [];
  if (await yes("Configure a GitHub App")) {
    integrations.push("github");
    environment.DX_INTEGRATION_GITHUB_APP = await secret("GitHub App JSON");
  }
  if (await yes("Configure Bitbucket OAuth")) {
    integrations.push("bitbucket");
    environment.DX_INTEGRATION_BITBUCKET_OAUTH = await secret(
      "Bitbucket OAuth JSON",
    );
  }
  if (await yes("Configure Sarvam dictation")) {
    integrations.push("sarvam");
    environment.SARVAM_API_KEY = await secret("Sarvam API key");
  }
  const githubCopilotClientId = (await yes("Configure GitHub Copilot sign-in"))
    ? await answer("GitHub Copilot OAuth client ID")
    : undefined;
  const workersAi = await yes("Enable Workers AI", true);
  const modelDeploymentProviders = (await yes(
    "Configure other deployment model integrations",
  ))
    ? await answer("Deployment provider IDs, comma-separated")
    : undefined;
  return validateSelfhostConfig({
    name,
    cloudflareAccountId: defaults.cloudflareAccountId,
    adminEmail,
    ...(domain ? { domain, zone } : {}),
    ...(authEmailFrom ? { authEmailFrom } : {}),
    integrations,
    githubCopilotClientId,
    workersAi,
    modelDeploymentProviders,
    allowSignup: hostedAuthentication
      ? false
      : await yes("Allow public account creation"),
  });
};

export const assertInstallerDefaults = (config, defaults) => {
  for (const key of ["name", "domain", "zone", "authEmailFrom"])
    if (defaults[key] !== undefined && config[key] !== defaults[key])
      throw new Error(
        `Existing deployment config must keep the installer default for ${key}.`,
      );
};

export const provisionalDeploymentConfigPath = (
  configPath,
  nonce = randomUUID(),
) =>
  join(
    dirname(resolve(configPath)),
    `.${basename(configPath)}.${nonce}.pending`,
  );

export const runDxDeploy = async ({
  defaults = {},
  configPath = process.env.DX_SELFHOST_CONFIG || "deploy.selfhost.json",
  argv = process.argv.slice(2),
} = {}) => {
  const flags = new Set(argv.filter((value) => value !== "--"));
  const existing = existsSync(configPath)
    ? validateSelfhostConfig(JSON.parse(readFileSync(configPath, "utf8")))
    : undefined;
  if (existing !== undefined) assertInstallerDefaults(existing, defaults);
  let rl = createInterface({ input: stdin, output: stdout });
  const answer = async (label, fallback) => {
    const value = (
      await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)
    ).trim();
    return value || fallback;
  };
  const yes = async (label, fallback = false) => {
    const value = await answer(`${label} (${fallback ? "Y/n" : "y/N"})`, "");
    if (value === "") return fallback;
    return value.toLowerCase() === "y" || value.toLowerCase() === "yes";
  };
  const secret = createHiddenPrompt({
    input: stdin,
    output: stdout,
    pause: () => rl.close(),
    resume: () => {
      rl = createInterface({ input: stdin, output: stdout });
    },
  });
  const environment = { ...process.env };
  const hostedAuthentication = defaults.hostedAuthentication === true;
  if (existing?.cloudflareAccountId && !environment.CLOUDFLARE_ACCOUNT_ID)
    environment.CLOUDFLARE_ACCOUNT_ID = existing.cloudflareAccountId;
  if (hostedAuthentication && !environment.CLOUDFLARE_API_TOKEN) {
    if (!environment.CLOUDFLARE_ACCOUNT_ID)
      environment.CLOUDFLARE_ACCOUNT_ID = await answer("Cloudflare account ID");
    const token = await secret("Cloudflare deployment API token");
    if (token.trim().length === 0)
      throw new Error("Cloudflare deployment API token is required.");
    environment.CLOUDFLARE_API_TOKEN = token;
  }
  if (environment.CLOUDFLARE_API_TOKEN && !environment.CLOUDFLARE_ACCOUNT_ID)
    environment.CLOUDFLARE_ACCOUNT_ID = await answer("Cloudflare account ID");
  if (!environment.CLOUDFLARE_API_TOKEN) {
    const login = spawnSync(
      "pnpm",
      ["exec", "alchemy", "login", "--profile", "dx-selfhost"],
      { stdio: "inherit" },
    );
    if (login.error) throw login.error;
    if (login.status !== 0) throw new Error("Alchemy Cloudflare login failed.");
  }
  const cloudflareAuth = loadAlchemyCloudflareAuth({ environment });
  if (
    existing?.cloudflareAccountId !== undefined &&
    existing.cloudflareAccountId !== cloudflareAuth.accountId
  )
    throw new Error(`${configPath} belongs to a different Cloudflare account.`);

  const authEmailFrom =
    existing?.authEmailFrom ??
    (hostedAuthentication
      ? await answer("Magic-link sender email")
      : undefined);
  await preflightCloudflareDeployment({
    auth: cloudflareAuth,
    zone: existing?.zone ?? defaults.zone,
    authEmailFrom,
  });
  stdout.write("Cloudflare prerequisites passed.\n");

  let config = existing;
  if (config === undefined)
    config = await collectDeploymentConfig({
      answer,
      yes,
      secret,
      environment,
      defaults: { ...defaults, cloudflareAccountId: cloudflareAuth.accountId },
      authEmailFrom,
    });
  else if (flags.has("--rotate")) {
    environment.E2B_API_KEY = await secret(
      "New E2B API key, or Ctrl-C to cancel",
    );
    for (const integration of config.integrations) {
      const variable = {
        github: "DX_INTEGRATION_GITHUB_APP",
        bitbucket: "DX_INTEGRATION_BITBUCKET_OAUTH",
        sarvam: "SARVAM_API_KEY",
      }[integration];
      if (await yes(`Rotate ${integration}`))
        environment[variable] = await secret(`New ${integration} secret`);
    }
  }
  if (flags.has("--reset-admin")) {
    if (config.authEmailFrom !== undefined)
      throw new Error(
        "Hosted magic-link authentication has no administrator password to reset.",
      );
    environment.DX_ADMIN_PASSWORD = await collectAdminPassword({
      readSecret: secret,
      reset: true,
    });
    environment.DX_ADMIN_PASSWORD_RESET = "true";
  }

  const review = {
    ...config,
    cloudflareAuth: environment.CLOUDFLARE_API_TOKEN
      ? "API token"
      : "Alchemy renewable OAuth",
    secrets: Object.keys(environment)
      .filter((name) =>
        new Set([
          "DX_ADMIN_PASSWORD",
          "E2B_API_KEY",
          "DX_INTEGRATION_GITHUB_APP",
          "DX_INTEGRATION_BITBUCKET_OAUTH",
          "SARVAM_API_KEY",
        ]).has(name),
      )
      .sort()
      .map((name) => `${name}=<redacted>`),
  };
  stdout.write(`\nDeployment review\n${JSON.stringify(review, null, 2)}\n`);
  if (!(await yes("Apply this deployment"))) {
    rl.close();
    stdout.write("Cancelled before deployment mutation.\n");
    return;
  }
  rl.close();
  const deploymentConfigPath =
    existing === undefined
      ? provisionalDeploymentConfigPath(configPath)
      : configPath;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(deploymentConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(deploymentConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(deploymentConfigPath, 0o600);
  const result = spawnSync(
    process.execPath,
    ["scripts/run-alchemy-deployment.mjs", "deploy", "selfhost"],
    {
      env: {
        ...environment,
        DX_DEPLOY_APPROVE: "1",
        DX_SELFHOST_CONFIG: deploymentConfigPath,
        ...(existing === undefined
          ? { DX_SELFHOST_CONFIG_PROVISIONAL: "1" }
          : {}),
      },
      stdio: "inherit",
    },
  );
  if (result.error) {
    if (existing === undefined) rmSync(deploymentConfigPath, { force: true });
    throw result.error;
  }
  if (result.status !== 0) {
    if (existing === undefined) rmSync(deploymentConfigPath, { force: true });
    throw new Error(`Deployment failed with status ${result.status ?? 1}.`);
  }
  if (existing === undefined) renameSync(deploymentConfigPath, configPath);
};

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
)
  await runDxDeploy();
