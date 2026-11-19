import {
  CreateMailLabelRequestSchema,
  DeploymentAdminPersonResponseSchema,
  type GetMailboxResponse,
  type GetMailConversationResponse,
  type GetProjectMailResponse,
  type ListMailConversationsResponse,
  type MailConversationSummary,
  type MailErrorCode,
  MailFolderSchema,
  type MailMessage,
  SendMailRequestSchema,
  SetMailSendingRequestSchema,
  SetMailSendingResponseSchema,
  StartThreadFromMailRequestSchema,
  UpdateMailboxSettingsRequestSchema,
  UpdateMailConversationRequestSchema,
  UpdateMailLabelRequestSchema,
} from "@dx/api";
import {
  mailboxAddress,
  normalizePersonalAccountUsername,
  type Principal,
  ProjectId,
  personalAccountUsernameChangeAvailable,
  type ThreadId,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import PostalMime from "postal-mime";
import {
  appOrigin,
  reachableProject,
} from "../feedback-widget/settings-routes.js";
import { readBoundedBody, readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { mailLogger } from "../logging.js";
import { publishUserInvalidation } from "../realtime/publication.js";
import { idempotentThreadId } from "../threads/agent-tools.js";
import {
  LOCAL_OUTBOX_PREFIX,
  mailboxFor,
  mailConfiguration,
} from "./config.js";
import { handleInboundMail, MAX_INBOUND_MAIL_BYTES } from "./inbound.js";
import {
  MailSendRefused,
  SEND_LIMITS,
  sendingBlockedReason,
  sendMail,
  sentToday,
} from "./send.js";
import { emailRequestBody, startMailThread } from "./start-thread.js";
import {
  conversationItems,
  createLabel,
  deleteLabel,
  ensureProjectTag,
  labelsOf,
  listConversationKeys,
  listLabels,
  listPrivateSenders,
  listProjectTags,
  type MailItemRow,
  MailLabelTaken,
  readersOf,
  readMailboxOwner,
  readMailboxSetting,
  readMailItem,
  readMailParts,
  readMailRaw,
  renameLabel,
  setMailSendingSuspended,
  setPrivateSender,
  threadTitles,
  unreadByTag,
  unreadCounts,
  updateConversation,
  updateMailboxSetting,
  usernameNeedsPick,
} from "./store.js";

/**
 * The dx Mail API (wiki/agent-mail.md), under `/v1/mailbox`, for the
 * signed-in person only: API keys and External API Apps never reach a
 * person's mail. Project Settings → Email is under `/v1/projects`.
 */

const noStore = { "cache-control": "no-store" } as const;
const PAGE = 50;

const fail = (
  context: Context<AppEnv>,
  status: 400 | 403 | 404 | 409 | 422 | 429 | 503,
  code: MailErrorCode,
  message: string,
) =>
  context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    status,
    noStore,
  );

/** A browser session of the person: never an API key or an app. */
const sessionPrincipal = (context: Context<AppEnv>) => {
  const principal = context.get("principal") as Principal & {
    readonly apiTokenScopes?: unknown;
    readonly application?: unknown;
  };
  return principal.apiTokenScopes === undefined &&
    principal.application === undefined
    ? principal
    : undefined;
};

/** The signed-in person and the mail domain, or the reason there are none. */
const mailboxOf = async (context: Context<AppEnv>) => {
  const configuration = mailConfiguration(context.env);
  const principal = sessionPrincipal(context);
  const db = context.env.DB;
  if (configuration === undefined || db === undefined)
    return { failure: "disabled" as const };
  if (principal === undefined) return { failure: "forbidden" as const };
  // The person turns the Mail on for themselves (a beta flag).
  if ((await mailboxFor(context.env, principal.userId)) === undefined)
    return { failure: "disabled" as const };
  const owner = await readMailboxOwner(db, principal.userId);
  if (owner === undefined) return { failure: "forbidden" as const };
  return { configuration, owner, db };
};

type Mailbox = Exclude<
  Awaited<ReturnType<typeof mailboxOf>>,
  { failure: unknown }
>;

/** Runs a route for the person's open Mail. */
const withMailbox =
  (
    handle: (context: Context<AppEnv>, mailbox: Mailbox) => Promise<Response>,
    options: { readonly requirePick?: boolean } = {},
  ) =>
  async (context: Context<AppEnv>) => {
    const mailbox = await mailboxOf(context);
    if ("failure" in mailbox)
      return mailbox.failure === "disabled"
        ? fail(context, 404, "MAIL_DISABLED", "Email is not set up on this dx.")
        : fail(
            context,
            403,
            "MAIL_FORBIDDEN",
            "Only you, signed in to dx, can use your Mail.",
          );
    if (
      options.requirePick !== false &&
      usernameNeedsPick(mailbox.owner.username)
    )
      return fail(
        context,
        409,
        "MAIL_USERNAME_REQUIRED",
        "Pick your username before Mail opens.",
      );
    return handle(context, mailbox);
  };

const parseList = (value: string) => {
  try {
    const list = JSON.parse(value) as unknown;
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

/** `Name <a@b>` or `a@b` as name and address. */
const addressOf = (header: string | null, fallback: string | null) => {
  const value = header ?? fallback ?? "";
  const angle = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(value);
  if (angle?.[2] !== undefined)
    return {
      ...(angle[1]?.trim() ? { name: angle[1].trim() } : {}),
      address: angle[2].trim().toLowerCase(),
    };
  return { address: (fallback ?? value).trim().toLowerCase() };
};

const SPAM_REASONS: Record<string, string> = {
  spam_unauthenticated:
    "Nothing ties it to its sender's domain: no SPF pass or signature from that domain, which forged mail often lacks.",
  spam_dmarc_fail:
    "Its sender's domain says mail like this is forged: it failed that domain's DMARC check.",
  spam_header:
    "Its headers are malformed or repeated, which forged mail often has.",
  // From before email could start Threads only through Start thread.
  spam_automated: "It was sent by a machine, so it could not start work.",
  spam_not_addressed:
    "It was sent from your address, but its signature does not cover the +project address, so it could have been copied from another email.",
};

const summarize = async (
  db: D1Database,
  ownerAddress: string,
  keys: ReadonlyArray<{ key: string; latest: string }>,
  items: ReadonlyArray<MailItemRow>,
): Promise<MailConversationSummary[]> => {
  const labels = await labelsOf(
    db,
    items.map(({ id }) => id),
  );
  const readers = await db
    .prepare(
      `SELECT DISTINCT mail_id FROM mail_read_log
        WHERE mail_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(items.map(({ id }) => id)))
    .all<{ mail_id: string }>();
  const read = new Set(readers.results.map(({ mail_id }) => mail_id));
  return keys.flatMap(({ key, latest }) => {
    const conversation = items.filter((item) => item.conversation_key === key);
    const newest = conversation.at(-1);
    if (newest === undefined) return [];
    const participants = new Map<string, { name?: string; address: string }>();
    for (const item of [...conversation].reverse()) {
      const people =
        item.direction === "in"
          ? [addressOf(item.header_from, item.from_address)]
          : parseList(item.to_addresses).map((address) => ({ address }));
      for (const person of people)
        if (
          person.address !== ownerAddress &&
          !participants.has(person.address)
        )
          participants.set(person.address, person);
    }
    const labelMap = new Map<
      string,
      { id: string; name: string; automatic: boolean }
    >();
    for (const item of conversation)
      for (const label of labels.get(item.id) ?? [])
        labelMap.set(label.id, label);
    const received = conversation.filter(({ direction }) => direction === "in");
    const tag = conversation.find(({ tag }) => tag !== null)?.tag;
    return [
      {
        key,
        subject: conversation[0]?.subject ?? "",
        participants: [...participants.values()].slice(0, 5) as never,
        latestAt: latest,
        count: conversation.length,
        unread: received.some(({ read_at }) => read_at === null),
        preview: newest.preview ?? "",
        labels: [...labelMap.values()] as never,
        ...(tag === undefined || tag === null ? {} : { tag }),
        private: conversation.some((item) => item.private === 1),
        hasAttachments: conversation.some((item) => item.has_attachments === 1),
        authenticated: received.every((item) => item.authenticated === 1),
        readByAgent: conversation.some((item) => read.has(item.id)),
      },
    ];
  });
};

export const mailboxRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const mailbox = await mailboxOf(context);
    if ("failure" in mailbox)
      return mailbox.failure === "disabled"
        ? context.json(
            {
              status: "success",
              data: { enabled: false },
            } satisfies GetMailboxResponse,
            200,
            noStore,
          )
        : fail(
            context,
            403,
            "MAIL_FORBIDDEN",
            "Only you, signed in to dx, can use your Mail.",
          );
    const { db, owner, configuration } = mailbox;
    const [
      setting,
      unread,
      labels,
      tags,
      byTag,
      privateSenders,
      sent,
      changed,
    ] = await Promise.all([
      readMailboxSetting(db, owner.userId),
      unreadCounts(db, owner.userId),
      listLabels(db, owner.userId),
      listProjectTags(db, owner.userId),
      unreadByTag(db, owner.userId),
      listPrivateSenders(db, owner.userId),
      sentToday(db, owner.userId),
      db
        .prepare(
          "SELECT username_changed_at FROM personal_account WHERE user_id = ?",
        )
        .bind(owner.userId)
        .first<string | null>("username_changed_at"),
    ]);
    const blocked = await sendingBlockedReason(context.env, owner);
    return context.json(
      {
        status: "success",
        data: {
          enabled: true,
          domain: configuration.domain,
          username: owner.username,
          address: mailboxAddress(owner.username, configuration.domain),
          needsUsername: usernameNeedsPick(owner.username),
          canChangeUsername:
            usernameNeedsPick(owner.username) ||
            changed === null ||
            changed === undefined,
          canSend: blocked === undefined,
          ...(blocked === undefined ? {} : { sendingBlockedReason: blocked }),
          agentAccess: setting.agent_access,
          unread,
          labels: labels.map((label) => ({ ...label })) as never,
          projects: tags.map((tag) => ({
            tag: tag.tag,
            projectId: tag.project_id as never,
            projectName: tag.name,
            address: mailboxAddress(
              owner.username,
              configuration.domain,
              tag.tag,
            ),
            unread: byTag.get(tag.tag) ?? 0,
          })),
          privateSenders,
          limits: {
            sendsPerDay: SEND_LIMITS.perDay,
            recipientsPerEmail: SEND_LIMITS.recipients,
            attachmentBytes: SEND_LIMITS.attachmentBytes,
            sentToday: sent,
          },
        },
      } satisfies GetMailboxResponse,
      200,
      noStore,
    );
  })
  .get(
    "/conversations",
    withMailbox(async (context, { db, owner, configuration }) => {
      const folder = Option.getOrUndefined(
        Schema.decodeUnknownOption(MailFolderSchema)(
          context.req.query("folder"),
        ),
      );
      const labelId = context.req.query("label");
      const tag = context.req.query("tag");
      const keys = await listConversationKeys(db, owner.userId, {
        ...(folder === undefined && labelId === undefined && tag === undefined
          ? { folder: "inbox" as const }
          : folder === undefined
            ? {}
            : { folder }),
        ...(labelId === undefined ? {} : { labelId }),
        ...(tag === undefined ? {} : { tag }),
        ...(context.req.query("q") === undefined
          ? {}
          : { query: context.req.query("q") }),
        ...(context.req.query("before") === undefined
          ? {}
          : { before: context.req.query("before") }),
        limit: PAGE + 1,
      });
      const page = keys.slice(0, PAGE);
      const items = await conversationItems(
        db,
        owner.userId,
        page.map(({ key }) => key),
      );
      const last = page.at(-1);
      return context.json(
        {
          status: "success",
          data: {
            conversations: await summarize(
              db,
              mailboxAddress(owner.username, configuration.domain),
              page,
              items,
            ),
            ...(keys.length > PAGE && last !== undefined
              ? { nextCursor: `${last.latest}|${last.key}` }
              : {}),
          },
        } satisfies ListMailConversationsResponse,
        200,
        noStore,
      );
    }),
  )
  .get(
    "/conversations/:key",
    withMailbox(async (context, { db, owner }) => {
      const key = context.req.param("key") ?? "";
      const items = await conversationItems(db, owner.userId, [key]);
      if (items.length === 0)
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That email was not found.",
        );
      const ids = items.map(({ id }) => id);
      const [labels, readers, titles] = await Promise.all([
        labelsOf(db, ids),
        readersOf(db, ids),
        threadTitles(
          db,
          items.flatMap(({ thread_id }) =>
            thread_id === null ? [] : [thread_id],
          ),
        ),
      ]);
      const messages: MailMessage[] = [];
      for (const item of items) {
        const parts = await readMailParts(context.env, item);
        const title =
          item.thread_id === null ? undefined : titles.get(item.thread_id);
        messages.push({
          id: item.id as never,
          direction: item.direction,
          folder: item.folder,
          from: addressOf(item.header_from, item.from_address) as never,
          to: parseList(item.to_addresses).map((address) => ({ address })),
          cc: parseList(item.cc_addresses).map((address) => ({ address })),
          subject: item.subject ?? "",
          receivedAt: item.received_at,
          text: parts.text,
          ...(parts.html === undefined ? {} : { html: parts.html }),
          attachments: parts.attachments.map((attachment, index) => ({
            index,
            ...attachment,
          })),
          authenticated: item.authenticated === 1,
          labels: (labels.get(item.id) ?? []) as never,
          ...(item.tag === null ? {} : { tag: item.tag }),
          private: item.private === 1,
          read: item.direction === "out" || item.read_at !== null,
          readBy: (readers.get(item.id) ?? []) as never,
          // The Thread this email started with Start thread (older mail may
          // also name one it started or continued by itself).
          ...(title === undefined || item.thread_id === null
            ? {}
            : {
                thread: {
                  threadId: item.thread_id as ThreadId,
                  title,
                  kind:
                    item.disposition === "followed_up"
                      ? ("followed_up" as const)
                      : ("started" as const),
                },
              }),
          ...(item.direction !== "in" || item.authenticated === 1
            ? {}
            : {
                trust: item.disposition.startsWith("spam_")
                  ? ("untrusted" as const)
                  : ("unverified" as const),
              }),
          ...(SPAM_REASONS[item.disposition] === undefined ||
          item.folder !== "spam"
            ? {}
            : { spamReason: SPAM_REASONS[item.disposition] }),
        });
      }
      return context.json(
        {
          status: "success",
          data: { key, subject: items[0]?.subject ?? "", messages },
        } satisfies GetMailConversationResponse,
        200,
        noStore,
      );
    }),
  )
  .patch(
    "/conversations/:key",
    withMailbox(async (context, { db, owner }) => {
      const body = Schema.decodeUnknownOption(
        UpdateMailConversationRequestSchema,
      )(await readBoundedJson(context.req.raw).catch(() => undefined));
      if (Option.isNone(body))
        return fail(
          context,
          400,
          "MAIL_INVALID_REQUEST",
          "Request validation failed.",
        );
      const key = context.req.param("key") ?? "";
      if ((await conversationItems(db, owner.userId, [key])).length === 0)
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That email was not found.",
        );
      await updateConversation(db, owner.userId, key, body.value);
      await publishUserInvalidation(
        context.env,
        owner.userId as never,
        "mailbox.invalidated",
      );
      return context.json({ status: "success", data: {} }, 200, noStore);
    }),
  )
  .post(
    "/labels",
    withMailbox(async (context, { db, owner }) => {
      const body = Schema.decodeUnknownOption(CreateMailLabelRequestSchema)(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (Option.isNone(body) || body.value.name.trim() === "")
        return fail(context, 400, "MAIL_INVALID_REQUEST", "Name the label.");
      try {
        const label = await createLabel(db, owner.userId, body.value.name);
        await publishUserInvalidation(
          context.env,
          owner.userId as never,
          "mailbox.invalidated",
        );
        return context.json({ status: "success", data: label }, 201, noStore);
      } catch (cause) {
        if (cause instanceof MailLabelTaken)
          return fail(
            context,
            409,
            "MAIL_INVALID_REQUEST",
            "You already have a label with that name.",
          );
        throw cause;
      }
    }),
  )
  .patch(
    "/labels/:id",
    withMailbox(async (context, { db, owner }) => {
      const body = Schema.decodeUnknownOption(UpdateMailLabelRequestSchema)(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (Option.isNone(body) || body.value.name.trim() === "")
        return fail(context, 400, "MAIL_INVALID_REQUEST", "Name the label.");
      if (
        !(await renameLabel(
          db,
          owner.userId,
          context.req.param("id") ?? "",
          body.value.name,
        ))
      )
        return fail(
          context,
          409,
          "MAIL_INVALID_REQUEST",
          "That label can't take this name.",
        );
      await publishUserInvalidation(
        context.env,
        owner.userId as never,
        "mailbox.invalidated",
      );
      return context.json({ status: "success", data: {} }, 200, noStore);
    }),
  )
  .delete(
    "/labels/:id",
    withMailbox(async (context, { db, owner }) => {
      if (!(await deleteLabel(db, owner.userId, context.req.param("id") ?? "")))
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That label was not found.",
        );
      await publishUserInvalidation(
        context.env,
        owner.userId as never,
        "mailbox.invalidated",
      );
      return context.json({ status: "success", data: {} }, 200, noStore);
    }),
  )
  .patch(
    "/settings",
    withMailbox(async (context, { db, owner }) => {
      const body = Schema.decodeUnknownOption(
        UpdateMailboxSettingsRequestSchema,
      )(await readBoundedJson(context.req.raw).catch(() => undefined));
      if (Option.isNone(body))
        return fail(
          context,
          400,
          "MAIL_INVALID_REQUEST",
          "Request validation failed.",
        );
      if (body.value.agentAccess !== undefined)
        await updateMailboxSetting(db, owner.userId, {
          agentAccess: body.value.agentAccess,
        });
      for (const [address, isPrivate] of [
        [body.value.addPrivateSender, true],
        [body.value.removePrivateSender, false],
      ] as const)
        if (address !== undefined) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim()))
            return fail(
              context,
              400,
              "MAIL_INVALID_REQUEST",
              `${address} is not an email address.`,
            );
          await setPrivateSender(db, owner.userId, address, isPrivate);
        }
      await publishUserInvalidation(
        context.env,
        owner.userId as never,
        "mailbox.invalidated",
      );
      return context.json({ status: "success", data: {} }, 200, noStore);
    }),
  )
  .post(
    "/send",
    withMailbox(async (context, { owner, configuration }) => {
      const body = Schema.decodeUnknownOption(SendMailRequestSchema)(
        await readBoundedJson(context.req.raw, 16 * 1_024 * 1_024).catch(
          () => undefined,
        ),
      );
      if (Option.isNone(body))
        return fail(
          context,
          400,
          "MAIL_INVALID_REQUEST",
          "Request validation failed.",
        );
      try {
        const sent = await sendMail(
          context.env,
          configuration,
          owner,
          body.value,
        );
        return context.json({ status: "success", data: sent }, 201, noStore);
      } catch (cause) {
        if (!(cause instanceof MailSendRefused)) throw cause;
        return fail(
          context,
          cause.code === "MAIL_SEND_LIMIT"
            ? 429
            : cause.code === "MAIL_SENDING_BLOCKED"
              ? 403
              : cause.code === "MAIL_SEND_FAILED"
                ? 422
                : 400,
          cause.code,
          cause.message,
        );
      }
    }),
  )
  .get(
    "/messages/:id/attachments/:index",
    withMailbox(async (context, { db, owner }) => {
      const item = await readMailItem(
        db,
        owner.userId,
        context.req.param("id") ?? "",
      );
      const index = Number(context.req.param("index") ?? "");
      const raw =
        item === null ? undefined : await readMailRaw(context.env, item);
      if (raw === undefined || !Number.isInteger(index))
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That attachment was not found.",
        );
      const parsed = await PostalMime.parse(raw, {
        attachmentEncoding: "arraybuffer",
      });
      const attachment = parsed.attachments[index];
      if (attachment === undefined)
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That attachment was not found.",
        );
      // The plain filename is ASCII only; filename* carries the real one.
      const name = (attachment.filename ?? "attachment").replace(
        /[^\x20-\x7e]|["\\]/g,
        "_",
      );
      return new Response(attachment.content as ArrayBuffer, {
        headers: {
          // Always a download, never rendered in the app's origin.
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(attachment.filename ?? "attachment")}`,
          "x-content-type-options": "nosniff",
          ...noStore,
        },
      });
    }),
  )
  .post(
    "/messages/:id/start-thread",
    withMailbox(async (context, { db, owner }) => {
      const body = Schema.decodeUnknownOption(StartThreadFromMailRequestSchema)(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (Option.isNone(body))
        return fail(
          context,
          400,
          "MAIL_INVALID_REQUEST",
          "Pick a project and say what to do.",
        );
      const item = await readMailItem(
        db,
        owner.userId,
        context.req.param("id") ?? "",
      );
      if (item === null)
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That email was not found.",
        );
      const principal = context.get("principal") as Principal;
      if (
        (await reachableProject(db, principal, body.value.projectId)) ===
        undefined
      )
        return fail(
          context,
          404,
          "MAIL_NOT_FOUND",
          "That project was not found.",
        );
      const parts = await readMailParts(context.env, item);
      const threadId = await idempotentThreadId(
        `mailbox-start\n${owner.userId}\n${item.id}\n${crypto.randomUUID()}`,
      );
      const started = await startMailThread(context.env, {
        ownerUserId: owner.userId,
        projectId: body.value.projectId,
        threadId,
        title: item.subject || "Email",
        body: emailRequestBody({
          senderEmail:
            item.from_address ?? item.envelope_from ?? "unknown sender",
          subject: item.subject ?? "",
          text: parts.text,
          attachments: parts.attachments,
          instruction: body.value.instruction,
        }),
        waitUntil: (promise) => context.executionCtx.waitUntil(promise),
      });
      if (started === undefined)
        return fail(
          context,
          422,
          "MAIL_INVALID_REQUEST",
          "dx could not start the thread.",
        );
      // The email shows the Thread it started; its folder and any Spam
      // reason stay as they were.
      await db
        .prepare(
          "UPDATE mail_item SET thread_id = ? WHERE id = ? AND owner_user_id = ? AND thread_id IS NULL",
        )
        .bind(started, item.id, owner.userId)
        .run();
      await publishUserInvalidation(
        context.env,
        owner.userId as never,
        "mailbox.invalidated",
      );
      return context.json(
        { status: "success", data: { threadId: started as ThreadId } },
        201,
        noStore,
      );
    }),
  );

const projectIdOf = (context: Context<AppEnv>) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(ProjectId)(context.req.param("projectId") ?? ""),
  );

/** Project Settings → Email: the viewer's own address for the Project. */
const projectMail = async (
  context: Context<AppEnv>,
  projectId: ProjectId,
): Promise<Response> => {
  const db = context.env.DB as D1Database;
  const principal = context.get("principal") as Principal;
  const configuration = await mailboxFor(context.env, principal.userId);
  if (configuration === undefined)
    return context.json(
      {
        status: "success",
        data: { enabled: false },
      } satisfies GetProjectMailResponse,
      200,
      noStore,
    );
  const project = await reachableProject(db, principal, projectId);
  const owner = await readMailboxOwner(db, principal.userId);
  if (project === undefined || owner === undefined)
    return fail(context, 404, "MAIL_NOT_FOUND", "That project was not found.");
  const row = await db
    .prepare("SELECT name, workspace_id, deleted_at FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{
      name: string;
      workspace_id: string | null;
      deleted_at: string | null;
    }>();
  if (row === null || row.deleted_at !== null || row.name === "No Project")
    return context.json(
      {
        status: "success",
        data: { enabled: false },
      } satisfies GetProjectMailResponse,
      200,
      noStore,
    );
  const tag = await ensureProjectTag(db, owner.userId, projectId, row.name);
  return context.json(
    {
      status: "success",
      data: {
        enabled: true,
        address: mailboxAddress(owner.username, configuration.domain, tag),
      },
    } satisfies GetProjectMailResponse,
    200,
    noStore,
  );
};

export const projectMailRoutes = new Hono<AppEnv>().get(
  "/:projectId/mail",
  async (context) => {
    const projectId = projectIdOf(context);
    if (projectId === undefined)
      return fail(
        context,
        400,
        "MAIL_INVALID_REQUEST",
        "Request validation failed.",
      );
    return projectMail(context, projectId);
  },
);

/**
 * Local development only: `POST /dev/mail/inbound?from=…&to=…` with a raw
 * `.eml` body runs the same `handleInboundMail` Cloudflare's email handler
 * runs, and answers what happened and what dx would have sent back. With
 * `authentication=<results>`, it first prepends the header Cloudflare's
 * server adds, `Authentication-Results: mx.cloudflare.net; <results>`.
 * `GET /dev/mail/outbox` lists the mail local development kept instead of
 * sending.
 */
/**
 * Deployment-admin mail routes, mounted under `/v1/deployment-admin/users`
 * behind the admin check (auth/deployment-admin.ts): pause or resume a
 * person's sending. Logged with the admin's id.
 */
export const deploymentAdminMailRoutes = new Hono<AppEnv>()
  .get("/lookup", async (context) => {
    const query = (context.req.query("q") ?? "").trim();
    if (query === "" || query.length > 320)
      return fail(
        context,
        400,
        "MAIL_INVALID_REQUEST",
        "Enter a sign-in email or a username.",
      );
    const db = context.env.DB as D1Database;
    const username = normalizePersonalAccountUsername(query);
    const row = await db
      .prepare(
        `SELECT person.id, person.name, person.email, account.username,
                account.username_changed_at, mailbox.sending_suspended_at
           FROM "user" AS person
           JOIN personal_account AS account ON account.user_id = person.id
           LEFT JOIN mailbox ON mailbox.user_id = person.id
          WHERE lower(person.email) = lower(?1)
             OR account.username = ?2 COLLATE NOCASE
             OR person.id IN (
               SELECT user_id FROM retired_username
                WHERE username = ?2 COLLATE NOCASE)
          LIMIT 1`,
      )
      .bind(query, username)
      .first<{
        id: string;
        name: string;
        email: string;
        username: string;
        username_changed_at: string | null;
        sending_suspended_at: string | null;
      }>();
    if (row === null)
      return fail(
        context,
        404,
        "MAIL_NOT_FOUND",
        "No account has that sign-in email or username.",
      );
    return context.json(
      Schema.encodeUnknownSync(DeploymentAdminPersonResponseSchema)({
        status: "success",
        data: {
          userId: row.id,
          name: row.name,
          email: row.email,
          username: row.username,
          usernameChangeAvailable: personalAccountUsernameChangeAvailable({
            username: row.username,
            usernameChangedAt: row.username_changed_at,
          }),
          mailSendingSuspended: row.sending_suspended_at !== null,
        },
      }),
      200,
      noStore,
    );
  })
  .put("/:userId/mail-sending", async (context) => {
    const body = Schema.decodeUnknownOption(SetMailSendingRequestSchema)(
      await readBoundedJson(context.req.raw).catch(() => undefined),
    );
    if (Option.isNone(body))
      return fail(
        context,
        400,
        "MAIL_INVALID_REQUEST",
        "Request validation failed.",
      );
    const db = context.env.DB as D1Database;
    const userId = context.req.param("userId") ?? "";
    if (!(await setMailSendingSuspended(db, userId, body.value.suspended)))
      return fail(
        context,
        404,
        "MAIL_NOT_FOUND",
        "No account has that user ID.",
      );
    mailLogger.info("A deployment admin changed a person's sending.", {
      event: body.value.suspended
        ? "mail_sending_suspended"
        : "mail_sending_resumed",
      adminUserId: (context.get("principal") as Principal).userId,
      targetUserId: userId,
    });
    return context.json(
      Schema.encodeUnknownSync(SetMailSendingResponseSchema)({
        status: "success",
        data: { userId, suspended: body.value.suspended },
      }),
      200,
      noStore,
    );
  });

export const devMailRoutes = new Hono<AppEnv>()
  .post("/inbound", async (context) => {
    if (context.env.DX_RUNTIME_MODE !== "local")
      return context.json({ status: "error" }, 404);
    const body = await readBoundedBody(
      context.req.raw,
      MAX_INBOUND_MAIL_BYTES,
    ).catch(() => undefined);
    if (body === undefined) return context.json({ status: "error" }, 413);
    const from = context.req.query("from") ?? "";
    const to = context.req.query("to") ?? "";
    const results = context.req.query("authentication");
    const raw =
      results === undefined
        ? new Uint8Array(body)
        : new Uint8Array([
            ...new TextEncoder().encode(
              `Authentication-Results: mx.cloudflare.net; ${results}\r\n`,
            ),
            ...new Uint8Array(body),
          ]);
    const replies: Array<{ from: string; to: string; raw: string }> = [];
    let rejected: string | undefined;
    const outcome = await handleInboundMail(
      context.env,
      {
        from,
        to,
        raw,
        reply: async (message) => {
          replies.push(message);
        },
        setReject: (reason) => {
          rejected = reason;
        },
      },
      (promise) => context.executionCtx.waitUntil(promise),
    );
    return context.json(
      {
        status: "success",
        data: {
          outcome,
          replies,
          ...(rejected === undefined ? {} : { rejected }),
          appOrigin: await appOrigin(context.env),
        },
      },
      200,
      noStore,
    );
  })
  .get("/outbox", async (context) => {
    const bucket = context.env.DX_STORAGE;
    if (context.env.DX_RUNTIME_MODE !== "local" || bucket === undefined)
      return context.json({ status: "error" }, 404);
    const listed = await bucket.list({ prefix: LOCAL_OUTBOX_PREFIX });
    const messages = [];
    for (const object of listed.objects) {
      const stored = await bucket.get(object.key);
      if (stored !== null) messages.push(await stored.json());
    }
    return context.json(
      { status: "success", data: { messages } },
      200,
      noStore,
    );
  });
