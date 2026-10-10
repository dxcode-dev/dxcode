import {
  AGENT_MENTION,
  type ThreadConversationMode,
  withMessageAuthor,
} from "@dx/api";
import { ThreadId, ThreadRepository, type UserId } from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Schema } from "effect";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadSharingLogger } from "../logging.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { ThreadRepositoryD1 } from "../threads/repository-d1.js";
import { threadDetailData } from "../threads/routes.js";
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
  let switchTo: ThreadConversationMode | undefined;
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
    // is always in agent mode.
    const classified =
      members.length === 0
        ? { mode: undefined, mentions: [] }
        : classifyMessage(userMessage.body, members, actor.userId);
    const { mentions } = classified;
    switchTo = classified.mode;
    // The switch is recorded once Flue admits the message, so a refused
    // message never changes the mode.
    const mode =
      members.length === 0
        ? "agent"
        : (switchTo ?? (await conversationMode(db, threadId.value)));
    mentioned = mentions.flatMap(({ userId }) =>
      userId === actor.userId ? [] : [userId as UserId],
    );
    const chat = mode === "chat";
    if (
      chat &&
      "attachments" in userMessage &&
      Array.isArray(userMessage.attachments) &&
      userMessage.attachments.length > 0
    )
      return rejectDelivery(
        context,
        `Chat messages can't include images. Tag @${AGENT_MENTION} to send them.`,
      );
    const body = withMessageAuthor(
      {
        author: {
          role: access === "owner" ? "owner" : "contributor",
          userId: actor.userId,
          ...identity,
        },
        ...(chat ? { chat } : {}),
        mentions,
      },
      userMessage.body,
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
          // Flue names a chat message by its key; a retry converges on it.
          idempotencyKey:
            "idempotencyKey" in userMessage &&
            typeof userMessage.idempotencyKey === "string" &&
            userMessage.idempotencyKey !== ""
              ? userMessage.idempotencyKey
              : crypto.randomUUID(),
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
  let modeChanged = false;
  try {
    if (switchTo !== undefined)
      modeChanged = await switchConversationMode(db, threadId.value, switchTo);
    // Tagging a member follows the Thread for them; the owner always does.
    await followThread(
      db,
      threadId.value,
      mentioned.filter((userId) => userId !== context.get("threadOwnerUserId")),
    );
    if (access === "contribute")
      await recordParticipant(db, threadId.value, actor.userId as UserId, {
        message: true,
      });
  } catch (cause) {
    threadSharingLogger.warn(
      "Thread mode, follower, or participant was not recorded.",
      { event: "thread_participant_record_failed", cause },
    );
  }
  if (!modeChanged && mentioned.length === 0 && access !== "contribute") return;
  // A new mode, participant, or follower changes Thread detail and the
  // sidebars of everyone who can open the Thread.
  await scheduleRealtimeInvalidation(
    () => context.executionCtx,
    context.env,
    threadId.value,
    "thread.invalidated",
    mentioned.length === 0 ? undefined : "audience",
  );
};
