/**
 * Whether an inbound message really came from its `From:` address, read
 * from the authentication results Cloudflare Email Routing adds when it
 * accepts the message (wiki/agent-mail.md#project-addresses-the-gate).
 *
 * Email Routing validates DMARC before it invokes the Worker and prepends a
 * standard `Authentication-Results` header (RFC 8601) above the sender's.
 * As Cloudflare documents, only the first such header is trusted, and only
 * when Cloudflare's server (`mx.cloudflare.net`) wrote it; any other one may
 * have been supplied by the sender.
 * https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
 */

export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export interface MailHeader {
  readonly name: string;
  readonly value: string;
}

export interface MailAuthentication {
  /** Whether the topmost authentication header is Cloudflare's own. */
  readonly trusted: boolean;
  /** `pass`, `fail`, `none`, …, or undefined when absent or untrusted. */
  readonly dmarc: string | undefined;
  /** The `From:` domain Cloudflare evaluated DMARC for. */
  readonly dmarcHeaderFrom: string | undefined;
  /** Domains of DKIM signatures that passed, from the trusted header. */
  readonly dkimPassDomains: ReadonlyArray<string>;
  /** Envelope (`smtp.mailfrom`) domains whose SPF check passed. */
  readonly spfPassDomains: ReadonlyArray<string>;
}

/**
 * The message's header block in order, unfolded. Stops at the first empty
 * line; a header that does not parse ends the block.
 */
export const parseMailHeaders = (raw: string): ReadonlyArray<MailHeader> =>
  parseMailHeaderBlock(raw).headers;

/**
 * The header block and whether it parsed cleanly: it ends at an empty line
 * and every line in it is a header or a continuation. A block that does
 * not may hide headers from dx that another reader (Cloudflare, a DKIM
 * verifier) still sees, so security checks refuse it.
 */
export const parseMailHeaderBlock = (
  raw: string,
): { readonly headers: ReadonlyArray<MailHeader>; readonly clean: boolean } => {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end < 0 ? raw : raw.slice(0, end);
  const headers: MailHeader[] = [];
  let clean = end >= 0;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1];
      if (last !== undefined)
        headers[headers.length - 1] = {
          name: last.name,
          value: `${last.value} ${line.trim()}`,
        };
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0 || !/^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, colon))) {
      clean = false;
      break;
    }
    headers.push({
      name: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    });
  }
  return { headers, clean };
};

/**
 * Whether every DKIM signature aligned with the `From:` domain whose domain
 * passed in Cloudflare's results signs the named header (lists it in `h=`),
 * and at least one exists. Requiring every one means a forged extra
 * signature cannot help an attacker: only headers the sender's own signer
 * covered can be trusted not to have been changed.
 */
export const dkimSignsHeader = (
  headers: ReadonlyArray<MailHeader>,
  authentication: MailAuthentication,
  fromDomain: string,
  headerName: string,
) => {
  const passed = authentication.trusted
    ? authentication.dkimPassDomains.filter((signer) =>
        dkimAligned(fromDomain, signer),
      )
    : [];
  const aligned = headers
    .filter(({ name }) => name === "dkim-signature")
    .map(({ value }) => {
      const tags = new Map(
        value
          .split(";")
          .map((tag) => tag.replace(/\s+/g, ""))
          .flatMap((tag) => {
            const equals = tag.indexOf("=");
            return equals <= 0
              ? []
              : [[tag.slice(0, equals).toLowerCase(), tag.slice(equals + 1)]];
          }) as Array<[string, string]>,
      );
      return {
        domain: (tags.get("d") ?? "").toLowerCase().replace(/\.$/, ""),
        signed: (tags.get("h") ?? "")
          .toLowerCase()
          .split(":")
          .filter((name) => name.length > 0),
      };
    })
    .filter(({ domain }) => passed.includes(domain));
  return (
    aligned.length > 0 &&
    aligned.every(({ signed }) => signed.includes(headerName.toLowerCase()))
  );
};

/** Removes RFC 5322 comments in parentheses, which may nest. */
const withoutComments = (value: string) => {
  let out = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += character;
  }
  return out;
};

/**
 * Splits an Authentication-Results value into its `;`-separated parts per
 * RFC 8601: comments are dropped and quoted strings are opaque, so a `;`,
 * `(` or `)` inside a quoted envelope address (which Cloudflare repeats in
 * `smtp.mailfrom` and its SPF comment) never starts or ends a result.
 * Inside a comment, a quoted string is opaque too, so a quoted `)` cannot
 * close the comment early.
 */
const authenticationParts = (value: string) => {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index] ?? "";
    if (quoted) {
      if (character === "\\") {
        if (depth === 0) current += value.slice(index, index + 2);
        index++;
        continue;
      }
      if (character === '"') quoted = false;
      if (depth === 0) current += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      if (depth === 0) current += character;
    } else if (character === "\\" && depth > 0) index++;
    else if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (character === ";") {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

/** `ptype.property=value` pairs of one result, quotes removed. */
const resultProperties = (tokens: ReadonlyArray<string>) => {
  const properties = new Map<string, string>();
  for (const token of tokens) {
    const pair = /^([a-z0-9.-]+)=(.*)$/i.exec(token);
    if (pair?.[1] === undefined || pair[2] === undefined) continue;
    const value = pair[2].replace(/^"(.*)"$/, "$1").toLowerCase();
    if (!properties.has(pair[1].toLowerCase()))
      properties.set(pair[1].toLowerCase(), value);
  }
  return properties;
};

export const readMailAuthentication = (
  headers: ReadonlyArray<MailHeader>,
): MailAuthentication => {
  const untrusted = {
    trusted: false,
    dmarc: undefined,
    dmarcHeaderFrom: undefined,
    dkimPassDomains: [],
    spfPassDomains: [],
  } as const;
  const top = headers.find(({ name }) => name === "authentication-results");
  if (top === undefined) return untrusted;
  const parts = authenticationParts(top.value);
  const authserv = (parts.shift() ?? "").split(/\s+/)[0]?.toLowerCase();
  if (authserv !== CLOUDFLARE_AUTHSERV_ID) return untrusted;
  let dmarc: string | undefined;
  let dmarcHeaderFrom: string | undefined;
  const dkimPassDomains: string[] = [];
  const spfPassDomains: string[] = [];
  for (const part of parts) {
    // A result starts with `method=result`; the rest are its properties.
    const tokens = part
      .replace(/\s*=\s*/g, "=")
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const method = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0] ?? "");
    if (method === null) continue;
    const name = method[1]?.toLowerCase();
    const result = method[2]?.toLowerCase();
    const properties = resultProperties(tokens.slice(1));
    if (name === "dmarc" && dmarc === undefined) {
      dmarc = result;
      dmarcHeaderFrom = properties.get("header.from")?.replace(/\.$/, "");
    }
    if (name === "spf" && result === "pass") {
      const mailFrom = properties.get("smtp.mailfrom")?.replace(/\.$/, "");
      const domain = mailFrom
        ?.slice(mailFrom.lastIndexOf("@") + 1)
        .toLowerCase();
      if (domain !== undefined && /^[a-z0-9.-]+$/.test(domain))
        spfPassDomains.push(domain);
    }
    if (name === "dkim" && result === "pass") {
      const domain = properties.get("header.d")?.replace(/\.$/, "");
      if (domain !== undefined && /^[a-z0-9.-]+$/.test(domain))
        dkimPassDomains.push(domain);
    }
  }
  return {
    trusted: true,
    dmarc,
    dmarcHeaderFrom,
    dkimPassDomains,
    spfPassDomains,
  };
};

/**
 * A DKIM signature's domain aligns with the `From:` domain when they are
 * the same or the `From:` domain is under it (relaxed alignment). A
 * signature for a public suffix cannot pass: its key would have to be
 * published there.
 */
export const dkimAligned = (fromDomain: string, dkimDomain: string) => {
  const from = fromDomain.toLowerCase().replace(/\.$/, "");
  const signer = dkimDomain.toLowerCase().replace(/\.$/, "");
  return (
    signer.includes(".") && (from === signer || from.endsWith(`.${signer}`))
  );
};

/** DMARC passed and a passing DKIM signature aligns with `From:`. */
export const mailAuthenticated = (
  authentication: MailAuthentication,
  fromAddress: string,
) => {
  const domain = fromAddress
    .slice(fromAddress.lastIndexOf("@") + 1)
    .toLowerCase();
  return (
    authentication.trusted &&
    authentication.dmarc === "pass" &&
    domain.length > 0 &&
    // DMARC was evaluated for this From: domain, not another one.
    authentication.dmarcHeaderFrom === domain &&
    authentication.dkimPassDomains.some((signer) => dkimAligned(domain, signer))
  );
};

/**
 * SPF passed for an envelope domain aligned with `From:` (relaxed): the mail
 * came through a server the From domain allows. Weaker than DMARC with
 * aligned DKIM: such mail reaches the Inbox marked unverified (`mailTrust`
 * in inbound.ts).
 */
export const mailSpfAligned = (
  authentication: MailAuthentication,
  fromAddress: string,
) => {
  const domain = fromAddress
    .slice(fromAddress.lastIndexOf("@") + 1)
    .toLowerCase();
  return (
    authentication.trusted &&
    domain.length > 0 &&
    authentication.spfPassDomains.some((envelope) =>
      dkimAligned(domain, envelope),
    )
  );
};

/**
 * The addresses in a header such as `From:` or `Sender:`, lowercased:
 * `Name <a@b>` and bare `a@b`, comma-separated, quoted names skipped.
 */
export const mailHeaderAddresses = (value: string): ReadonlyArray<string> => {
  const unquoted = withoutComments(value.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
  const addresses: string[] = [];
  for (const part of unquoted.split(",")) {
    const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(part);
    const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(part);
    const address = angle?.[1] ?? bare?.[1];
    if (address !== undefined) addresses.push(address.trim().toLowerCase());
  }
  return addresses;
};

/** The display name in a `From:` header, if it has one. */
export const mailHeaderDisplayName = (value: string) => {
  const quoted = /^\s*"((?:[^"\\]|\\.)*)"\s*</.exec(value)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1").trim();
  const plain = /^\s*([^<"]+?)\s*</.exec(value)?.[1];
  return plain?.trim() || undefined;
};

/** Message-IDs in an `In-Reply-To` or `References` header, in order. */
export const mailMessageIds = (value: string | undefined) =>
  [...(value ?? "").matchAll(/<([^<>\s]{1,996})>/g)].map(
    (match) => match[1] ?? "",
  );
