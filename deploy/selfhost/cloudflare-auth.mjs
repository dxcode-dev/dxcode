import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as Redacted from "effect/Redacted";

const alchemyHome = (environment, home) =>
  environment.ALCHEMY_HOME?.trim() || resolve(home, ".alchemy");

/** Where Alchemy 2.0.0-beta.83 keeps a profile's Cloudflare login. */
const cloudflareProfilePath = (environment, home, profile) =>
  resolve(
    alchemyHome(environment, home),
    "profiles",
    profile,
    "cloudflare.json",
  );

/**
 * Whether the profile has a Cloudflare login to refresh, rather than one to
 * add. A login from Alchemy beta.82 or older sits in the old `profiles.json`
 * until the next Alchemy command migrates it.
 */
export const alchemyCloudflareConnected = ({
  profile = "dx-selfhost",
  environment = process.env,
  home = homedir(),
} = {}) => {
  if (existsSync(cloudflareProfilePath(environment, home, profile)))
    return true;
  try {
    const legacy = JSON.parse(
      readFileSync(
        resolve(alchemyHome(environment, home), "profiles.json"),
        "utf8",
      ),
    );
    return legacy?.profiles?.[profile]?.Cloudflare !== undefined;
  } catch {
    return false;
  }
};

const cloudflareRequestAuth = (credentials) => {
  if (credentials.type === "oauth")
    return {
      accountId: credentials.accountId,
      headers: {
        Authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
      },
      method: "alchemy-oauth",
      // What the grant allows; Portals need DNS and Worker route scopes.
      scopes: credentials.scopes,
    };
  if (credentials.type === "apiToken")
    return {
      accountId: credentials.accountId,
      headers: {
        Authorization: `Bearer ${Redacted.value(credentials.apiToken)}`,
      },
      method: "api-token",
    };
  return {
    accountId: credentials.accountId,
    headers: {
      "X-Auth-Email": Redacted.value(credentials.email),
      "X-Auth-Key": Redacted.value(credentials.apiKey),
    },
    method: "global-api-key",
  };
};

const stateStoreSecretNames = new Set([
  "AlchemyStateStoreToken",
  "AlchemyStateStoreEncryptionKey",
]);

export const preflightCloudflareDeployment = async ({
  auth,
  zone,
  authEmailFrom,
  magicLink = false,
  fetch: request = globalThis.fetch,
  log = () => {},
}) => {
  const get = async (
    path,
    { allowNotFound = false, label = "Cloudflare prerequisite" } = {},
  ) => {
    const response = await request(
      `https://api.cloudflare.com/client/v4${path}`,
      { headers: auth.headers },
    );
    if (allowNotFound && response.status === 404) return undefined;
    const body = await response.json();
    if (!response.ok || body.success !== true)
      throw new Error(`${label} read failed (${response.status}).`);
    return body.result;
  };

  const stateStoreWorker = await get(
    `/accounts/${auth.accountId}/workers/scripts/alchemy-state-store/script-settings`,
    { allowNotFound: true, label: "Workers Scripts permission" },
  );
  const stores = await get(
    `/accounts/${auth.accountId}/secrets_store/stores?per_page=100`,
    { label: "Secrets Store permission" },
  );
  if (stateStoreWorker !== undefined) {
    let completeStateStore = false;
    for (const store of Array.isArray(stores) ? stores : []) {
      if (typeof store?.id !== "string") continue;
      const secrets = await get(
        `/accounts/${auth.accountId}/secrets_store/stores/${store.id}/secrets?per_page=100`,
        { label: "Secrets Store permission" },
      );
      const names = new Set(
        (Array.isArray(secrets) ? secrets : [])
          .filter(({ status }) => status === "active")
          .map(({ name }) => name),
      );
      if ([...stateStoreSecretNames].every((name) => names.has(name))) {
        completeStateStore = true;
        break;
      }
    }
    if (!completeStateStore)
      throw new Error(
        "The Cloudflare Alchemy state store exists without its active token and encryption-key secrets. Repair it before entering deployment credentials.",
      );
  }

  // API-token deployments mint the bucket-scoped token Core signs
  // attachment URLs with; Alchemy OAuth deployments sign with the R2 API
  // token the operator supplies and need no token permission.
  if (auth.method !== "alchemy-oauth")
    await get(`/accounts/${auth.accountId}/tokens?per_page=1`, {
      label: "Account API Tokens permission",
    });

  if (zone === undefined) return;
  const zones = await get(
    `/zones?account.id=${auth.accountId}&name=${encodeURIComponent(zone)}&status=active`,
    { label: "Zone Read permission" },
  );
  if (!Array.isArray(zones) || zones.length !== 1)
    throw new Error(`Zone ${zone} is not active in this Cloudflare account.`);

  if (authEmailFrom === undefined) return;
  if (!/^[^\s@]+@[^\s@]+$/.test(authEmailFrom))
    throw new Error("The email sender must be a valid email address.");
  const senderDomain = authEmailFrom
    .slice(authEmailFrom.lastIndexOf("@") + 1)
    .toLowerCase();
  if (senderDomain !== zone && !senderDomain.endsWith(`.${zone}`))
    throw new Error(
      `The email sender must use ${zone} or one of its subdomains.`,
    );
  // Notification email needs only the sender, a Worker binding Alchemy's
  // browser login can deploy. Magic link also needs a Turnstile widget, and
  // that login can neither manage Turnstile nor read Email Sending.
  if (auth.method === "alchemy-oauth") {
    if (magicLink)
      throw new Error(
        "Magic-link sign-in needs a Cloudflare API token: Alchemy's browser login cannot manage its Turnstile widget.",
      );
    log(
      `Alchemy's browser login cannot read Cloudflare Email Sending, so dx cannot check that ${senderDomain} is onboarded. Mention emails fail until it is.\n`,
    );
    return;
  }
  await Promise.all([
    get(`/accounts/${auth.accountId}/d1/database?per_page=1`, {
      label: "D1 permission",
    }),
    get(`/accounts/${auth.accountId}/r2/buckets?per_page=1`, {
      label: "Workers R2 Storage permission",
    }),
    get(`/accounts/${auth.accountId}/challenges/widgets?per_page=1`, {
      label: "Turnstile permission",
    }),
    get(`/zones/${zones[0].id}/workers/routes`, {
      label: "Workers Routes permission",
    }),
  ]);
  const sendingSubdomains = await get(
    `/zones/${zones[0].id}/email/sending/subdomains`,
    { label: "Email Sending permission" },
  );
  if (
    !Array.isArray(sendingSubdomains) ||
    !sendingSubdomains.some(
      ({ name, enabled }) => name === senderDomain && enabled === true,
    )
  )
    throw new Error(
      `Cloudflare Email Sending is not enabled for ${senderDomain}. Onboard that exact sender domain before entering deployment credentials.`,
    );
};

/**
 * Cloudflare Containers is the deployer's own: it needs the Workers Paid
 * plan, which enables the Containers API for the account.
 */
export const preflightCloudflareContainers = async ({
  auth,
  fetch = globalThis.fetch,
}) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/containers/me`,
    { headers: auth.headers },
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok || body?.success !== true)
    throw new Error(
      `Cloudflare Containers is not available to this account or token (${response.status}). It requires the Workers Paid plan and a token that can manage Containers.`,
    );
};

/**
 * Alchemy's CLI entry. The `bin/cli.js` launcher refuses Node before 24.11.1,
 * which it needs only to load TypeScript through Oxc; dx supports Node 22,
 * whose built-in type stripping loads `alchemy.run.ts`.
 */
export const ALCHEMY_CLI = resolve(
  import.meta.dirname,
  "../../node_modules/alchemy/bin/alchemy.js",
);

/**
 * Runs an Alchemy CLI command in this terminal and reports whether it
 * succeeded. Alchemy turns its prompts off when it detects CI or a coding
 * agent in the environment; a person at a terminal still gets them.
 */
export const runAlchemyCli = (args, environment = process.env) => {
  const result = spawnSync(process.execPath, [ALCHEMY_CLI, ...args], {
    stdio: "inherit",
    env: {
      ...environment,
      ...(process.stdin.isTTY && process.stdout.isTTY
        ? { ALCHEMY_TUI: "1" }
        : {}),
    },
  });
  if (result.error) throw result.error;
  return result.status === 0;
};

/**
 * The `alchemy profile` commands that sign a profile in to Cloudflare:
 * refresh an existing login, or reconfigure it when `configure` is set, and
 * otherwise create the profile when needed and add Cloudflare to it.
 */
export const alchemyCloudflareLoginCommands = ({
  profile = "dx-selfhost",
  configure = false,
  environment = process.env,
  home = homedir(),
} = {}) => {
  if (alchemyCloudflareConnected({ profile, environment, home }))
    return [
      configure
        ? [
            "profile",
            "edit",
            "--profile",
            profile,
            "--reconfigure",
            "Cloudflare",
          ]
        : [
            "profile",
            "refresh",
            "--profile",
            profile,
            "--provider",
            "Cloudflare",
          ],
    ];
  return [
    ...(existsSync(resolve(alchemyHome(environment, home), "profiles", profile))
      ? []
      : [["profile", "create", profile]]),
    ["profile", "edit", "--profile", profile, "--add", "Cloudflare"],
  ];
};

export const loadAlchemyCloudflareAuth = ({
  profile = "dx-selfhost",
  environment = process.env,
  home = homedir(),
} = {}) => {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (accountId && apiToken)
    return cloudflareRequestAuth({
      type: "apiToken",
      accountId,
      apiToken: Redacted.make(apiToken),
    });
  const relogin = `Sign in again with \`node node_modules/alchemy/bin/alchemy.js profile edit --profile ${profile} --reconfigure Cloudflare\`, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.`;
  let document;
  try {
    document = JSON.parse(
      readFileSync(cloudflareProfilePath(environment, home, profile), "utf8"),
    );
  } catch (cause) {
    throw new Error(
      `Alchemy profile '${profile}' has no Cloudflare login. ${relogin}`,
      { cause },
    );
  }
  const config = document?.values;
  // Alchemy beta.83 issues OAuth to a new client and migrates an older login
  // to a bare `{ method: "oauth" }`, which holds no token or scopes.
  if (
    config?.method !== "oauth" ||
    typeof config.accountId !== "string" ||
    typeof config.access !== "string" ||
    typeof config.expires !== "number" ||
    !Array.isArray(config.scopes)
  )
    throw new Error(
      `Alchemy profile '${profile}' must hold a current Cloudflare OAuth login. ${relogin}`,
    );
  if (config.expires <= Date.now() + 10_000)
    throw new Error(
      `Alchemy profile '${profile}' has an expired Cloudflare OAuth access token. Refresh it with \`node node_modules/alchemy/bin/alchemy.js profile refresh --profile ${profile}\`.`,
    );
  return cloudflareRequestAuth({
    type: "oauth",
    accountId: config.accountId,
    accessToken: Redacted.make(config.access),
    scopes: config.scopes.filter((scope) => typeof scope === "string"),
  });
};
