// Whether a Portal domain would share a site with the dx app. Browsers group
// hosts into sites by registrable domain (eTLD+1, by the Public Suffix List
// including its private section). A Portal host on the app's site could set
// `Domain=<registrable domain>` cookies dx reads (login CSRF, session
// fixation) and would count as same-site for dx's SameSite=Lax cookies, so
// Core, alchemy.run.ts, and the deploy runner all refuse such a domain.
//
// Kept free of Worker APIs: the deploy scripts import it too.

import { getDomain } from "tldts";

const site = (hostname: string) =>
  getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;

/**
 * True when a Portal host under `portalDomain` would be same-site with
 * `appHostname`, or either contains the other. A Portal domain that is itself
 * on the Public Suffix List gives every Portal host its own site.
 */
export const portalDomainSharesSite = (
  appHostname: string,
  portalDomain: string,
) => {
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
