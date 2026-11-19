import type { SendMailRequest } from "@dx/api";
import {
  mailboxAddress,
  mailHeaderAddresses,
  newMailMessageId,
} from "@dx/domain";
import PostalMime from "postal-mime";
import type { Bindings } from "../http/types.js";
import { mailLogger } from "../logging.js";
import { publishUserInvalidation } from "../realtime/publication.js";
import { type MailConfiguration, mailSender } from "./config.js";
import { safeMessageId } from "./inbound.js";
import {
  conversationKeyFor,
  insertMailItem,
  type MailboxOwner,
  readMailboxSetting,
  readMailItem,
  readMailRaw,
  usernameNeedsPick,
} from "./store.js";

/**
 * Mail the person sends from their Mail (wiki/agent-mail.md#mail-the-user-sends).
 * Only the signed-in person, from the Mail page; never an API key, an
 * app, a plugin, or an agent. Always from their own address.
 */

export const SEND_LIMITS = {
  perDay: 100,
  recipients: 20,
  attachmentBytes: 10 * 1_024 * 1_024,
  /** Sending turns on this long after sign-up. */
  accountAgeMs: 24 * 60 * 60 * 1_000,
  /** Failed sends in a day that pause sending. */
  failuresPerDay: 10,
} as const;

const DAY_MS = 24 * 60 * 60 * 1_000;

export class MailSendRefused extends Error {
  constructor(
    readonly code:
      | "MAIL_SENDING_BLOCKED"
      | "MAIL_SEND_LIMIT"
      | "MAIL_SEND_FAILED"
      | "MAIL_INVALID_REQUEST"
      | "MAIL_USERNAME_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

/** Sends today that used up the daily limit: sent or still in flight. */
export const sentToday = async (db: D1Database, userId: string) =>
  (await db
    .prepare(
      `SELECT count(*) AS count FROM mail_send_log
        WHERE user_id = ? AND outcome != 'failed' AND at > ?`,
    )
    .bind(userId, new Date(Date.now() - DAY_MS).toISOString())
    .first<number>("count")) ?? 0;

const failuresToday = async (db: D1Database, userId: string) =>
  (await db
    .prepare(
      `SELECT count(*) AS count FROM mail_send_log
        WHERE user_id = ? AND outcome = 'failed' AND at > ?`,
    )
    .bind(userId, new Date(Date.now() - DAY_MS).toISOString())
    .first<number>("count")) ?? 0;

/**
 * Reserves one of today's sends in a single statement, so parallel sends
 * can't pass the limit together. Returns the reservation, or undefined when
 * the day's sends are used up.
 */
const reserveSend = async (db: D1Database, userId: string) => {
  const id = crypto.randomUUID();
  const now = new Date();
  const result = await db
    .prepare(
      `INSERT INTO mail_send_log (id, user_id, at, outcome)
       SELECT ?, ?, ?, 'pending'
        WHERE (SELECT count(*) FROM mail_send_log
                WHERE user_id = ? AND outcome != 'failed' AND at > ?) < ?`,
    )
    .bind(
      id,
      userId,
      now.toISOString(),
      userId,
      new Date(now.getTime() - DAY_MS).toISOString(),
      SEND_LIMITS.perDay,
    )
    .run();
  return result.meta.changes === 1 ? id : undefined;
};

const settleSend = (
  db: D1Database,
  id: string,
  outcome: "sent" | "failed",
  reason?: string,
) =>
  db
    .prepare("UPDATE mail_send_log SET outcome = ?, reason = ? WHERE id = ?")
    .bind(outcome, reason?.slice(0, 500) ?? null, id)
    .run();

/** Why this person cannot send now, in words they read; undefined: they can. */
export const sendingBlockedReason = async (
  bindings: Bindings,
  owner: MailboxOwner,
  now = Date.now(),
): Promise<string | undefined> => {
  const db = bindings.DB as D1Database;
  if (mailSender(bindings) === undefined)
    return "This dx deployment doesn't send email yet.";
  if (usernameNeedsPick(owner.username)) return "Pick your username first.";
  if (!owner.emailVerified) return "Verify your sign-in email to send email.";
  const created = Date.parse(owner.createdAt);
  if (Number.isFinite(created) && now - created < SEND_LIMITS.accountAgeMs)
    return "Sending turns on 24 hours after you sign up.";
  const setting = await readMailboxSetting(db, owner.userId);
  if (setting.sending_suspended_at !== null)
    return "An admin paused sending for your account.";
  if ((await failuresToday(db, owner.userId)) >= SEND_LIMITS.failuresPerDay)
    return "Sending is paused for a day: too many emails could not be delivered.";
  return undefined;
};

const ADDRESS = /^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const base64Bytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const encodeHeader = (text: string) =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${toBase64(new TextEncoder().encode(text))}?=`;

/** The sent email as MIME, kept in the person's Sent folder. */
const sentCopy = (input: {
  readonly from: string;
  readonly fromName: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string;
  readonly messageId: string;
  readonly headers: Record<string, string>;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }>;
}) => {
  const boundary = `dx-${crypto.randomUUID()}`;
  const head = [
    `From: ${encodeHeader(input.fromName)} <${input.from}>`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length === 0 ? [] : [`Cc: ${input.cc.join(", ")}`]),
    `Subject: ${encodeHeader(input.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    ...Object.entries(input.headers).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    "MIME-Version: 1.0",
  ];
  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(new TextEncoder().encode(input.text)).replace(/.{76}/g, "$&\r\n"),
  ];
  if (input.attachments.length === 0)
    return `${[...head, ...textPart].join("\r\n")}\r\n`;
  return `${[
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    ...input.attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType.replace(/[\r\n"]/g, "")}`,
      `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename.replace(/["\r\n]/g, ""))}"`,
      "Content-Transfer-Encoding: base64",
      "",
      toBase64(attachment.bytes).replace(/.{76}/g, "$&\r\n"),
    ]),
    `--${boundary}--`,
  ].join("\r\n")}\r\n`;
};

/** Sends one email as the person and keeps it in Sent. */
export const sendMail = async (
  bindings: Bindings,
  configuration: MailConfiguration,
  owner: MailboxOwner,
  request: SendMailRequest,
) => {
  const db = bindings.DB as D1Database;
  const blocked = await sendingBlockedReason(bindings, owner);
  if (blocked !== undefined)
    throw new MailSendRefused("MAIL_SENDING_BLOCKED", blocked);
  const clean = (list: ReadonlyArray<string> | undefined) =>
    (list ?? []).map((address) => address.trim()).filter((a) => a.length > 0);
  const to = clean(request.to);
  const cc = clean(request.cc);
  const bcc = clean(request.bcc);
  const all = [...to, ...cc, ...bcc];
  if (to.length === 0)
    throw new MailSendRefused(
      "MAIL_INVALID_REQUEST",
      "Add at least one recipient.",
    );
  const invalid = all.find((address) => !ADDRESS.test(address));
  if (invalid !== undefined)
    throw new MailSendRefused(
      "MAIL_INVALID_REQUEST",
      `${invalid} is not an email address.`,
    );
  if (all.length > SEND_LIMITS.recipients)
    throw new MailSendRefused(
      "MAIL_SEND_LIMIT",
      `An email can go to at most ${SEND_LIMITS.recipients} people.`,
    );
  const attachments = (request.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType || "application/octet-stream",
    bytes: base64Bytes(attachment.contentBase64),
  }));
  // A forward carries the original email's attachments, from the person's
  // own stored copy; they count toward the size limit.
  if (request.forwardOf !== undefined) {
    const original = await readMailItem(db, owner.userId, request.forwardOf);
    if (original === null)
      throw new MailSendRefused(
        "MAIL_INVALID_REQUEST",
        "The email you're forwarding was not found.",
      );
    const raw =
      original.has_attachments === 1
        ? await readMailRaw(bindings, original)
        : undefined;
    if (raw !== undefined)
      for (const attachment of (
        await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" })
      ).attachments)
        attachments.push({
          filename: attachment.filename ?? "attachment",
          mimeType: attachment.mimeType || "application/octet-stream",
          bytes: new Uint8Array(attachment.content as ArrayBuffer),
        });
  }
  if (
    attachments.reduce((total, { bytes }) => total + bytes.byteLength, 0) >
    SEND_LIMITS.attachmentBytes
  )
    throw new MailSendRefused(
      "MAIL_SEND_LIMIT",
      "Attachments can be at most 10 MB in total.",
    );
  // From: always the person's own address, or one of their `+tag`s.
  let fromTag: string | undefined;
  let fromTagProject: string | undefined;
  if (request.fromTag !== undefined) {
    const owned = await db
      .prepare(
        "SELECT tag, project_id FROM mailbox_project_tag WHERE user_id = ? AND tag = ?",
      )
      .bind(owner.userId, request.fromTag)
      .first<{ tag: string; project_id: string }>();
    if (owned === null)
      throw new MailSendRefused(
        "MAIL_INVALID_REQUEST",
        "That address isn't one of yours.",
      );
    fromTag = owned.tag;
    fromTagProject = owned.project_id;
  }
  const from = mailboxAddress(owner.username, configuration.domain, fromTag);
  const answered =
    request.replyTo === undefined
      ? undefined
      : await readMailItem(db, owner.userId, request.replyTo);
  if (request.replyTo !== undefined && answered === null)
    throw new MailSendRefused(
      "MAIL_INVALID_REQUEST",
      "That email was not found.",
    );
  const references = [
    ...new Set(
      // Spam's conversation key is its dx mail id, never a Message-ID.
      [
        answered?.conversation_key === answered?.id
          ? undefined
          : answered?.conversation_key,
        answered?.message_id,
      ].flatMap((id) => safeMessageId(id ?? undefined) ?? []),
    ),
  ];
  const ownMessageId = `${crypto.randomUUID()}@${configuration.domain}`;
  const headers: Record<string, string> = {
    ...(answered?.message_id
      ? { "In-Reply-To": `<${answered.message_id}>` }
      : {}),
    ...(references.length === 0
      ? {}
      : { References: references.map((id) => `<${id}>`).join(" ") }),
  };
  const reservation = await reserveSend(db, owner.userId);
  if (reservation === undefined)
    throw new MailSendRefused(
      "MAIL_SEND_LIMIT",
      `You can send ${SEND_LIMITS.perDay} emails a day. Try again tomorrow.`,
    );
  let result: EmailSendResult;
  try {
    result = await (mailSender(bindings) as SendEmail).send({
      from: { email: from, name: owner.name || owner.username },
      to,
      ...(cc.length === 0 ? {} : { cc }),
      ...(bcc.length === 0 ? {} : { bcc }),
      replyTo: from,
      subject: request.subject,
      text: request.text,
      headers,
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((attachment) => ({
              disposition: "attachment" as const,
              filename: attachment.filename,
              type: attachment.mimeType,
              content: attachment.bytes,
            })),
          }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await settleSend(db, reservation, "failed", reason);
    mailLogger.warn("A person's email could not be sent.", {
      event: "mail_send_failed",
      ownerUserId: owner.userId,
      reason,
    });
    throw new MailSendRefused(
      "MAIL_SEND_FAILED",
      `The email could not be sent: ${reason}`,
    );
  }
  await settleSend(db, reservation, "sent");
  const messageId = safeMessageId(result.messageId) ?? ownMessageId;
  const raw = sentCopy({
    from,
    fromName: owner.name || owner.username,
    to,
    cc,
    subject: request.subject,
    text: request.text,
    messageId,
    headers,
    attachments,
  });
  const id = newMailMessageId();
  const conversationKey = await conversationKeyFor(
    db,
    owner.userId,
    messageId,
    references,
  );
  await insertMailItem(
    bindings,
    {
      id,
      owner_user_id: owner.userId,
      direction: "out",
      folder: "sent",
      tag: answered?.tag ?? fromTag ?? null,
      project_id: answered?.project_id ?? fromTagProject ?? null,
      private: answered?.private ?? 0,
      read_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      header_from: `${owner.name || owner.username} <${from}>`,
      from_address: from,
      envelope_from: from,
      rcpt_to: to.join(", "),
      to_addresses: JSON.stringify(to.map((a) => a.toLowerCase())),
      cc_addresses: JSON.stringify(mailHeaderAddresses(cc.join(", "))),
      subject: request.subject,
      message_id: messageId,
      conversation_key: conversationKey,
      dmarc: null,
      authenticated: 1,
      size: raw.length,
      has_attachments: attachments.length > 0 ? 1 : 0,
      preview: request.text.replace(/\s+/g, " ").trim().slice(0, 400),
      disposition: "sent",
      thread_id: null,
    },
    {
      raw: new TextEncoder().encode(raw),
      parts: {
        text: request.text,
        attachments: attachments.map(({ filename, mimeType, bytes }) => ({
          filename,
          mimeType,
          size: bytes.byteLength,
        })),
      },
    },
  );
  mailLogger.info("A person sent an email.", {
    event: "mail_sent",
    ownerUserId: owner.userId,
    mailId: id,
    recipients: all.length,
  });
  await publishUserInvalidation(
    bindings,
    owner.userId as never,
    "mailbox.invalidated",
  );
  return { id, conversationKey };
};
