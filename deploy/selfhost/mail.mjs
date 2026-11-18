/**
 * The dx Mailbox's mail domain (wiki/agent-mail.md): what an operator takes
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
    `dx Mailbox: every person's address is username@${domain}. Before you keep this domain, know that:`,
    `  - Only dx receives mail at @${domain}. Cloudflare Email Routing's catch-all sends every address there to dx, so any other mailbox or forwarding on it stops working, and people can pick usernames such as "sales" or "support".`,
    `  - Its reputation is shared. People send email from their Mailbox as @${domain}, so spam complaints or abuse lower this domain's standing with Gmail, Outlook and others, for every message sent from it${shared ? `, including the app's own sign-in email from ${app}` : ""}.`,
    `  - DMARC becomes strict. dx publishes "p=reject" for ${domain} and its subdomains, replacing any DMARC record there, so receivers reject mail from any other service that sends as these addresses without its own aligned DKIM signature.`,
    "  - Turning mail off later removes Email Routing, Email Sending, and that DMARC record from the zone.",
    "  A domain used for nothing else avoids all of this.",
  ];
};
