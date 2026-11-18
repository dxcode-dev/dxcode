import { Schema } from "effect";

/**
 * Addresses on a deployment's mail domain (wiki/agent-mail.md):
 *
 * - `username@`: a person's mailbox, shared with their agents.
 * - `username+tag@`: the same mailbox, labelled with one of the person's
 *   Projects; the owner's own email to it starts or continues a Thread.
 *
 * Usernames are already valid local parts (3–32 of `a-z0-9-`), and a tag is
 * at most 31 characters, so `username+tag` fits the 64-character limit.
 */

export const MailMessageId = Schema.String.check(
  Schema.isPattern(/^mail_[0-9a-f]{32}$/),
).pipe(Schema.brand("@dx/MailMessageId"));
export type MailMessageId = typeof MailMessageId.Type;

export const newMailMessageId = (): MailMessageId =>
  `mail_${crypto.randomUUID().replaceAll("-", "")}` as MailMessageId;

export const newMailLabelId = () =>
  `mlb_${crypto.randomUUID().replaceAll("-", "")}`;

/** The longest `+tag`: 64 − 32 (username) − 1 (`+`). */
export const MAIL_TAG_MAX_LENGTH = 31;

/**
 * Local parts mail standards reserve, which route to the deployment's
 * admins rather than to anyone's mailbox.
 */
export const MAIL_OPERATOR_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "postmaster",
  "abuse",
]);

/**
 * The `+tag` a Project would get: its name lowercased, `.` and `_` (and
 * anything else) turned into `-`, repeated `-` merged, trimmed, and at most
 * 31 characters. `attempt` above 0 adds `-<attempt + 1>` when the first
 * choice is taken in that mailbox.
 */
export const mailTag = (projectName: string, attempt = 0) => {
  const base =
    projectName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
  return `${base.slice(0, MAIL_TAG_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
};

/**
 * What an address on `domain` names: the username and the `+tag`, both
 * lowercased; undefined for any other domain or a malformed local part.
 */
export const mailRecipientOn = (address: string, domain: string) => {
  const at = address.lastIndexOf("@");
  if (at <= 0) return undefined;
  const host = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (host !== domain.toLowerCase()) return undefined;
  const local = address.slice(0, at).trim().toLowerCase();
  const match =
    /^([a-z0-9][a-z0-9-]{0,62})(?:\+([a-z0-9][a-z0-9-]{0,62}))?$/.exec(local);
  if (match?.[1] === undefined) return undefined;
  return { username: match[1], tag: match[2] };
};

/** `username@domain` or `username+tag@domain`. */
export const mailboxAddress = (
  username: string,
  domain: string,
  tag?: string,
) => `${username}${tag === undefined ? "" : `+${tag}`}@${domain}`;
