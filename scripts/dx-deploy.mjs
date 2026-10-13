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
import {
  assertDockerReady,
  orbDockerEnvironment,
} from "../deploy/orb/containers.mjs";
import {
  adminCredentialPath,
  collectAdminPassword,
} from "../deploy/selfhost/admin-credentials.mjs";
import {
  loadAlchemyCloudflareAuth,
  preflightCloudflareContainers,
  preflightCloudflareDeployment,
} from "../deploy/selfhost/cloudflare-auth.mjs";
import {
  FIRST_PARTY_PLUGIN_IDS,
  SIGN_IN_ADMISSIONS,
  validateSelfhostConfig,
} from "../deploy/selfhost/config.mjs";
import { createHiddenPrompt } from "./hidden-prompt.mjs";

export const WORKER_TRACES_PROMPT =
  "Enable Cloudflare Worker traces (records request URLs and Durable Object names)";

/**
 * First-party plugins are installed at deploy time. Each may also take a
 * deployment-scope provider key; without one, people and workspaces add
 * their own in Settings → Plugins. The installer asks once about each plugin
 * not yet in `offered` and records what it asked.
 */
const PLUGIN_QUESTIONS = Object.freeze([
  {
    id: "search",
    install:
      "Install the Web search plugin (agent web search and page reading)",
    key: "Configure a deployment Exa API key for Search (people and workspaces can also add their own)",
    integration: "exa",
    variable: "EXA_API_KEY",
    secret: "Exa API key",
  },
  {
    id: "speech",
    install: "Install the Speech plugin (composer dictation)",
    key: "Configure a deployment Sarvam API key for Speech (people and workspaces can also add their own)",
    integration: "sarvam",
    variable: "SARVAM_API_KEY",
    secret: "Sarvam API key",
  },
]);

export const collectPluginChoices = async ({
  yes,
  secret,
  environment,
  integrations,
  plugins = [],
  offered = [],
}) => {
  const installed = [...plugins];
  const asked = [...offered];
  for (const question of PLUGIN_QUESTIONS) {
    if (asked.includes(question.id)) continue;
    asked.push(question.id);
    if (!(await yes(question.install))) continue;
    installed.push(question.id);
    if (await yes(question.key)) {
      integrations.push(question.integration);
      environment[question.variable] = await secret(question.secret);
    }
  }
  return { plugins: installed, offeredPlugins: asked, integrations };
};

export const E2B_ORB_PROMPT =
  "Install E2B as an Orb provider (sandboxes on E2B; needs an E2B API key)";
export const CLOUDFLARE_ORB_PROMPT =
  "Install Cloudflare Containers as an Orb provider (containers run and are billed in this Cloudflare account; requires the Workers Paid plan and Docker on this machine)";

/**
 * Every deployment installs at least one Orb provider (where each Thread's
 * workspace runs). Containers needs no key, but must be an explicit choice
 * because it requires the Workers Paid plan.
 */
export const collectOrbProviders = async ({
  yes,
  secret,
  environment,
  log,
}) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const providers = [];
    if (await yes(E2B_ORB_PROMPT, true)) {
      providers.push("e2b");
      environment.E2B_API_KEY = await secret("E2B API key");
    }
    if (await yes(CLOUDFLARE_ORB_PROMPT, false)) providers.push("cloudflare");
    if (providers.length > 0) return providers;
    log(
      "Install at least one Orb provider: E2B, Cloudflare Containers, or both.\n",
    );
  }
  throw new Error("A deployment must install at least one Orb provider.");
};

export const EMAIL_SENDING_PROMPT =
  "Send email from your domain (magic links, verified sign-ups, and notification emails such as mentions; needs a Cloudflare API token and Email Sending on your zone)";
/**
 * One sender serves sign-in and notification email. Notification email needs
 * only the sender, so it works whether or not magic-link sign-in is offered.
 */
export const SENDER_EMAIL_PROMPT =
  "Sender email for sign-in and notification emails";
export const SENDER_NEEDS_DOMAIN_NOTICE =
  "Notification emails need a sender on a custom domain. This deployment uses workers.dev, so mentions show in the app only.\n";

/**
 * A deployment created without a sender is offered one once, because
 * notification email needs only a sender, not magic-link sign-in. The hosted
 * wrapper always has one, and `--email` asks again.
 */
export const collectSenderUpgrade = async ({
  existing,
  defaults = {},
  flags,
  yes,
  log,
}) => {
  const offered =
    existing !== undefined &&
    defaults.hostedAuthentication !== true &&
    existing.authEmailFrom === undefined &&
    (flags.has("--email") || existing.offeredEmailSending !== true);
  if (!offered) return { offered: false, addSender: false };
  if (existing.zone === undefined) {
    log(SENDER_NEEDS_DOMAIN_NOTICE);
    return { offered: true, addSender: false };
  }
  return { offered: true, addSender: await yes(EMAIL_SENDING_PROMPT, false) };
};

export const BROWSER_LOGIN_SWITCH_PROMPT =
  "This deployment no longer needs a Cloudflare API token. Switch to Alchemy browser login? This deploy uses your token one last time to remove the Turnstile widget and the attachment signing token, which browser login cannot manage";

const magicLinkOffered = (config) =>
  config.signIn.providers.includes("magic-link");

/**
 * How this run signs in to Cloudflare (`credentials`) and what the
 * deployment records for later runs (`record`). Only magic link needs an API
 * token, for its Turnstile widget; notification email needs just the sender.
 * A token in the environment is always used. A deployment that switches to
 * browser login runs once more with its token, already shaped for browser
 * login, so the token removes what browser login cannot manage.
 */
export const chooseCloudflareAuth = async ({
  existing,
  defaults = {},
  sender = false,
  magicLink = false,
  hasToken,
  yes,
  log = () => {},
}) => {
  const token = { credentials: "api-token", record: "api-token" };
  const browser = {
    credentials: hasToken ? "api-token" : "alchemy-oauth",
    record: "alchemy-oauth",
  };
  if (defaults.hostedAuthentication === true) return token;
  if (existing === undefined)
    return (sender && magicLink) || hasToken ? token : browser;
  if (magicLinkOffered(existing)) return token;
  if (existing.cloudflareAuth === "alchemy-oauth") return browser;
  if (existing.cloudflareAuth === "api-token") return token;
  // Recorded before 0.2.19, when every sender meant an API token.
  if (existing.authEmailFrom !== undefined) {
    if (!(await yes(BROWSER_LOGIN_SWITCH_PROMPT, true))) return token;
    log(
      "This deploy uses your API token to remove the Turnstile widget and the attachment signing token; later deploys use Alchemy browser login.\n",
    );
    return { credentials: "api-token", record: "alchemy-oauth" };
  }
  return hasToken ? token : browser;
};

export const NO_SENDER_NOTICE =
  "No email sender: mentions show in the app only, and notification emails stay off. Run pnpm dx:deploy again with a sender to turn them on.\n";
export const MAGIC_LINK_PROMPT = "Offer magic-link sign-in";
export const SIGN_IN_UPGRADE_PROMPT =
  "Review sign-in methods now (Google, allowed email domains, Terms and Privacy links)";
export const PASSWORD_PROMPT = "Offer email and password sign-in";
export const GOOGLE_PROMPT =
  "Offer Google sign-in (needs a Google OAuth client)";

/**
 * Sign-in providers are Better Auth methods chosen per deployment. The page
 * at /signin shows exactly these. Hosted dx always runs magic link behind the
 * waitlist and may add Google.
 */
export const collectSignIn = async ({
  answer,
  yes,
  secret,
  environment,
  emailSending,
  magicLink,
  hosted = false,
  origin,
  log,
}) => {
  let providers = [];
  for (let attempt = 0; attempt < 3 && providers.length === 0; attempt += 1) {
    providers = [];
    // A new install already answered magic link before Cloudflare login.
    if (
      hosted ||
      (emailSending &&
        (attempt === 0 && magicLink !== undefined
          ? magicLink
          : await yes(MAGIC_LINK_PROMPT, true)))
    )
      providers.push("magic-link");
    if (!hosted && (await yes(PASSWORD_PROMPT, !emailSending)))
      providers.push("email-password");
    if (await yes(GOOGLE_PROMPT, false)) providers.push("google");
    if (providers.length === 0) log("Offer at least one sign-in method.\n");
  }
  if (providers.length === 0)
    throw new Error("A deployment must offer at least one sign-in method.");
  let googleClientId;
  if (providers.includes("google")) {
    log(
      `Create a Google OAuth web client with the redirect URI ${origin ?? "https://<your-domain>"}/api/auth/callback/google\n`,
    );
    googleClientId = await answer("Google OAuth client ID");
    environment.DX_GOOGLE_CLIENT_SECRET = await secret(
      "Google OAuth client secret",
    );
  }
  let admission = "waitlist";
  if (!hosted) {
    const publicSignUpAllowed =
      emailSending || !providers.includes("email-password");
    for (let attempt = 0; ; attempt += 1) {
      admission = await answer(
        `Who can create an account: ${SIGN_IN_ADMISSIONS.join(", ")}`,
        "invite",
      );
      const valid =
        SIGN_IN_ADMISSIONS.includes(admission) &&
        (admission === "invite" || publicSignUpAllowed);
      if (valid) break;
      if (attempt === 2)
        throw new Error("Choose open, waitlist, or invite for sign-up.");
      log(
        SIGN_IN_ADMISSIONS.includes(admission)
          ? "Public password sign-up verifies each email; enable sign-in email or choose invite.\n"
          : "Choose open, waitlist, or invite.\n",
      );
    }
  }
  const domains = (
    (await answer(
      "Allowed email domains, comma-separated (blank allows any domain)",
      "",
    )) ?? ""
  )
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const legal = (await yes("Link Terms of Service and Privacy Policy pages"))
    ? {
        termsUrl: await answer("Terms of Service URL"),
        privacyUrl: await answer("Privacy Policy URL"),
      }
    : {};
  return {
    providers,
    admission,
    allowedEmailDomains: [...new Set(domains)],
    ...(googleClientId === undefined ? {} : { googleClientId }),
    ...legal,
  };
};

export const collectDeploymentConfig = async ({
  answer,
  yes,
  secret,
  environment,
  defaults = {},
  authEmailFrom: providedAuthEmailFrom,
  magicLink,
  cloudflareAuth,
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
      ? await answer(SENDER_EMAIL_PROMPT, defaults.authEmailFrom)
      : undefined);
  const signIn = await collectSignIn({
    answer,
    yes,
    secret,
    environment,
    emailSending: authEmailFrom !== undefined,
    magicLink,
    hosted: defaults.hostedAuthentication === true,
    origin: domain === undefined ? undefined : `https://${domain}`,
    log: (message) => stdout.write(message),
  });
  if (signIn.providers.includes("email-password"))
    environment.DX_ADMIN_PASSWORD = await collectAdminPassword({
      readSecret: secret,
    });
  const orbProviders = await collectOrbProviders({
    yes,
    secret,
    environment,
    log: (message) => stdout.write(message),
  });
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
  const { plugins, offeredPlugins } = await collectPluginChoices({
    yes,
    secret,
    environment,
    integrations,
  });
  const githubCopilotClientId = (await yes("Configure GitHub Copilot sign-in"))
    ? await answer("GitHub Copilot OAuth client ID")
    : undefined;
  const workersAi = await yes("Enable Workers AI", true);
  const workerTraces = await yes(WORKER_TRACES_PROMPT, false);
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
    ...(cloudflareAuth === undefined ? {} : { cloudflareAuth }),
    integrations,
    orbProviders,
    plugins,
    offeredPlugins,
    githubCopilotClientId,
    workersAi,
    workerTraces,
    modelDeploymentProviders,
    signIn,
  });
};

export const assertInstallerDefaults = (config, defaults) => {
  for (const key of ["name", "domain", "zone", "authEmailFrom"])
    if (defaults[key] !== undefined && config[key] !== defaults[key])
      throw new Error(
        `Existing deployment config must keep the installer default for ${key}.`,
      );
};

const provisionalDeploymentConfigPath = (configPath, nonce = randomUUID()) =>
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
  const existingInput = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : undefined;
  const existing =
    existingInput === undefined
      ? undefined
      : validateSelfhostConfig(existingInput);
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
  // A sender needs Email Sending and Turnstile, which Alchemy's OAuth login
  // cannot manage, so decide before signing in to Cloudflare.
  const senderUpgrade = await collectSenderUpgrade({
    existing,
    defaults,
    flags,
    yes,
    log: (message) => stdout.write(message),
  });
  // A new install answers the email questions first: magic link decides
  // whether Cloudflare needs an API token.
  const newSender =
    existing === undefined &&
    defaults.hostedAuthentication !== true &&
    (await yes(EMAIL_SENDING_PROMPT, false));
  const newMagicLink = newSender && (await yes(MAGIC_LINK_PROMPT, true));
  const cloudflareAuthChoice = await chooseCloudflareAuth({
    existing,
    defaults,
    sender: newSender,
    magicLink: newMagicLink,
    hasToken: Boolean(environment.CLOUDFLARE_API_TOKEN),
    yes,
    log: (message) => stdout.write(message),
  });
  const wantsSender =
    defaults.hostedAuthentication === true ||
    existing?.authEmailFrom !== undefined ||
    senderUpgrade.addSender ||
    newSender;
  if (existing?.cloudflareAccountId && !environment.CLOUDFLARE_ACCOUNT_ID)
    environment.CLOUDFLARE_ACCOUNT_ID = existing.cloudflareAccountId;
  if (
    cloudflareAuthChoice.credentials === "api-token" &&
    !environment.CLOUDFLARE_API_TOKEN
  ) {
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
    (wantsSender
      ? await answer(`${SENDER_EMAIL_PROMPT} (an address on your zone)`)
      : undefined);
  if (
    authEmailFrom === undefined &&
    (existing === undefined || senderUpgrade.offered)
  )
    stdout.write(NO_SENDER_NOTICE);
  await preflightCloudflareDeployment({
    auth: cloudflareAuth,
    zone: existing?.zone ?? defaults.zone,
    authEmailFrom,
    magicLink:
      existing === undefined
        ? defaults.hostedAuthentication === true || newMagicLink
        : magicLinkOffered(existing),
    log: (message) => stdout.write(message),
  });
  stdout.write("Cloudflare prerequisites passed.\n");

  let config = existing;
  // A sender entered for an existing deployment is saved with it, and the
  // offer is remembered either way. Sign-in methods stay as they were.
  if (
    config !== undefined &&
    (authEmailFrom !== config.authEmailFrom ||
      senderUpgrade.offered ||
      config.cloudflareAuth !== cloudflareAuthChoice.record)
  ) {
    config = validateSelfhostConfig({
      ...config,
      ...(authEmailFrom === undefined ? {} : { authEmailFrom }),
      ...(senderUpgrade.offered ? { offeredEmailSending: true } : {}),
      cloudflareAuth: cloudflareAuthChoice.record,
    });
    if (authEmailFrom !== undefined && existing?.authEmailFrom === undefined)
      stdout.write(
        `Notification emails will come from ${config.authEmailFrom}. To also offer magic-link sign-in, run pnpm dx:deploy -- --sign-in.\n`,
      );
  }
  if (config === undefined)
    config = await collectDeploymentConfig({
      answer,
      yes,
      secret,
      environment,
      defaults: { ...defaults, cloudflareAccountId: cloudflareAuth.accountId },
      authEmailFrom,
      magicLink: newSender ? newMagicLink : undefined,
      cloudflareAuth: cloudflareAuthChoice.record,
    });
  else if (flags.has("--rotate")) {
    if (config.orbProviders.includes("e2b"))
      environment.E2B_API_KEY = await secret(
        "New E2B API key, or Ctrl-C to cancel",
      );
    for (const integration of config.integrations) {
      const variable = {
        github: "DX_INTEGRATION_GITHUB_APP",
        bitbucket: "DX_INTEGRATION_BITBUCKET_OAUTH",
        sarvam: "SARVAM_API_KEY",
        exa: "EXA_API_KEY",
      }[integration];
      if (await yes(`Rotate ${integration}`))
        environment[variable] = await secret(`New ${integration} secret`);
    }
    if (
      config.signIn.providers.includes("google") &&
      (await yes("Rotate the Google OAuth client secret"))
    )
      environment.DX_GOOGLE_CLIENT_SECRET = await secret(
        "New Google OAuth client secret",
      );
  }
  // Deployments created before a plugin existed were never asked about it.
  if (
    FIRST_PARTY_PLUGIN_IDS.some(
      (id) => !(config.offeredPlugins ?? []).includes(id),
    )
  )
    config = validateSelfhostConfig({
      ...config,
      ...(await collectPluginChoices({
        yes,
        secret,
        environment,
        integrations: [...config.integrations],
        plugins: config.plugins ?? [],
        offered: config.offeredPlugins ?? [],
      })),
    });
  // `--sign-in` revisits the sign-in step; a deployment created before
  // sign-in settings existed is offered it once.
  if (
    existing !== undefined &&
    (flags.has("--sign-in") ||
      (existingInput.signIn === undefined &&
        (await yes(SIGN_IN_UPGRADE_PROMPT, false))))
  ) {
    const signIn = await collectSignIn({
      answer,
      yes,
      secret,
      environment,
      emailSending: config.authEmailFrom !== undefined,
      hosted: defaults.hostedAuthentication === true,
      origin:
        config.domain === undefined ? undefined : `https://${config.domain}`,
      log: (message) => stdout.write(message),
    });
    // Magic link needs a Turnstile widget, which only an API token manages.
    const magicLink = signIn.providers.includes("magic-link");
    if (magicLink && cloudflareAuthChoice.credentials !== "api-token")
      throw new Error(
        "Magic-link sign-in needs a Cloudflare API token for its Turnstile widget. Rerun with CLOUDFLARE_API_TOKEN set.",
      );
    config = validateSelfhostConfig({
      ...config,
      signIn,
      ...(magicLink ? { cloudflareAuth: "api-token" } : {}),
    });
  }
  // Deployments created before tracing was configurable were never asked.
  if (config.workerTraces === undefined)
    config = validateSelfhostConfig({
      ...config,
      workerTraces: await yes(WORKER_TRACES_PROMPT, false),
    });
  if (config.orbProviders.includes("cloudflare")) {
    await preflightCloudflareContainers({ auth: cloudflareAuth });
    assertDockerReady(
      orbDockerEnvironment({
        environment,
        stateDirectory: resolve(".dx/alchemy/docker-preflight"),
      }),
    );
    stdout.write("Cloudflare Containers prerequisites passed.\n");
  }
  // Turning password sign-in on for an existing deployment needs a first
  // administrator password. A machine that already holds the credential file
  // has one; elsewhere the operator decides, since the deployment may hold
  // one from an earlier run.
  if (
    existing !== undefined &&
    !flags.has("--reset-admin") &&
    config.signIn.providers.includes("email-password") &&
    !environment.DX_ADMIN_PASSWORD &&
    !existsSync(adminCredentialPath(process.cwd())) &&
    (await yes(
      "Password sign-in is on. Set the administrator password now (needed the first time password sign-in is enabled)",
      false,
    ))
  )
    environment.DX_ADMIN_PASSWORD = await collectAdminPassword({
      readSecret: secret,
    });
  if (flags.has("--reset-admin")) {
    if (!config.signIn.providers.includes("email-password"))
      throw new Error(
        "This deployment has no password sign-in, so there is no administrator password to reset.",
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
          "EXA_API_KEY",
          "DX_GOOGLE_CLIENT_SECRET",
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
