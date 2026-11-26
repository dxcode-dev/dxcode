/**
 * The dx Mail's mail domain (wiki/agent-mail.md): what an operator takes
 * on by giving dx a domain's mail. Any zone apex works, the app's own domain
 * or one it lives under included; the deploy shows these trade-offs instead
 * of refusing, so an operator can choose with them in view.
 */

/** Why a mail domain cannot work, or undefined when it can. */
export const mailDomainProblem = (domain) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    domain,
  )
    ? undefined
    : "is not a domain name";

/**
 * The trade-offs of giving dx this domain's mail, as lines for the deploy's
 * summary, most important first.
 */
export const mailDomainTradeoffs = ({ domain, appHostname }) => {
  const app = appHostname?.toLowerCase();
  const shared =
    app !== undefined && (app === domain || app.endsWith(`.${domain}`));
  return [
    `dx Mail: every person's address is username@${domain}. Before you keep this domain, know that:`,
    `  - Only dx receives mail at @${domain}. Cloudflare Email Routing's catch-all sends every address there to dx, so any other mailbox or forwarding on it stops working, and people can pick usernames such as "sales" or "support".`,
    `  - Its reputation is shared. People send email from their Mail as @${domain}, so spam complaints or abuse lower this domain's standing with Gmail, Outlook and others, for every message sent from it${shared ? `, including the app's own sign-in email from ${app}` : ""}.`,
    `  - DMARC becomes strict. dx publishes "p=reject" for ${domain} and its subdomains, replacing any DMARC record there, so receivers reject mail from any other service that sends as these addresses without its own aligned DKIM signature.`,
    "  - Turning mail off later removes Email Routing and Email Sending from the zone. It keeps the DMARC record: delete it yourself before another service sends as this domain.",
    "  A domain used for nothing else avoids all of this.",
  ];
};

/**
 * The Cloudflare permissions a mail zone needs, as an API token's permission
 * groups (the dashboard says Edit, the API says Write) and as Alchemy OAuth
 * scopes. Email Routing's on/off switch is a zone setting.
 */
export const MAIL_PERMISSIONS = Object.freeze([
  { label: "Zone Read", scope: "zone.read" },
  { label: "DNS Edit", scope: "dns.write" },
  { label: "Zone Settings Edit", scope: "zone-settings.write" },
  { label: "Email Routing Rules Edit", scope: "email-routing-rule.write" },
  { label: "Email Sending Edit", scope: "email-sending.write" },
]);

/** OAuth scopes the Alchemy login must request for a deployment with mail. */
export const MAIL_OAUTH_SCOPES = Object.freeze(
  MAIL_PERMISSIONS.map(({ scope }) => scope),
);

const ALCHEMY_OAUTH_RELOGIN =
  "rerun pnpm dx:deploy -- --mail, which offers to sign in again with mail access";

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

const credential = (auth) =>
  auth.method === "alchemy-oauth"
    ? "the Alchemy Cloudflare login"
    : "the Cloudflare API token";

/**
 * Finds the mail domain's zone and confirms, before anything is planned, that
 * it is the apex of an active zone in the deployment account and that the
 * credential can read its DNS, Email Routing, and Email Sending. The zone ID
 * is looked up from the domain when none is given. Edit access is confirmed
 * at apply, as for Portals: an API token cannot always read its own policies.
 */
export const preflightMailZone = async ({
  auth,
  mailDomain,
  zoneId,
  fetch: request = globalThis.fetch,
}) => {
  const get = cloudflareClient(auth, request);
  const domain = mailDomain.toLowerCase();
  if (auth.method === "alchemy-oauth") {
    const missing = MAIL_PERMISSIONS.filter(
      ({ scope }) => !(auth.scopes ?? []).includes(scope),
    );
    if (missing.length > 0)
      throw new Error(
        `The Alchemy Cloudflare login was not granted ${missing.map(({ scope }) => scope).join(", ")}, needed for the dx Mail on ${domain}. Sign in again with mail access: ${ALCHEMY_OAUTH_RELOGIN}.`,
      );
  }
  let zone;
  if (zoneId === undefined) {
    const zones = await get(
      `/zones?account.id=${auth.accountId}&name=${encodeURIComponent(domain)}`,
    );
    zone = Array.isArray(zones.result)
      ? zones.result.find((candidate) => candidate?.name === domain)
      : undefined;
    if (!zones.ok || zone === undefined)
      throw new Error(
        `${domain} is not a zone in Cloudflare account ${auth.accountId}. The mail domain must be a zone's own domain (not a subdomain: Cloudflare's catch-all works only there), and ${credential(auth)} needs Zone Read on it.`,
      );
  } else {
    const response = await get(`/zones/${zoneId}`);
    if (!response.ok)
      throw new Error(
        `${credential(auth)} cannot read the mail zone ${domain} (${zoneId}); it needs Zone Read.`,
      );
    zone = response.result;
  }
  if (
    zone?.name !== domain ||
    (zoneId !== undefined && zone?.id !== zoneId) ||
    zone?.account?.id !== auth.accountId
  )
    throw new Error(
      `The mail domain ${domain} must be the name of its own zone in this Cloudflare account${zoneId === undefined ? "" : ` (zone ${zoneId})`}: Cloudflare's catch-all works only on a zone's own domain.`,
    );
  if (zone.status !== "active")
    throw new Error(
      `Mail zone ${domain} is ${zone.status ?? "not active"}; wait until Cloudflare shows it active, then rerun.`,
    );
  const [records, routing, sending] = await Promise.all([
    get(`/zones/${zone.id}/dns_records?per_page=1`),
    get(`/zones/${zone.id}/email/routing`),
    get(`/zones/${zone.id}/email/sending/subdomains`),
  ]);
  const missing = [
    ...(records.ok ? [] : ["DNS Edit"]),
    ...(routing.ok ? [] : ["Zone Settings Edit and Email Routing Rules Edit"]),
    ...(sending.ok ? [] : ["Email Sending Edit"]),
  ];
  if (missing.length > 0)
    throw new Error(
      missing
        .map((label) =>
          auth.method === "alchemy-oauth"
            ? `The Alchemy Cloudflare login cannot use ${label} on the mail zone ${domain}: ${ALCHEMY_OAUTH_RELOGIN}.`
            : `The Cloudflare API token lacks ${label} on the mail zone ${domain}. Add it for ${domain}, then rerun.`,
        )
        .join("\n"),
    );
  return { zoneId: zone.id };
};

/**
 * Active zones in the account that could be the mail domain, with whether
 * each already handles mail (MX records, Email Routing, or Email Sending),
 * which giving it to dx would take over. `mail` is undefined when the
 * credential cannot read a zone's records or email settings.
 */
export const listMailZoneCandidates = async ({
  auth,
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
  return Promise.all(
    zones
      .filter(
        (zone) =>
          typeof zone?.name === "string" &&
          typeof zone.id === "string" &&
          mailDomainProblem(zone.name) === undefined,
      )
      .map(async ({ id, name }) => {
        const [mx, routing, sending] = await Promise.all([
          get(`/zones/${id}/dns_records?type=MX&per_page=50`),
          get(`/zones/${id}/email/routing`),
          get(`/zones/${id}/email/sending/subdomains`),
        ]);
        if (!mx.ok || !routing.ok || !sending.ok)
          return { id, name, mail: undefined };
        const mxRecords = (Array.isArray(mx.result) ? mx.result : []).filter(
          (record) => record?.name === name,
        ).length;
        const routingOn = routing.result?.enabled === true;
        const sendingOn = (
          Array.isArray(sending.result) ? sending.result : []
        ).some((subdomain) => subdomain?.name === name);
        return {
          id,
          name,
          mail:
            mxRecords === 0 && !routingOn && !sendingOn
              ? false
              : { mxRecords, routingOn, sendingOn },
        };
      }),
  );
};
