import {
  AGENT_MENTION,
  parseMessageAttachments,
  stripMessageAttachmentTags,
  stripMessageAuthorTags,
  type ThreadConversationMode,
  withMessageAuthor,
} from "@dx/api";
import { ThreadId, ThreadRepository, type UserId } from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Schema } from "effect";
import type { Context, MiddlewareHandler } from "hono";
import {
  linkMessageAttachments,
  MessageAttachmentsRejected,
  messageAttachmentBody,
  type ResolvedMessageAttachments,
  resolveMessageAttachments,
} from "../attachments/message.js";
import type { AppEnv } from "../http/types.js";
import { threadSharingLogger } from "../logging.js";
import { scheduleNotification } from "../notifications/publish.js";
import {
  publishRealtimeInvalidation,
  scheduleRealtimeInvalidation,
} from "../realtime/publication.js";
import { ThreadRepositoryD1 } from "../threads/repository-d1.js";
import { threadDetailData } from "../threads/routes.js";
import { wakeSnoozedThread } from "../threads/snooze.js";
import {
  canUseSharedThreads,
  findSharedThreadGrant,
  impersonateThreadOwner,
} from "./access.js";
import {
  classifyMessage,
  conversationMode,
  followThread,
  switchConversationMode,
  threadMembers,
} from "./members.js";
import { recordParticipant, userIdentity } from "./service.js";

/**
 * Thread detail and readiness reads for a member of a shared Thread run as the
 * owner. Owners and everyone else fall through unchanged, so the route keeps
 * its own validation and not-found responses.
 */
export const shareThreadReads: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const principal = context.get("principal");
  const db = context.env.DB;
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (
    context.req.method !== "GET" ||
    db === undefined ||
    Option.isNone(threadId) ||
    !canUseSharedThreads(principal)
  )
    return next();
  context.set("actor", principal);
  context.set("threadAccess", "owner");
  const grant = await findSharedThreadGrant(
    db,
    threadId.value,
    principal.userId,
  );
  if (grant === undefined) return next();
  context.set("threadAccess", grant.access);
  context.set("threadOwnerUserId", grant.ownerUserId);
  context.set(
    "principal",
    impersonateThreadOwner(principal, grant.ownerUserId),
  );
  if (!context.req.path.endsWith("/readiness"))
    await recordParticipant(db, threadId.value, principal.userId as UserId, {
      message: false,
    }).catch((cause) =>
      threadSharingLogger.warn("Thread participant was not recorded.", {
        event: "thread_participant_record_failed",
        cause,
      }),
    );
  return next();
};

/**
 * The owner's agent initialization for a Thread. Members never receive it
 * (Thread detail hides the owner's instructions), so when a member's send
 * would create the Flue instance the server supplies the real one.
 */
const ownerAgentInitialization = (
  bindings: AppEnv["Bindings"],
  db: D1Database,
  threadId: ThreadId,
  ownerUserId: UserId,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const threads = yield* ThreadRepository;
      const thread = yield* threads.findOwnedById(threadId, ownerUserId);
      return (yield* threadDetailData(bindings.DB, db, thread))
        .agentInitialization;
    }).pipe(
      Effect.provide(
        ThreadRepositoryD1.pipe(Layer.provide(D1Client.layer({ db }))),
      ),
    ),
  );

/**
 * dx's name for a message that tags someone, so a notification can open the
 * Thread at it. It derives from the delivery's idempotency key, which a
 * client reuses on retry, so a retried message carries an identical tag.
 */
const messageIdFor = async (threadId: ThreadId, deliveryKey: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`dx-message\n${threadId}\n${deliveryKey}`),
  );
  return `msg_${[...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

/** Flue refuses a longer chat body, author tag included. */
const MAX_CHAT_BODY_LENGTH = 32_000;

/**
 * Runs work after the response, or inline where there is no
 * ExecutionContext (tests and in-process callers).
 */
const afterResponse = (context: Context<AppEnv>, work: Promise<unknown>) => {
  try {
    context.executionCtx.waitUntil(work);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === "This context has no ExecutionContext"
    )
      return work;
    throw cause;
  }
};

const rejectDelivery = (context: Context<AppEnv>, message: string) =>
  context.json(
    {
      status: "error",
      data: {
        code: "INVALID_REQUEST",
        message,
        requestId: context.get("requestId"),
      },
    },
    400,
  );

/**
 * Names the sender of every user message the agent receives: the body gains a
 * `<dx_message_author …/>` tag before Flue admits it. The model sees who is
 * speaking; clients label the message from the same tag. Everything the agent
 * then does still runs as the owner.
 *
 * In a shared Thread the message's tags also pick its mode (see
 * `classifyMessage`). A chat message is delivered to Flue as
 * `{ kind: "chat" }`: Flue records it for everyone in the Thread without a
 * model call and gives it to the agent ahead of its next input.
 */
export const attributeSubmission: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const db = context.env.DB;
  // Read the route parameter before `next()`: afterwards it belongs to the
  // downstream Flue router.
  const threadId = Schema.decodeUnknownOption(ThreadId)(
    context.req.param("threadId"),
  );
  if (
    context.req.method !== "POST" ||
    db === undefined ||
    Option.isNone(threadId)
  )
    return next();
  const actor = context.get("actor");
  const access = context.get("threadAccess");
  const sourceThreadId = context.get("messageSourceThreadId");
  const automation = context.get("messageAutomation");
  const delivered: unknown = await context.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  // Flue renders a signal's tag and attributes verbatim, so a signal could
  // pose as any sender, and a chat delivery would skip the author tag. dx
  // never sends either over HTTP.
  if (
    typeof delivered === "object" &&
    delivered !== null &&
    "kind" in delivered &&
    (delivered.kind === "signal" || delivered.kind === "chat")
  )
    return rejectDelivery(
      context,
      "Only user messages can be sent to a Thread.",
    );
  const userMessage =
    typeof delivered === "object" &&
    delivered !== null &&
    "kind" in delivered &&
    delivered.kind === "user" &&
    "body" in delivered &&
    typeof delivered.body === "string"
      ? { ...delivered, body: delivered.body }
      : undefined;
  let mentioned: ReadonlyArray<UserId> = [];
  let mention: { messageId: string; excerpt: string } | undefined;
  let switchTo: ThreadConversationMode | undefined;
  let attachments: ResolvedMessageAttachments | undefined;
  if (userMessage !== undefined) {
    const [identity, initialData, members] = await Promise.all([
      userIdentity(db, actor.userId as UserId),
      access !== "owner" && "initialData" in userMessage
        ? ownerAgentInitialization(
            context.env,
            db,
            threadId.value,
            context.get("threadOwnerUserId") as UserId,
          ).then((owner) => ({ initialData: owner }))
        : Promise.resolve({}),
      threadMembers(db, threadId.value),
    ]);
    // Members are listed only while the Thread is shared; a private Thread
    // is always in agent mode. Tags count only in the text the message
    // keeps: the forged tags it strips can hide text.
    const classified =
      members.length === 0
        ? { mode: undefined, mentions: [] }
        : classifyMessage(
            stripMessageAuthorTags(
              stripMessageAttachmentTags(userMessage.body),
            ),
            members,
            actor.userId,
          );
    const { mentions } = classified;
    // Another Thread's agent always addresses this Thread's agent, and its
    // tags never switch the members' mode.
    switchTo =
      sourceThreadId === undefined && automation === undefined
        ? classified.mode
        : undefined;
    // The switch is recorded once Flue admits the message, so a refused
    // message never changes the mode.
    const mode =
      members.length === 0 ||
      sourceThreadId !== undefined ||
      automation !== undefined
        ? "agent"
        : (switchTo ?? (await conversationMode(db, threadId.value)));
    mentioned = mentions.flatMap(({ userId }) =>
      userId === actor.userId ? [] : [userId as UserId],
    );
    const chat = mode === "chat";
    if (
      chat &&
      (parseMessageAttachments(userMessage.body).attachments.length > 0 ||
        ("attachments" in userMessage &&
          Array.isArray(userMessage.attachments) &&
          userMessage.attachments.length > 0))
    )
      return rejectDelivery(
        context,
        `Chat messages can't include attachments. Tag @${AGENT_MENTION} to send them.`,
      );
    // The files are recorded as sent only once Flue admits the message.
    try {
      attachments = await resolveMessageAttachments(context.env, {
        senderUserId: actor.userId,
        body: userMessage.body,
      });
    } catch (cause) {
      if (cause instanceof MessageAttachmentsRejected)
        return rejectDelivery(context, cause.message);
      throw cause;
    }
    const admittedBody = messageAttachmentBody(
      context.env,
      attachments,
      context.req.url,
    ).body;
    // Flue names a chat message by its key, so a retry converges on it.
    const deliveryKey =
      "idempotencyKey" in userMessage &&
      typeof userMessage.idempotencyKey === "string" &&
      userMessage.idempotencyKey !== ""
        ? userMessage.idempotencyKey
        : chat
          ? crypto.randomUUID()
          : undefined;
    const messageId =
      mentioned.length === 0
        ? undefined
        : await messageIdFor(
            threadId.value,
            deliveryKey ?? crypto.randomUUID(),
          );
    if (messageId !== undefined)
      mention = {
        messageId,
        excerpt: parseMessageAttachments(
          stripMessageAuthorTags(userMessage.body),
        ).text,
      };
    const body = withMessageAuthor(
      {
        author: {
          role: access === "owner" ? "owner" : "contributor",
          userId: actor.userId,
          ...identity,
        },
        ...(chat ? { chat } : {}),
        mentions,
        // Set only by the in-process Thread tools, never from a request.
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
        ...(automation === undefined ? {} : { automation }),
        ...(messageId === undefined ? {} : { messageId }),
      },
      admittedBody,
    );
    if (chat && body.length > MAX_CHAT_BODY_LENGTH)
      return rejectDelivery(
        context,
        `This chat message is too long. Shorten it, or tag @${AGENT_MENTION} to send it to the agent.`,
      );
    const {
      kind: _kind,
      attachments: _attachments,
      ...rest
    } = userMessage as typeof userMessage & { attachments?: unknown };
    const rewritten = chat
      ? {
          ...rest,
          ...initialData,
          kind: "chat",
          body,
          idempotencyKey: deliveryKey,
        }
      : { ...userMessage, ...initialData, body };
    context.set("chatDelivery", chat);
    const headers = new Headers(context.req.raw.headers);
    headers.delete("content-length");
    context.req.raw = new Request(context.req.raw, {
      headers,
      body: JSON.stringify(rewritten),
    });
  }
  await next();
  if (context.res.status !== 202) return;
  // Awaited, so the 202 means every reader of the Thread can open the files
  // and the next message is classified in the mode this one chose.
  if (attachments !== undefined)
    await linkMessageAttachments(db, {
      threadId: threadId.value,
      senderUserId: actor.userId,
      rows: attachments.rows,
    }).catch((cause) =>
      threadSharingLogger.warn("Message attachments were not recorded.", {
        event: "message_attachments_record_failed",
        cause,
      }),
    );
  const modeChanged =
    switchTo !== undefined &&
    (await switchConversationMode(db, threadId.value, switchTo).catch(
      (cause) => {
        threadSharingLogger.warn("Thread mode was not recorded.", {
          event: "thread_mode_record_failed",
          cause,
        });
        return false;
      },
    ));
  if (mention !== undefined)
    await scheduleNotification(() => context.executionCtx, context.env, {
      topic: "mention",
      sourceKey: `mention:${threadId.value}:${mention.messageId}`,
      recipients: mentioned,
      threadId: threadId.value,
      messageId: mention.messageId,
      actorUserId: actor.userId as UserId,
      excerpt: mention.excerpt,
    });
  // Only a snoozed Thread pays for the write; authorization read its row.
  if (
    userMessage !== undefined &&
    sourceThreadId === undefined &&
    automation === undefined &&
    context.get("threadSnoozed") === true
  )
    await afterResponse(
      context,
      wakeSnoozedThread(db, threadId.value)
        .then((woke) =>
          woke
            ? publishRealtimeInvalidation(
                context.env,
                threadId.value,
                "thread.invalidated",
              )
            : undefined,
        )
        .catch((cause) =>
          threadSharingLogger.warn("Snoozed Thread was not woken.", {
            event: "thread_snooze_wake_failed",
            cause,
          }),
        ),
    );
  if (!modeChanged && mentioned.length === 0 && access !== "contribute") return;
  await afterResponse(
    context,
    Promise.all([
      // Tagging a member follows the Thread for them; the owner always does.
      followThread(
        db,
        threadId.value,
        mentioned.filter(
          (userId) => userId !== context.get("threadOwnerUserId"),
        ),
      ),
      access === "contribute"
        ? recordParticipant(db, threadId.value, actor.userId as UserId, {
            message: true,
          })
        : undefined,
    ])
      .catch((cause) =>
        threadSharingLogger.warn(
          "Thread follower or participant was not recorded.",
          { event: "thread_participant_record_failed", cause },
        ),
      )
      // A new mode, participant, or follower changes Thread detail and the
      // sidebars of everyone who can open the Thread.
      .then(() =>
        scheduleRealtimeInvalidation(
          () => context.executionCtx,
          context.env,
          threadId.value,
          "thread.invalidated",
          mentioned.length === 0 ? undefined : "audience",
        ),
      ),
  );
};
