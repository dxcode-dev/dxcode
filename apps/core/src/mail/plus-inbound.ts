import {
  dkimSignsHeader,
  escapeEmailContent,
  mailboxAddress,
  mailHeaderAddresses,
  mailMessageIds,
  mailRecipientOn,
  newMailMessageId,
  type Principal,
  type ProjectId,
  splitMailText,
  THREAD_TITLE_MAX_LENGTH,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import { deploymentEmailSender, senderAddress } from "../email/sender.js";
import {
  appOrigin,
  reachableProject,
} from "../feedback-widget/settings-routes.js";
import type { Bindings } from "../http/types.js";
import { mailLogger } from "../logging.js";
import {
  agentModeSelection,
  idempotentThreadId,
} from "../threads/agent-tools.js";
import { ownerRequest } from "../threads/owner-request.js";
import { type MailConfiguration, mailSender } from "./config.js";
import {
  type InboundMail,
  type InboundOutcome,
  type ParsedMail,
  safeMessageId,
} from "./inbound.js";
import { startedNotice } from "./outbound.js";
import {
  conversationKeyFor,
  countMailSince,
  insertMailItem,
  type MailboxOwner,
  readProjectMailSetting,
  setMailDisposition,
} from "./store.js";

/**
 * The owner's own email to their `username+tag@` (wiki/agent-mail.md). The
 * email is already in their mailbox; this decides whether it may start or
 * continue work in the Project the tag names. It starts work only when the
 * owner really sent it, only in a Project they can use in the app, and a
 * failed check sends nothing back:
 *
 *   1. genuine     one clean sender; Cloudflare's own first result shows
 *                  DMARC pass for the From: domain and aligned DKIM
 *                  (`mailDistrust` in inbound.ts); not automated
 *   2. addressed   the `+tag` address is in a To:/Cc: header every aligned
 *                  DKIM signature signs, so mail sent elsewhere cannot be
 *                  replayed here
 *   3. owner       From: is the mailbox owner's verified sign-in email
 *                  (inbound.ts only calls this for them)
 *   4. may use it  the app's own Project access rule, as the owner
 *   5. once        the first delivery claims the Message-ID atomically
 *   6. rate        10 new Threads an hour and 50 a day per owner, 100 a day
 *                  per Project; 60 follow-ups an hour per owner, counted
 *                  with this email reserved
 *
 * A reply in the email conversation of a Thread this mailbox's email
 * started (In-Reply-To, then References) goes into that Thread instead.
 * A failed check leaves the email in the mailbox (in Spam when it may be
 * forged) and starts nothing.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const LIMITS = {
  ownerPerHour: 10,
  ownerPerDay: 50,
  projectPerDay: 100,
  followUpsPerHour: 60,
} as const;

const MAX_TYPED_CHARS = 20_000;
const MAX_QUOTED_CHARS = 50_000;

const sha256Hex = async (seed: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const personal = (userId: string): Principal => ({
  userId: userId as UserId,
  credentialScopes: ["personal", "workspace"],
});

/** Mail a machine sent: auto-replies, bulk, and mailing lists. */
const automated = (parsed: ParsedMail, mailDomain: string) => {
  const autoSubmitted = parsed.header("auto-submitted")?.toLowerCase();
  const precedence = parsed.header("precedence")?.toLowerCase();
  return (
    (autoSubmitted !== undefined && autoSubmitted !== "no") ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    parsed.header("list-id") !== undefined ||
    parsed.header("list-unsubscribe") !== undefined ||
    parsed.header("x-autoreply") !== undefined ||
    (parsed.messageId?.toLowerCase().endsWith(`@${mailDomain}`) ?? false)
  );
};

/** What the agent receives: the author's own text, the rest wrapped. */
export const emailRequestBody = (input: {
  readonly senderName: string | undefined;
  readonly senderEmail: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly filename: string }>;
  readonly followUp: boolean;
  /** Set when the person started it from the Mailbox, with their words. */
  readonly instruction?: string;
}) => {
  const split =
    input.instruction === undefined
      ? splitMailText(input.text)
      : { typed: "", forwarded: input.text, quoted: undefined };
  // Header text sits outside <email_content>, so it is one escaped line.
  const line = (text: string, max: number) =>
    escapeEmailContent(
      text
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
        .trim()
        .slice(0, max),
    );
  const sender =
    input.senderName === undefined
      ? line(input.senderEmail, 320)
      : `${line(input.senderName, 120)} <${line(input.senderEmail, 320)}>`;
  const wrapped = (kind: string, text: string | undefined) =>
    text === undefined || text.trim() === ""
      ? []
      : [
          `<email_content kind="${kind}">\n${escapeEmailContent(text.slice(0, MAX_QUOTED_CHARS))}\n</email_content>`,
        ];
  return [
    input.instruction !== undefined
      ? `The owner started this Thread from an email in their dx Mailbox, from ${sender}.`
      : input.followUp
        ? `Follow-up email from ${sender}, in reply to this Thread's email conversation.`
        : `Email from ${sender} to ${line(input.to, 320)}.`,
    `Subject: ${line(input.subject, 300) || "(no subject)"}`,
    "",
    (input.instruction ?? split.typed).slice(0, MAX_TYPED_CHARS) ||
      "(The email has no text of its own.)",
    ...(input.attachments.length === 0
      ? []
      : [
          "",
          `Attachments (not included): ${input.attachments
            .slice(0, 20)
            .map(({ filename }) => line(filename, 120))
            .join(", ")}`,
        ]),
    ...(split.forwarded === undefined
      ? []
      : [
          "",
          ...wrapped(
            input.instruction === undefined ? "forwarded" : "email",
            split.forwarded,
          ),
        ]),
    // A follow-up's quote repeats what the Thread already has.
    ...(input.followUp || split.quoted === undefined
      ? []
      : ["", ...wrapped("quoted", split.quoted)]),
  ].join("\n");
};

/**
 * Starts a Thread owned by the mailbox owner in the Project, with the
 * Project's email defaults. A mode the owner cannot run falls back to their
 * own default. Returns the Thread's id, or undefined when it did not start.
 */
export const startMailThread = async (
  bindings: Bindings,
  input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly title: string;
    readonly body: string;
    readonly waitUntil: (promise: Promise<unknown>) => void;
    /**
     * Always `email`: from mail, or from Start thread in the Mailbox. The
     * person's own words are the request, the email is wrapped data, and
     * `manage_dx` refuses the turn.
     */
    readonly automation: "email";
    /** Private or Spam mail: never shared, whatever the Project's default. */
    readonly keepPrivate?: boolean;
  },
) => {
  const db = bindings.DB as D1Database;
  const setting = await readProjectMailSetting(db, input.projectId);
  const workspace = await db
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<string | null>("workspace_id");
  let selection: ThreadModelSelection | undefined;
  if (setting.agent_mode !== null)
    try {
      selection = agentModeSelection(setting.agent_mode, undefined);
    } catch {
      selection = undefined;
    }
  const start = (withSelection: boolean) =>
    ownerRequest(
      {
        bindings,
        ownerUserId: input.ownerUserId as UserId,
        waitUntil: input.waitUntil,
        automation: input.automation,
      },
      "POST",
      "/v1/threads",
      {
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title.slice(0, THREAD_TITLE_MAX_LENGTH).trimEnd(),
        generateTitle: false,
        ...(withSelection && selection !== undefined ? { selection } : {}),
        ...(setting.visibility === "workspace" &&
        input.keepPrivate !== true &&
        workspace !== null &&
        workspace !== undefined
          ? { visibility: "workspace" }
          : {}),
        initialMessage: { body: input.body, attachments: [] },
      },
    );
  let started = await start(true);
  if (!started.response.ok && selection !== undefined)
    started = await start(false);
  const created = (started.payload?.data as { id?: unknown } | undefined)?.id;
  if (!started.response.ok || created !== input.threadId) {
    mailLogger.warn("An email could not start a Thread.", {
      event: "mail_start_failed",
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      status: started.response.status,
      code: (started.payload?.data as { code?: string } | undefined)?.code,
    });
    return undefined;
  }
  return input.threadId;
};

const knownConversation = async (
  db: D1Database,
  ownerUserId: string,
  messageIds: ReadonlyArray<string>,
) => {
  for (const messageId of messageIds) {
    const threadId = await db
      .prepare(
        "SELECT thread_id FROM mail_reply_ref WHERE owner_user_id = ? AND message_id = ?",
      )
      .bind(ownerUserId, messageId)
      .first<string>("thread_id");
    if (threadId !== null) return threadId;
  }
  return undefined;
};

/**
 * Claims a Message-ID for this mailbox, so of two simultaneous deliveries
 * exactly one goes on; false when taken.
 */
const claimMessage = async (
  db: D1Database,
  ownerUserId: string,
  messageId: string,
  threadId: string,
) =>
  ((
    await db
      .prepare(
        `INSERT OR IGNORE INTO mail_reply_ref (owner_user_id, message_id, thread_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(ownerUserId, messageId, threadId, new Date().toISOString())
      .run()
  ).meta.changes ?? 0) > 0;

const releaseMessage = (
  db: D1Database,
  ownerUserId: string,
  messageId: string,
) =>
  db
    .prepare(
      "DELETE FROM mail_reply_ref WHERE owner_user_id = ? AND message_id = ?",
    )
    .bind(ownerUserId, messageId)
    .run();

export const rememberConversation = (
  db: D1Database,
  ownerUserId: string,
  threadId: string,
  messageIds: ReadonlyArray<string>,
) => {
  const now = new Date().toISOString();
  return db.batch(
    messageIds.map((messageId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO mail_reply_ref (owner_user_id, message_id, thread_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(ownerUserId, messageId, threadId, now),
    ),
  );
};

export const handlePlusMail = async (
  bindings: Bindings,
  configuration: MailConfiguration,
  input: {
    readonly mail: InboundMail;
    readonly parsed: ParsedMail;
    readonly owner: MailboxOwner;
    readonly mailId: string;
    readonly messageId: string;
    readonly projectId: string;
    readonly tag: string;
    readonly senderName: string;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
): Promise<InboundOutcome> => {
  const { mail, parsed, owner, mailId, messageId, projectId } = input;
  const db = bindings.DB as D1Database;
  const ownerUserId = owner.userId;
  const senderEmail = owner.email.toLowerCase();
  const kept = (reason: string) => {
    mailLogger.info("A +tag email from its owner started nothing.", {
      event: "mail_plus_kept",
      ownerUserId,
      projectId,
      mailId,
      reason,
    });
    return { kind: "stored", mailId, ownerUserId, reason } as const;
  };
  const spam = async (reason: string) => {
    await setMailDisposition(db, mailId, `spam_${reason}`, { folder: "spam" });
    mailLogger.info("A +tag email went to Spam.", {
      event: "mail_plus_spam",
      ownerUserId,
      projectId,
      mailId,
      reason,
    });
    return { kind: "spam", mailId, ownerUserId, reason } as const;
  };
  // 1. Genuine (checked as it was stored) and not automated.
  const stored = await db
    .prepare(
      "SELECT folder, private, authenticated FROM mail_item WHERE id = ?",
    )
    .bind(mailId)
    .first<{ folder: string; private: number; authenticated: number }>();
  if (stored?.folder === "spam") return { kind: "spam", mailId, ownerUserId };
  // Only mail signed by its own domain (DMARC with aligned DKIM) starts work;
  // a reply the Inbox took on SPF alone is only filed.
  if (stored?.authenticated !== 1) return kept("unverified");
  // Mail in a private conversation stays private in the Thread it starts.
  const privateMail = stored?.private === 1;
  if (automated(parsed, configuration.domain)) return spam("automated");
  // 2. The signed message itself names this `+tag`.
  const fromDomain = senderEmail.slice(senderEmail.lastIndexOf("@") + 1);
  const addressed = (["to", "cc"] as const).some(
    (name) =>
      mailHeaderAddresses(parsed.header(name) ?? "").some((address) => {
        const recipient = mailRecipientOn(address, configuration.domain);
        return (
          recipient?.tag === input.tag &&
          (recipient.username === owner.username ||
            mailRecipientOn(mail.to, configuration.domain)?.username ===
              recipient.username)
        );
      }) && dkimSignsHeader(parsed.headers, fromDomain, name),
  );
  if (!addressed) return spam("not_addressed");
  // 4. The app's own rule: the owner can still use this Project.
  if (
    (await reachableProject(
      db,
      personal(ownerUserId),
      projectId as ProjectId,
    )) === undefined
  )
    return kept("not_member");
  // 5. The Project's managers let email start Threads in it (a setting,
  // on by default). Off, the email is only filed under the Project.
  if ((await readProjectMailSetting(db, projectId)).start_threads !== 1)
    return kept("starts_off");
  const references = [
    ...mailMessageIds(parsed.inReplyTo),
    ...mailMessageIds(parsed.references).reverse(),
  ].flatMap((id) => safeMessageId(id) ?? []);
  const conversation = await knownConversation(db, ownerUserId, references);
  /** Undo the claim on any failure after it, then rethrow. */
  const settling = <T>(work: Promise<T>) =>
    work.catch(async (cause: unknown) => {
      await releaseMessage(db, ownerUserId, messageId).catch(() => undefined);
      await setMailDisposition(db, mailId, "stored", { threadId: null }).catch(
        () => undefined,
      );
      throw cause;
    });
  const undo = async (reason: string) => {
    await releaseMessage(db, ownerUserId, messageId);
    await setMailDisposition(db, mailId, "stored", { threadId: null });
    return kept(reason);
  };

  if (conversation !== undefined) {
    const thread = await db
      .prepare(
        "SELECT owner_user_id, lifecycle_state FROM threads WHERE id = ?",
      )
      .bind(conversation)
      .first<{ owner_user_id: string; lifecycle_state: string }>();
    if (thread === null || thread.lifecycle_state === "deleted")
      return kept("thread_deleted");
    if (thread.owner_user_id !== ownerUserId) return kept("not_owner");
    if (thread.lifecycle_state !== "active") return kept("thread_archived");
    // 6. Once.
    if (!(await claimMessage(db, ownerUserId, messageId, conversation)))
      return kept("duplicate");
    // 7. Counted with this one reserved.
    await settling(
      setMailDisposition(db, mailId, "followed_up", { threadId: conversation }),
    );
    if (
      (await settling(
        countMailSince(db, { ownerUserId }, ["followed_up"], HOUR_MS),
      )) > LIMITS.followUpsPerHour
    )
      return undo("rate_limit");
    const { response, payload } = await settling(
      ownerRequest(
        {
          bindings,
          ownerUserId: ownerUserId as UserId,
          waitUntil: input.waitUntil,
          automation: "email",
        },
        "POST",
        `/v1/agents/dx/${encodeURIComponent(conversation)}`,
        {
          kind: "user",
          body: emailRequestBody({
            senderName: input.senderName,
            senderEmail,
            to: mail.to,
            subject: parsed.subject,
            text: parsed.parts.text,
            attachments: parsed.parts.attachments,
            followUp: true,
          }),
          idempotencyKey: await sha256Hex(`${conversation}\n${messageId}`),
        },
      ),
    );
    if (response.status !== 202 || typeof payload?.submissionId !== "string")
      return undo("start_failed");
    mailLogger.info("A follow-up email reached its Thread.", {
      event: "mail_followed_up",
      ownerUserId,
      threadId: conversation,
      mailId,
    });
    return {
      kind: "followed_up",
      mailId,
      ownerUserId,
      threadId: conversation,
    };
  }

  // 6. Once: a second delivery names the same Thread and finds it claimed.
  const threadId = await idempotentThreadId(
    `mail\n${ownerUserId}\n${messageId}`,
  );
  if (!(await claimMessage(db, ownerUserId, messageId, threadId)))
    return kept("duplicate");
  await settling(
    setMailDisposition(db, mailId, "started_thread", { threadId }),
  );
  if (
    (await settling(
      countMailSince(db, { ownerUserId }, ["started_thread"], HOUR_MS),
    )) > LIMITS.ownerPerHour ||
    (await settling(
      countMailSince(db, { ownerUserId }, ["started_thread"], DAY_MS),
    )) > LIMITS.ownerPerDay ||
    (await settling(
      countMailSince(db, { projectId }, ["started_thread"], DAY_MS),
    )) > LIMITS.projectPerDay
  )
    return undo("rate_limit");
  const started = await settling(
    startMailThread(bindings, {
      ownerUserId,
      projectId,
      threadId,
      title: parsed.subject || `Email from ${input.senderName}`,
      body: emailRequestBody({
        senderName: input.senderName,
        senderEmail,
        to: mail.to,
        subject: parsed.subject,
        text: parsed.parts.text,
        attachments: parsed.parts.attachments,
        followUp: false,
      }),
      waitUntil: input.waitUntil,
      automation: "email",
      keepPrivate: privateMail,
    }),
  );
  if (started === undefined) return undo("start_failed");
  mailLogger.info("A +tag email started a Thread.", {
    event: "mail_started_thread",
    ownerUserId,
    projectId,
    threadId,
    mailId,
  });
  await sendStartedNotice(bindings, configuration, {
    mail,
    parsed,
    owner,
    projectId,
    tag: input.tag,
    threadId,
    messageId,
    private: privateMail,
  }).catch((cause: unknown) =>
    mailLogger.warn("The started notice could not be sent.", {
      event: "mail_started_notice_failed",
      ownerUserId,
      threadId,
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  return { kind: "started_thread", mailId, ownerUserId, threadId };
};

/**
 * The one email dx sends on its own: "Started: <link>", to the owner only.
 * From the mail domain when the deployment can send from it; otherwise as
 * a reply in the same SMTP session (accepted only to the envelope sender),
 * and otherwise from the deployment's own sender with Reply-To set to the
 * `+tag` address. Either way, its Message-IDs route the owner's reply.
 */
const sendStartedNotice = async (
  bindings: Bindings,
  configuration: MailConfiguration,
  input: {
    readonly mail: InboundMail;
    readonly parsed: ParsedMail;
    readonly owner: MailboxOwner;
    readonly projectId: string;
    readonly tag: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly private: boolean;
  },
) => {
  const db = bindings.DB as D1Database;
  const { owner, parsed } = input;
  const senderEmail = owner.email.toLowerCase();
  const tagAddress = mailboxAddress(
    owner.username,
    configuration.domain,
    input.tag,
  );
  const projectName =
    (await db
      .prepare("SELECT name FROM projects WHERE id = ?")
      .bind(input.projectId)
      .first<string>("name")) ?? "your Project";
  const notice = startedNotice({
    from: tagAddress,
    to: senderEmail,
    subject: parsed.subject,
    inReplyTo: safeMessageId(parsed.messageId),
    references: mailMessageIds(parsed.references),
    threadUrl: `${await appOrigin(bindings)}/threads/${input.threadId}`,
    projectLabel: projectName,
    mailDomain: configuration.domain,
  });
  const headers = {
    "In-Reply-To": `<${input.messageId}>`,
    References: notice.references,
    "Auto-Submitted": "auto-replied",
  };
  let sent: { messageIds: string[]; from: string } | undefined;
  const sender = mailSender(bindings);
  if (sender !== undefined)
    try {
      const result = await sender.send({
        from: { email: tagAddress, name: "dx" },
        to: senderEmail,
        subject: notice.subject,
        text: notice.text,
        headers,
      });
      sent = {
        messageIds: [
          notice.messageId,
          ...(safeMessageId(result.messageId) === undefined
            ? []
            : [safeMessageId(result.messageId) as string]),
        ],
        from: tagAddress,
      };
    } catch (cause) {
      mailLogger.info("The started notice could not go from the mail domain.", {
        event: "mail_started_notice_send_refused",
        threadId: input.threadId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  if (
    sent === undefined &&
    input.mail.from.trim().toLowerCase() === senderEmail
  )
    try {
      await input.mail.reply({
        from: input.mail.to,
        to: input.mail.from.trim(),
        raw: notice.raw,
      });
      sent = { messageIds: [notice.messageId], from: tagAddress };
    } catch (cause) {
      mailLogger.info("The started notice could not go as a reply.", {
        event: "mail_started_notice_reply_refused",
        threadId: input.threadId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  if (sent === undefined) {
    const deployment = deploymentEmailSender(bindings);
    if (deployment === undefined)
      throw new Error("The deployment has no email sender.");
    const result = await deployment.binding.send({
      from: senderAddress(deployment),
      to: senderEmail,
      replyTo: tagAddress,
      subject: notice.subject,
      text: notice.text,
      headers,
    });
    sent = {
      messageIds: [
        notice.messageId,
        ...(safeMessageId(result.messageId) === undefined
          ? []
          : [safeMessageId(result.messageId) as string]),
      ],
      from: deployment.from,
    };
  }
  await rememberConversation(db, owner.userId, input.threadId, sent.messageIds);
  // The notice joins the conversation in the owner's mailbox.
  await insertMailItem(
    bindings,
    {
      id: newMailMessageId(),
      owner_user_id: owner.userId,
      direction: "out",
      folder: "sent",
      tag: input.tag,
      project_id: input.projectId,
      private: input.private ? 1 : 0,
      read_at: new Date().toISOString(),
      received_at: new Date().toISOString(),
      header_from: `dx <${sent.from}>`,
      from_address: sent.from,
      envelope_from: sent.from,
      rcpt_to: senderEmail,
      to_addresses: JSON.stringify([senderEmail]),
      cc_addresses: "[]",
      subject: notice.subject,
      message_id: sent.messageIds.at(-1) ?? notice.messageId,
      conversation_key: await conversationKeyFor(
        db,
        owner.userId,
        notice.messageId,
        [input.messageId],
      ),
      dmarc: null,
      authenticated: 1,
      size: notice.raw.length,
      has_attachments: 0,
      preview: notice.text.replace(/\s+/g, " ").slice(0, 240),
      disposition: "sent_started",
      thread_id: input.threadId,
    },
    {
      raw: new TextEncoder().encode(notice.raw),
      parts: { text: notice.text, attachments: [] },
    },
  );
};
