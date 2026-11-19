import {
  mailAuthenticated,
  mailHeaderAddresses,
  mailHeaderDisplayName,
  mailHtmlToText,
  mailMessageIds,
  mailRecipientOn,
  mailSpfAligned,
  newMailMessageId,
  parseMailHeaderBlock,
  type parseMailHeaders,
  readMailAuthentication,
} from "@dx/domain";
import PostalMime from "postal-mime";
import type { Bindings } from "../http/types.js";
import { mailLogger } from "../logging.js";
import { publishUserInvalidation } from "../realtime/publication.js";
import { autoLabelMail } from "./auto-labels.js";
import {
  type MailConfiguration,
  mailboxFeatureOn,
  mailConfiguration,
} from "./config.js";
import { handlePlusMail } from "./plus-inbound.js";
import {
  conversationKeyFor,
  findMailboxByUsername,
  insertMailItem,
  isPrivateSender,
  type MailboxOwner,
  operatorMailboxes,
  recentMailFrom,
  resolveProjectTag,
  type StoredMailParts,
} from "./store.js";

/**
 * Inbound mail (wiki/agent-mail.md). Cloudflare Email Routing sends every
 * address on the mail domain to the core Worker's `email` handler, which
 * calls this; `pnpm dev` feeds the same function from a dev-only route.
 *
 *   recipient on the mail domain?        no → drop
 *   postmaster@ / abuse@                 → the deployment admins' mailboxes
 *   username@ (current or retired name)  → that person's mailbox
 *   username+tag@                        → the same, labelled with the
 *                                          Project the tag names; from the
 *                                          owner, it may start or continue
 *                                          a Thread (plus-inbound.ts)
 *   anything else                        → drop
 *
 * Mail that fails authentication is kept in Spam, which agents never read.
 * Nothing is ever sent back but the one "Started" notice, so silence never
 * tells a sender which addresses or people exist.
 */

const HOUR_MS = 60 * 60 * 1_000;
/**
 * One sender's emails to one mailbox in an hour, at most: an untrusted
 * envelope sender, or a trusted From domain (which may send for many, such
 * as a service's notifications).
 */
const MAIL_PER_SENDER_PER_HOUR = { untrusted: 60, trusted: 200 } as const;
/**
 * All emails to one mailbox in an hour, at most: an envelope sender is the
 * sender's to choose, so this bounds a flood from rotating senders.
 */
const MAIL_PER_HOUR = 1_000;

/** Cloudflare Email Routing accepts messages up to 25 MiB. */
export const MAX_INBOUND_MAIL_BYTES = 25 * 1_024 * 1_024;

/** One message as the handler receives it. */
export interface InboundMail {
  /** The envelope sender (`MAIL FROM`). */
  readonly from: string;
  /** The envelope recipient this delivery is for. */
  readonly to: string;
  readonly raw: Uint8Array;
  /** Replies to the message; only the "started" notice uses it. */
  readonly reply: (message: {
    readonly from: string;
    readonly to: string;
    readonly raw: string;
  }) => Promise<void>;
  /** Refuses the message at SMTP time; used only when mail is off. */
  readonly setReject: (reason: string) => void;
}

export type InboundOutcome =
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "dropped"; readonly reason: string }
  | {
      readonly kind: "stored" | "spam";
      readonly mailId: string;
      readonly ownerUserId: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "started_thread" | "followed_up";
      readonly mailId: string;
      readonly ownerUserId: string;
      readonly threadId: string;
    };

/** A message parsed once, for every path below. */
export interface ParsedMail {
  readonly headers: ReturnType<typeof parseMailHeaders>;
  /** The header block parsed cleanly, within the size dx reads. */
  readonly headersClean: boolean;
  readonly header: (name: string) => string | undefined;
  readonly subject: string;
  readonly messageId: string | undefined;
  readonly inReplyTo: string | undefined;
  readonly references: string | undefined;
  readonly from: string;
  readonly parts: StoredMailParts;
  readonly preview: string;
}

const MAX_STORED_TEXT = 512 * 1_024;
const MAX_STORED_HTML = 2 * 1_024 * 1_024;

export const parseInboundMail = async (
  raw: Uint8Array,
): Promise<ParsedMail> => {
  // Header order matters for authentication; postal-mime keeps the parts.
  const headerBytes = raw.subarray(0, Math.min(raw.length, 256 * 1_024));
  const { headers, clean: headersClean } = parseMailHeaderBlock(
    new TextDecoder().decode(headerBytes),
  );
  const header = (name: string) =>
    headers.find((entry) => entry.name === name.toLowerCase())?.value;
  const email = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
  });
  const html = email.html?.slice(0, MAX_STORED_HTML);
  const text = (
    email.text?.trim()
      ? email.text
      : html === undefined
        ? ""
        : mailHtmlToText(html)
  ).slice(0, MAX_STORED_TEXT);
  const messageId = email.messageId?.trim().replace(/^<|>$/g, "") || undefined;
  return {
    headers,
    headersClean,
    header,
    subject: (email.subject ?? "").trim(),
    messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    from: header("from") ?? "",
    parts: {
      text,
      ...(html === undefined ? {} : { html }),
      attachments: email.attachments.map((attachment) => ({
        filename: attachment.filename ?? "attachment",
        mimeType: attachment.mimeType,
        size:
          typeof attachment.content === "string"
            ? attachment.content.length
            : attachment.content.byteLength,
      })),
    },
    preview: text.replace(/\s+/g, " ").trim().slice(0, 400),
  };
};

/**
 * A Message-ID dx can store and echo: within the column's limit and free of
 * whitespace, angle brackets, and control characters; undefined otherwise.
 */
export const safeMessageId = (value: string | undefined) => {
  const id = value?.trim().replace(/^<|>$/g, "");
  return id !== undefined &&
    id.length > 0 &&
    id.length <= 900 &&
    /^[\x21-\x7e]+$/.test(id) &&
    !/[<>]/.test(id)
    ? id
    : undefined;
};

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * Why a message cannot be trusted as its `From:` says, or undefined when it
 * can: one clean sender and Cloudflare's DMARC pass with aligned DKIM.
 */
export const mailDistrust = (parsed: ParsedMail, envelopeFrom: string) => {
  const repeated = ["from", "sender", "to", "cc", "subject", "message-id"].some(
    (name) =>
      parsed.headers.filter((header) => header.name === name).length > 1,
  );
  const from = mailHeaderAddresses(parsed.from);
  if (
    repeated ||
    !parsed.headersClean ||
    from.length !== 1 ||
    // No real envelope sender needs quotes, parentheses, `;`, or spaces; one
    // that has them could be echoed into Cloudflare's own results. `=` is
    // common (bulk senders' bounce addresses, such as `bounces+id-a=b.c@`)
    // and can't start a result there: those split on `;` and spaces.
    /["();\\\s]/.test(envelopeFrom)
  )
    return "header";
  const sender = parsed.header("sender");
  if (
    sender !== undefined &&
    (mailHeaderAddresses(sender).length !== 1 ||
      mailHeaderAddresses(sender)[0] !== from[0])
  )
    return "header";
  if (!mailAuthenticated(readMailAuthentication(parsed.headers), from[0] ?? ""))
    return "unauthenticated";
  return undefined;
};

/** Files one message in one person's mailbox. */
const deliver = async (
  bindings: Bindings,
  configuration: MailConfiguration,
  mail: InboundMail,
  parsed: ParsedMail,
  owner: MailboxOwner,
  tag: string | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<InboundOutcome> => {
  const db = bindings.DB as D1Database;
  const distrust = mailDistrust(parsed, mail.from);
  const trusted = distrust === undefined;
  // Trusted and untrusted mail have separate hourly caps, so a flood of
  // spam can never crowd out real mail such as a password reset.
  const fromHeader = mailHeaderAddresses(parsed.from);
  const sender =
    trusted && fromHeader.length === 1
      ? {
          fromDomain: (fromHeader[0] ?? "").slice(
            (fromHeader[0] ?? "").lastIndexOf("@") + 1,
          ),
        }
      : { envelopeFrom: mail.from };
  if (
    (await recentMailFrom(db, owner.userId, sender, HOUR_MS, trusted)) >=
      MAIL_PER_SENDER_PER_HOUR[trusted ? "trusted" : "untrusted"] ||
    (await recentMailFrom(db, owner.userId, undefined, HOUR_MS, trusted)) >=
      MAIL_PER_HOUR
  ) {
    mailLogger.info("Mail was dropped.", {
      event: "mail_dropped",
      reason: "rate_limit",
      ownerUserId: owner.userId,
    });
    return { kind: "dropped", reason: "rate_limit" };
  }
  const messageId =
    safeMessageId(parsed.messageId) ?? `sha256-${await sha256Hex(mail.raw)}@dx`;
  // The same message delivered twice, or to two of the person's addresses.
  // Only mail as trusted as this one counts, so a forged copy sent first
  // can't hide the real message.
  const seen = await db
    .prepare(
      `SELECT id FROM mail_item
        WHERE owner_user_id = ? AND message_id = ? AND direction = 'in'
          AND authenticated = ?`,
    )
    .bind(owner.userId, messageId, trusted ? 1 : 0)
    .first<string>("id");
  if (seen !== null) return { kind: "dropped", reason: "duplicate" };
  const project =
    tag === undefined
      ? undefined
      : await resolveProjectTag(db, owner.userId, tag);
  const from = mailHeaderAddresses(parsed.from);
  const fromAddress = from.length === 1 ? from[0] : undefined;
  const id = newMailMessageId();
  const references = [
    ...mailMessageIds(parsed.references),
    ...mailMessageIds(parsed.inReplyTo),
  ].flatMap((reference) => safeMessageId(reference) ?? []);
  // A reply to an email the person sent from dx, whose From domain doesn't
  // sign its mail (no DMARC with aligned DKIM) but whose server passed SPF
  // for that domain, goes to the Inbox. A forger would also need the
  // Message-ID of the person's email, which only its recipients saw. It
  // stays unauthenticated: agents and the `+tag` gate still see that.
  const answersSent =
    distrust === "unauthenticated" &&
    fromAddress !== undefined &&
    references.length > 0 &&
    mailSpfAligned(readMailAuthentication(parsed.headers), fromAddress) &&
    (await db
      .prepare(
        `SELECT 1 AS found FROM mail_item
          WHERE owner_user_id = ? AND direction = 'out'
            AND message_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
      )
      .bind(owner.userId, JSON.stringify(references))
      .first<number>("found")) !== null;
  const inbox = trusted || answersSent;
  // Spam is its own conversation: its Message-ID and References are the
  // sender's to forge.
  const conversationKey = inbox
    ? await conversationKeyFor(db, owner.userId, messageId, references)
    : id;
  // A reply in a conversation the person marked private stays private.
  const privateMail =
    (await isPrivateSender(db, owner.userId, fromAddress)) ||
    (await db
      .prepare(
        "SELECT 1 AS found FROM mail_item WHERE owner_user_id = ? AND conversation_key = ? AND private = 1 LIMIT 1",
      )
      .bind(owner.userId, conversationKey)
      .first<number>("found")) !== null;
  await insertMailItem(
    bindings,
    {
      id,
      owner_user_id: owner.userId,
      direction: "in",
      folder: inbox ? "inbox" : "spam",
      tag: project?.tag ?? null,
      project_id: project?.projectId ?? null,
      private: privateMail ? 1 : 0,
      read_at: null,
      received_at: new Date().toISOString(),
      header_from: parsed.from,
      from_address: fromAddress ?? null,
      envelope_from: mail.from,
      rcpt_to: mail.to,
      to_addresses: JSON.stringify(
        mailHeaderAddresses(parsed.header("to") ?? ""),
      ),
      cc_addresses: JSON.stringify(
        mailHeaderAddresses(parsed.header("cc") ?? ""),
      ),
      subject: parsed.subject,
      message_id: messageId,
      conversation_key: conversationKey,
      dmarc: readMailAuthentication(parsed.headers).dmarc ?? null,
      authenticated: trusted ? 1 : 0,
      size: mail.raw.byteLength,
      has_attachments: parsed.parts.attachments.length > 0 ? 1 : 0,
      preview: parsed.preview,
      // A reply the Inbox took on SPF is the only unauthenticated mail stored
      // as `stored` (a person's "Not spam" keeps its `spam_*` reason).
      disposition: inbox ? "stored" : `spam_${distrust}`,
      thread_id: null,
    },
    { raw: mail.raw, parts: parsed.parts },
  );
  mailLogger.info("Mail reached a mailbox.", {
    event: "mail_stored",
    ownerUserId: owner.userId,
    mailId: id,
    tagged: project !== undefined,
    spam: !inbox,
    replyTrust: answersSent,
    size: mail.raw.byteLength,
  });
  let outcome: InboundOutcome = {
    kind: inbox ? "stored" : "spam",
    mailId: id,
    ownerUserId: owner.userId,
    ...(trusted ? {} : { reason: answersSent ? "reply" : distrust }),
  };
  // Only the owner's own email to their `+tag` can start work.
  if (
    project !== undefined &&
    fromAddress !== undefined &&
    owner.emailVerified &&
    fromAddress === owner.email.toLowerCase()
  )
    outcome = await handlePlusMail(bindings, configuration, {
      mail,
      parsed,
      owner,
      mailId: id,
      messageId,
      projectId: project.projectId,
      tag: project.tag,
      senderName: mailHeaderDisplayName(parsed.from) ?? owner.name,
      waitUntil,
    });
  await publishUserInvalidation(
    bindings,
    owner.userId as never,
    "mailbox.invalidated",
  );
  if (outcome.kind === "stored")
    waitUntil(autoLabelMail(bindings, owner.userId, id, parsed));
  return outcome;
};

export const handleInboundMail = async (
  bindings: Bindings,
  mail: InboundMail,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<InboundOutcome> => {
  const configuration = mailConfiguration(bindings);
  if (configuration === undefined || bindings.DB === undefined) {
    mail.setReject("This server does not accept mail.");
    return { kind: "rejected", reason: "mail_off" };
  }
  const drop = (reason: string, detail?: Record<string, unknown>) => {
    mailLogger.info("Mail was dropped.", {
      event: "mail_dropped",
      reason,
      ...detail,
    });
    return { kind: "dropped", reason } as const;
  };
  if (mail.raw.byteLength > MAX_INBOUND_MAIL_BYTES) return drop("too_large");
  const recipient = mailRecipientOn(mail.to, configuration.domain);
  if (recipient === undefined) return drop("unknown_recipient");
  // Only people who turned the Mailbox on (a beta flag) receive mail.
  const db = bindings.DB;
  const withMailbox = async <T extends { readonly userId: string }>(
    person: T | undefined,
  ) =>
    person !== undefined && (await mailboxFeatureOn(db, person.userId))
      ? person
      : undefined;
  const operators = (
    await Promise.all(
      (await operatorMailboxes(bindings, recipient.username)).map(withMailbox),
    )
  ).flatMap((operator) => (operator === undefined ? [] : [operator]));
  // Reserved names, `postmaster` and `abuse` included, name no person.
  const owner = await withMailbox(
    await findMailboxByUsername(bindings.DB, recipient.username),
  );
  if (operators.length === 0 && owner === undefined)
    return drop("unknown_recipient");
  let parsed: ParsedMail;
  try {
    parsed = await parseInboundMail(mail.raw);
  } catch (cause) {
    return drop("unparseable", { cause });
  }
  if (owner !== undefined)
    return deliver(
      bindings,
      configuration,
      mail,
      parsed,
      owner,
      recipient.tag,
      waitUntil,
    );
  let last: InboundOutcome = { kind: "dropped", reason: "unknown_recipient" };
  for (const operator of operators)
    last = await deliver(
      bindings,
      configuration,
      mail,
      parsed,
      operator,
      undefined,
      waitUntil,
    );
  return last;
};

/** Reads a delivery's raw stream, refusing anything past the size cap. */
export const readRawMail = async (
  stream: ReadableStream<Uint8Array>,
  max = MAX_INBOUND_MAIL_BYTES,
): Promise<Uint8Array | undefined> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
};
