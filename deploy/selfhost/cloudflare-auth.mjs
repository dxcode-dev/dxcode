import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as Redacted from "effect/Redacted";

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Could not read ${label}. Run Alchemy login again.`, {
      cause,
    });
  }
};

export const cloudflareRequestAuth = (credentials) => {
  if (credentials.type === "oauth")
    return {
      accountId: credentials.accountId,
      headers: {
        Authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
      },
      method: "alchemy-oauth",
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
  fetch: request = globalThis.fetch,
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

  if (zone === undefined) return;
  const zones = await get(
    `/zones?account.id=${auth.accountId}&name=${encodeURIComponent(zone)}&status=active`,
    { label: "Zone Read permission" },
  );
  if (!Array.isArray(zones) || zones.length !== 1)
    throw new Error(`Zone ${zone} is not active in this Cloudflare account.`);

  if (authEmailFrom === undefined) return;
  if (!/^[^\s@]+@[^\s@]+$/.test(authEmailFrom))
    throw new Error("Magic-link sender must be a valid email address.");
  const senderDomain = authEmailFrom
    .slice(authEmailFrom.lastIndexOf("@") + 1)
    .toLowerCase();
  if (senderDomain !== zone && !senderDomain.endsWith(`.${zone}`))
    throw new Error(
      `Magic-link sender must use ${zone} or one of its subdomains.`,
    );
  if (auth.method === "alchemy-oauth")
    throw new Error(
      "Hosted authentication requires a Cloudflare API token; Alchemy OAuth cannot manage Turnstile or inspect Email Sending.",
    );
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
  const profiles = readJson(
    resolve(home, ".alchemy/profiles.json"),
    "Alchemy profiles",
  );
  const config = profiles?.profiles?.[profile]?.Cloudflare;
  if (config?.method !== "oauth" || typeof config.accountId !== "string")
    throw new Error(
      `Alchemy profile '${profile}' must use Cloudflare OAuth, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.`,
    );
  const oauth = readJson(
    resolve(home, `.alchemy/credentials/${profile}/cf-oauth.json`),
    "Alchemy Cloudflare OAuth credentials",
  );
  if (
    oauth?.type !== "oauth" ||
    typeof oauth.access !== "string" ||
    typeof oauth.expires !== "number" ||
    oauth.expires <= Date.now() + 10_000
  )
    throw new Error(
      `Alchemy profile '${profile}' has no current Cloudflare OAuth access token. Run Alchemy login to refresh it.`,
    );
  return cloudflareRequestAuth({
    type: "oauth",
    accountId: config.accountId,
    accessToken: Redacted.make(oauth.access),
  });
};
