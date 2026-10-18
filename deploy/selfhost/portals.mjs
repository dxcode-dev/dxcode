// Portal domains and the Cloudflare access a deployment needs to serve them.
// The wizard (scripts/dx-deploy.mjs) and the deployment runner
// (scripts/run-alchemy-deployment.mjs) both use this module, so a domain or
// token one accepts the other accepts too.

import { getDomain } from "tldts";

export const PORTAL_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Browsers group hosts into sites by registrable domain (eTLD+1, by the
// Public Suffix List including its private section).
const site = (hostname) =>
  getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;

/**
 * True when a Portal host under `portalDomain` would be same-site with
 * `appHostname`, or either contains the other. Guest code on a same-site
 * Portal host could set `Domain=` cookies dx reads (login CSRF, session
 * fixation) and would pass SameSite checks. A Portal domain that is itself on
 * the Public Suffix List gives every Portal host its own site.
 *
 * Same rule as Core's apps/core/src/portals/portal-site.ts and alchemy.run.ts.
 */
export const portalDomainSharesSite = (appHostname, portalDomain) => {
  const app = appHostname.toLowerCase();
  const portal = portalDomain.toLowerCase();
  if (
    app === portal ||
    app.endsWith(`.${portal}`) ||
    portal.endsWith(`.${app}`)
  )
    return true;
  return site(`t-0-p1.${portal}`) === site(app);
};

/**
 * Why `portalDomain` cannot serve Portals for an app at `appDomain`, or
 * undefined when it can. `appDomain` is undefined when the app's hostname is
 * not known yet (a workers.dev self-host).
 */
export const portalDomainProblem = (portalDomain, appDomain) => {
  if (portalDomain.length > 253 || !PORTAL_DOMAIN_PATTERN.test(portalDomain))
    return "must be a bare domain (a Cloudflare zone apex), such as example-portals.dev";
  if (portalDomain === "workers.dev" || portalDomain.endsWith(".workers.dev"))
    return "cannot be on workers.dev: Portals need the wildcard route *.<domain>/* on a zone of your own in this Cloudflare account";
  if (
    appDomain !== undefined &&
    portalDomainSharesSite(appDomain, portalDomain)
  )
    return `must be its own registrable domain, not on the app's site ${site(appDomain.toLowerCase())}: guest pages on a same-site Portal host could set cookies dx reads`;
  return undefined;
};

/**
 * The Cloudflare permissions a Portal zone needs, as an API token's
 * permission groups (the dashboard says Edit, the API says Write) and as
 * Alchemy OAuth scopes.
 */
export const PORTAL_PERMISSIONS = Object.freeze([
  {
    label: "Zone Read",
    groups: ["Zone Read", "Zone Write", "Zone Edit"],
    scope: "zone:read",
  },
  {
    label: "DNS Edit",
    groups: ["DNS Write", "DNS Edit"],
    scope: "dns_records:edit",
  },
  {
    label: "Workers Routes Edit",
    groups: ["Workers Routes Write", "Workers Routes Edit"],
    scope: "workers_routes:write",
  },
]);

/** OAuth scopes `alchemy login` must request for a deployment with Portals. */
export const PORTAL_OAUTH_SCOPES = Object.freeze(
  PORTAL_PERMISSIONS.map(({ scope }) => scope),
);

export const ALCHEMY_OAUTH_RELOGIN =
  "rerun pnpm dx:deploy, which offers to sign in again, or run `ALCHEMY_CLOUDFLARE_OAUTH_EXTRA_SCOPES=dns_records:edit pnpm exec alchemy login --profile dx-selfhost --configure`, choose OAuth and the same account, and keep the default scopes";

/** The Portal OAuth scopes the Alchemy login was not granted. */
export const missingPortalOAuthScopes = (auth) =>
  auth.method === "alchemy-oauth"
    ? PORTAL_PERMISSIONS.filter(
        ({ scope }) => !(auth.scopes ?? []).includes(scope),
      )
    : [];

const cloudflareClient = (auth, request) => async (path) => {
  const response = await request(
    `https://api.cloudflare.com/client/v4${path}`,
    { headers: auth.headers },
  );
  const body = await response.json().catch(() => undefined);
  return {
    ok: response.ok && body?.success === true,
    status: response.status,
    result: body?.result,
    info: body?.result_info,
  };
};

// Whether a token policy's resources include `zoneId` in `accountId`.
const coversZone = (resources, { accountId, zoneId }) => {
  const zoneKeys = new Set([
    `com.cloudflare.api.account.zone.${zoneId}`,
    "com.cloudflare.api.account.zone.*",
  ]);
  const accountKeys = new Set([
    `com.cloudflare.api.account.${accountId}`,
    "com.cloudflare.api.account.*",
  ]);
  return Object.entries(resources ?? {}).some(([key, value]) => {
    if (zoneKeys.has(key)) return value === "*";
    if (!accountKeys.has(key)) return false;
    if (value === "*") return true;
    return (
      value !== null &&
      typeof value === "object" &&
      Object.entries(value).some(
        ([inner, access]) => zoneKeys.has(inner) && access === "*",
      )
    );
  });
};

/**
 * Which Portal permissions a token's policies grant on the zone. Deny
 * policies win over allow policies.
 */
export const portalPermissionsGranted = (policies, { accountId, zoneId }) => {
  const has = (permission, effect) =>
    (Array.isArray(policies) ? policies : []).some(
      (policy) =>
        policy?.effect === effect &&
        (policy.permission_groups ?? []).some((group) =>
          permission.groups.includes(group?.name),
        ) &&
        coversZone(policy.resources, { accountId, zoneId }),
    );
  return new Map(
    PORTAL_PERMISSIONS.map((permission) => [
      permission.label,
      has(permission, "allow") && !has(permission, "deny"),
    ]),
  );
};

// The calling API token's policies: account-owned tokens through the account
// endpoints (deployments already hold Account API Tokens), user tokens
// through the user endpoints. Undefined when the token cannot read itself.
const tokenPolicies = async (get, accountId) => {
  for (const base of [`/accounts/${accountId}/tokens`, "/user/tokens"]) {
    const verify = await get(`${base}/verify`);
    if (!verify.ok || typeof verify.result?.id !== "string") continue;
    const token = await get(`${base}/${verify.result.id}`);
    if (token.ok && Array.isArray(token.result?.policies))
      return token.result.policies;
  }
  return undefined;
};

const missingMessage = (permissions, domain, auth) =>
  permissions
    .map((label) =>
      auth.method === "alchemy-oauth"
        ? `The Alchemy Cloudflare login cannot use ${label} on the Portal zone ${domain}. Sign in again as a member who manages ${domain}: ${ALCHEMY_OAUTH_RELOGIN}.`
        : `The Cloudflare API token lacks ${label} on the Portal zone ${domain}. Add Zone → ${label.replace(/ (Read|Edit)$/, "")} → ${label.endsWith("Read") ? "Read" : "Edit"} for ${domain} to the token, then rerun.`,
    )
    .join("\n");

/**
 * Confirms, before anything is planned, that the Portal domain is the apex of
 * an active zone in the deployment account and that the credential can read
 * the zone and edit its DNS records and Worker routes. An API token is
 * probed with read calls those permissions allow and, when the token can
 * read its own policies, checked for Edit; Alchemy OAuth is checked for its
 * granted scopes. Returns the zone ID, and `editConfirmed: false` when Edit
 * could only be inferred from read access.
 */
export const preflightPortalZone = async ({
  auth,
  portalDomain,
  zoneId,
  fetch: request = globalThis.fetch,
}) => {
  const get = cloudflareClient(auth, request);
  const domain = portalDomain.toLowerCase();
  const missingScopes = missingPortalOAuthScopes(auth);
  if (missingScopes.length > 0)
    throw new Error(
      `${missingScopes
        .map(
          ({ label, scope }) =>
            `The Alchemy Cloudflare login was not granted ${scope}, needed for ${label} on the Portal zone ${domain}.`,
        )
        .join(
          "\n",
        )}\nSign in again with Portal access: ${ALCHEMY_OAUTH_RELOGIN}.`,
    );

  let zone;
  if (zoneId === undefined) {
    const zones = await get(
      `/zones?account.id=${auth.accountId}&name=${encodeURIComponent(domain)}`,
    );
    if (!zones.ok || !Array.isArray(zones.result) || zones.result.length === 0)
      throw new Error(
        `Zone ${domain} is not visible in Cloudflare account ${auth.accountId}. The Portal domain must be the apex of a zone in this account, and ${auth.method === "alchemy-oauth" ? "the Alchemy Cloudflare login" : "the Cloudflare API token"} needs Zone Read on it.`,
      );
    zone = zones.result.find((candidate) => candidate?.name === domain);
  } else {
    const response = await get(`/zones/${zoneId}`);
    if (!response.ok)
      throw new Error(
        missingMessage(["Zone Read"], `${domain} (${zoneId})`, auth),
      );
    zone = response.result;
  }
  if (
    zone?.name !== domain ||
    (zoneId !== undefined && zone?.id !== zoneId) ||
    zone?.account?.id !== auth.accountId
  )
    throw new Error(
      `Portal domain ${domain} must be the apex of its own zone in this Cloudflare account${zoneId === undefined ? "" : ` (zone ${zoneId})`}.`,
    );
  if (zone.status !== "active")
    throw new Error(
      `Portal zone ${domain} is ${zone.status ?? "not active"}; wait until Cloudflare shows it active, then rerun.`,
    );

  const [records, routes] = await Promise.all([
    get(`/zones/${zone.id}/dns_records?per_page=1`),
    get(`/zones/${zone.id}/workers/routes`),
  ]);
  const missing = [
    ...(records.ok ? [] : ["DNS Edit"]),
    ...(routes.ok ? [] : ["Workers Routes Edit"]),
  ];
  let editConfirmed = auth.method !== "api-token";
  if (missing.length === 0 && auth.method === "api-token") {
    const policies = await tokenPolicies(get, auth.accountId);
    if (policies !== undefined) {
      editConfirmed = true;
      const granted = portalPermissionsGranted(policies, {
        accountId: auth.accountId,
        zoneId: zone.id,
      });
      for (const [label, ok] of granted)
        if (!ok && label !== "Zone Read") missing.push(label);
    }
  }
  if (missing.length > 0)
    throw new Error(missingMessage(missing, domain, auth));
  return { zoneId: zone.id, editConfirmed };
};

/**
 * Active zones in the account that could serve Portals for an app at
 * `appDomain`, with what each already serves: the Portal route
 * `*.<zone>/*` takes over its proxied subdomains and the wildcard record
 * answers every unused name. `inUse` is undefined when the credential cannot
 * read a zone's records, routes, or Worker custom domains.
 */
export const listPortalZoneCandidates = async ({
  auth,
  appDomain,
  fetch: request = globalThis.fetch,
}) => {
  const get = cloudflareClient(auth, request);
  const zones = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await get(
      `/zones?account.id=${auth.accountId}&status=active&per_page=50&page=${page}`,
    );
    if (!response.ok)
      throw new Error(
        `Could not list this account's Cloudflare zones (${response.status}); the credential needs Zone Read.`,
      );
    zones.push(...(Array.isArray(response.result) ? response.result : []));
    if (page >= (response.info?.total_pages ?? 1)) break;
  }
  const eligible = zones.filter(
    (zone) =>
      typeof zone?.name === "string" &&
      typeof zone.id === "string" &&
      portalDomainProblem(zone.name, appDomain) === undefined,
  );
  return Promise.all(
    eligible.map(async ({ id, name }) => {
      const [records, routes, domains] = await Promise.all([
        get(`/zones/${id}/dns_records?per_page=1`),
        get(`/zones/${id}/workers/routes`),
        get(`/accounts/${auth.accountId}/workers/domains?zone_id=${id}`),
      ]);
      if (!records.ok || !routes.ok || !domains.ok)
        return { id, name, inUse: undefined };
      const dnsRecords =
        records.info?.total_count ??
        (Array.isArray(records.result) ? records.result.length : 0);
      const workerRoutes = Array.isArray(routes.result)
        ? routes.result.length
        : 0;
      const customDomains = Array.isArray(domains.result)
        ? domains.result.length
        : 0;
      return {
        id,
        name,
        inUse:
          dnsRecords + workerRoutes + customDomains === 0
            ? false
            : { dnsRecords, workerRoutes, customDomains },
      };
    }),
  );
};
