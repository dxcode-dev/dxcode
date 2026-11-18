/**
 * The one email dx sends (wiki/agent-mail.md): "Started: <link>", written by
 * dx, never by an agent, as a reply to the email that started the Thread.
 */

const encodeHeader = (text: string) =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}?=`;

const singleLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

export interface StartedNotice {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly inReplyTo: string | undefined;
  readonly references: ReadonlyArray<string>;
  readonly threadUrl: string;
  readonly projectLabel: string;
  readonly mailDomain: string;
}

/** The notice as a raw RFC 5322 message, with its own Message-ID. */
export const startedNotice = (notice: StartedNotice) => {
  const messageId = `${crypto.randomUUID()}@${notice.mailDomain}`;
  const subject = singleLine(notice.subject);
  const replySubject = /^re:/i.test(subject)
    ? subject
    : `Re: ${subject || "(no subject)"}`;
  const text = [
    `Started: ${notice.threadUrl}`,
    "",
    `dx started a Thread in ${notice.projectLabel} from your email. Open the link to follow it; you need to be signed in to dx.`,
    "",
    "Replies to this email from you go to the same Thread.",
  ].join("\r\n");
  const references = [
    ...notice.references,
    ...(notice.inReplyTo === undefined ? [] : [notice.inReplyTo]),
  ];
  const headers = [
    `From: dx <${notice.from}>`,
    `To: <${notice.to}>`,
    `Subject: ${encodeHeader(replySubject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    ...(notice.inReplyTo === undefined
      ? []
      : [`In-Reply-To: <${notice.inReplyTo}>`]),
    ...(references.length === 0
      ? []
      : [
          `References: ${[...new Set(references)]
            .slice(-20)
            .map((id) => `<${id}>`)
            .join(" ")}`,
        ]),
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return {
    messageId,
    /** The References value, for a sender that builds its own headers. */
    references: [...new Set(references)]
      .slice(-20)
      .map((id) => `<${id}>`)
      .join(" "),
    subject: replySubject,
    text,
    raw: `${headers.join("\r\n")}\r\n\r\n${text}\r\n`,
  };
};
