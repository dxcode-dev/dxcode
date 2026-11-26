import {
  DeleteThreadMessageRequestSchema,
  DeleteThreadMessageResponseSchema,
  EditQueuedThreadMessageRequestSchema,
  EditQueuedThreadMessageResponseSchema,
  ListThreadQueuedMessagesResponseSchema,
  parseMessageAttachments,
  parseMessageAuthor,
  QUEUED_SUBMISSION_ID,
  stripMessageAuthorTags,
  THREAD_MESSAGE_ENTRY_ID,
  type ThreadMessageQueueErrorCode,
  ThreadMessageQueueErrorResponseSchema,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type {
  QueuedThreadMessage,
  ReplaceThreadMessageResult,
  WithdrawThreadMessageResult,
} from "../agents/routes.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import { sha256Hex } from "./agent-tools.js";
import {
  type MessageEditAgent,
  reindexAfterRewind,
  sendThreadMessageAs,
  sentByActor,
  stopAndRewind,
} from "./message-edit-route.js";
import {
  markThreadRewound,
  unmarkThreadRewound,
} from "./message-rewind-flag.js";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEdit = Schema.decodeUnknownOption(
  EditQueuedThreadMessageRequestSchema,
);
const decodeDelete = Schema.decodeUnknownOption(
  DeleteThreadMessageRequestSchema,
);

/** Flue's submission ids: a UUID or a keyed hash, never a path. */
const SUBMISSION_ID = QUEUED_SUBMISSION_ID;

/**
 * A body no message has: a rewind with it only finds its key, and a withdraw
 * with it only reports where the message went.
 */
const NEVER_THE_TEXT = "\u0000dx: a rewind recorded under this key";

const MESSAGES: Record<
  Exclude<ThreadMessageQueueErrorCode, "MESSAGE_READ">,
  string
> = {
  INVALID_REQUEST: "Request validation failed.",
  THREAD_NOT_FOUND: "Thread was not found.",
  THREAD_ARCHIVED: "Thread is archived. Unarchive it before continuing.",
  SPACE_POSTS_EDIT_IN_PLACE: "Edit a Space's posts from the post.",
  MESSAGE_NOT_YOURS: "Only the person who sent a message can change it.",
  MESSAGE_CHANGED:
    "This message is no longer in the conversation as shown. Reload and try again.",
  MESSAGE_GONE: "This message is no longer waiting or in the conversation.",
  AGENT_BUSY: "The agent did not stop in time. Try again in a moment.",
  EDIT_NOT_SENT:
    "The conversation went back to before your message, but the edited message was not sent. Send it again.",
  PERSISTENCE_UNAVAILABLE: "Persistence is temporarily unavailable.",
};

const refuse = (
  context: Context<AppEnv>,
  code: Exclude<ThreadMessageQueueErrorCode, "MESSAGE_READ">,
  status: 400 | 403 | 404 | 409 | 502 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadMessageQueueErrorResponseSchema)({
      status: "error",
      data: {
        code,
        message: MESSAGES[code],
        requestId: context.get("requestId"),
      },
    } as never),
    status,
  );

/** The agent took a queued message first; it now has an entry id. */
const refuseRead = (context: Context<AppEnv>, entryId: string) =>
  context.json(
    Schema.encodeUnknownSync(ThreadMessageQueueErrorResponseSchema)({
      status: "error",
      data: {
        code: "MESSAGE_READ",
        message: "The agent read this message before the change arrived.",
        requestId: context.get("requestId"),
        entryId,
      },
    }),
    409,
  );

/** The Thread's agent, as the queue routes drive it. */
export interface MessageQueueAgent extends MessageEditAgent {
  /**
   * Flue's withdraw: settles a submission only while it is still queued
   * with `expectBody`.
   */
  readonly withdraw: (
    threadId: string,
    submissionId: string,
    expectBody: string,
    env: Bindings,
  ) => Promise<WithdrawThreadMessageResult>;
  /**
   * Flue's replace: rewrites a queued submission's text in place, only
   * while it is still queued with `expectBody`.
   */
  readonly replace: (
    threadId: string,
    submissionId: string,
    expectBody: string,
    body: string,
    env: Bindings,
  ) => Promise<ReplaceThreadMessageResult>;
  /** The Thread's queued messages, author tags included. */
  readonly queued: (
    threadId: string,
    env: Bindings,
  ) => Promise<ReadonlyArray<QueuedThreadMessage>>;
}

/** The Thread and the route's common refusals; a Response when refused. */
const admitThread = (context: Context<AppEnv>) => {
  const threadId = decodeThreadId(context.req.param("threadId"));
  if (Option.isNone(threadId))
    return refuse(context, "INVALID_REQUEST", 400) as Response;
  if (context.get("threadKind") === "space")
    return refuse(context, "SPACE_POSTS_EDIT_IN_PLACE", 409) as Response;
  if (context.get("threadLifecycleState") === "archived")
    return refuse(context, "THREAD_ARCHIVED", 409) as Response;
  return threadId.value;
};

/**
 * The actor's queued message, or how to answer when it is not in the queue
 * any more (`undefined`) or is someone else's (a 403).
 */
const ownQueued = async (
  agent: MessageQueueAgent,
  context: Context<AppEnv>,
  threadId: string,
  submissionId: string,
) => {
  const found = (await agent.queued(threadId, context.env)).find(
    (message) => message.submissionId === submissionId,
  );
  if (found === undefined) return undefined;
  return sentByActor(found.body, context.get("actor").userId)
    ? found
    : (refuse(context, "MESSAGE_NOT_YOURS", 403) as Response);
};

/**
 * The edited text as the agent will get it: the queued message's author tag
 * (who sent it, and how), then the new text, stripped of any tags typed in it.
 */
const retagged = (original: string, body: string) =>
  `${original.slice(0, original.length - parseMessageAuthor(original).text.length)}${stripMessageAuthorTags(body)}`;

/**
 * Message edit, delete, and queue routes behind Thread authorization:
 *
 * - `GET /:threadId/messages/queued`: the viewer's own messages waiting for
 *   the agent to read them, which they can still change in place.
 * - `POST /:threadId/messages/queued/:submissionId/edit`: replaces a waiting
 *   message's text in place: same submission, same place in the queue.
 *   Flue rewrites it only while it is still queued with the text this route
 *   checked the sender of, in the same Durable Object that hands queued
 *   messages to the agent, so exactly one of the edit and the agent's pickup
 *   wins (`replaced`). One the agent took first is edited as any read
 *   message is: Stop, rewind to just before it, send the new text tagged as
 *   an edit (`restarted`).
 * - `POST /:threadId/messages/queued/:submissionId/delete`: withdraws a
 *   waiting message. One the agent took first is refused with its entry id
 *   (`MESSAGE_READ`): deleting a read message removes everything after it,
 *   so the person confirms that again.
 * - `POST /:threadId/messages/:entryId/delete`: the person's read message
 *   and everything after it leave the conversation: Stop, rewind to just
 *   before it, send nothing. The next message the agent receives is tagged
 *   `rewound="true"`.
 *
 * Retrying with the same key converges on the first outcome.
 */
export const createThreadMessageQueueRoutes = (agent: MessageQueueAgent) =>
  new Hono<AppEnv>()
    .get("/:threadId/messages/queued", async (context) => {
      const threadId = admitThread(context);
      if (threadId instanceof Response) return threadId;
      const actor = context.get("actor").userId;
      const messages = (await agent.queued(threadId, context.env)).flatMap(
        (message) => {
          if (!sentByActor(message.body, actor)) return [];
          const { text, attachments } = parseMessageAttachments(
            parseMessageAuthor(message.body).text,
          );
          return [
            {
              submissionId: message.submissionId,
              text,
              original: message.body,
              attachments: [...attachments],
              createdAt: message.acceptedAt,
            },
          ];
        },
      );
      return context.json(
        Schema.encodeUnknownSync(ListThreadQueuedMessagesResponseSchema)({
          status: "success",
          data: { messages },
        }),
        200,
      );
    })
    .post("/:threadId/messages/queued/:submissionId/edit", async (context) => {
      const threadId = admitThread(context);
      if (threadId instanceof Response) return threadId;
      const submissionId = context.req.param("submissionId");
      const request = decodeEdit(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (
        Option.isNone(request) ||
        !SUBMISSION_ID.test(submissionId) ||
        request.value.body.trim() === ""
      )
        return refuse(context, "INVALID_REQUEST", 400);
      const key = await sha256Hex(
        `queued-message-edit\n${threadId}\n${submissionId}\n${request.value.idempotencyKey}`,
      );
      const own = await ownQueued(agent, context, threadId, submissionId);
      if (own instanceof Response) return own;
      // Not listed: a retry of an edit that replaced or restarted, or one the
      // agent took. The never-matching text changes nothing either way.
      const replaced = await agent.replace(
        threadId,
        submissionId,
        own?.body ?? NEVER_THE_TEXT,
        own === undefined
          ? NEVER_THE_TEXT
          : retagged(own.body, request.value.body),
        context.env,
      );
      if (replaced.replaced)
        return context.json(
          Schema.encodeUnknownSync(EditQueuedThreadMessageResponseSchema)({
            status: "success",
            data: { outcome: "replaced", submissionId },
          }),
          200,
        );
      if (replaced.status === "absent")
        return refuse(context, "MESSAGE_GONE", 409);
      // Still queued with other text: edited from elsewhere meanwhile.
      if (replaced.status === "queued")
        return refuse(context, "MESSAGE_CHANGED", 409);
      const { entryId } = replaced as { readonly entryId: string };
      if (own === undefined) {
        // Not in the queue when this request looked: a retry of an edit
        // that restarted converges on that rewind; otherwise the client
        // edits the message the agent read, which it shows by now.
        const rewind = await agent.rewind(
          threadId,
          { entryId, idempotencyKey: key, expectText: NEVER_THE_TEXT },
          context.env,
        );
        await rewind.body?.cancel();
        if (!rewind.ok) return refuseRead(context, entryId);
      } else {
        // The agent took it between the read and the replace: the edit
        // restarts from it, with the text this request checked the sender of.
        const rewound = await stopAndRewind(agent, context.env, threadId, {
          entryId,
          idempotencyKey: key,
          expectText: own.body,
        });
        if (rewound === "busy") return refuse(context, "AGENT_BUSY", 409);
        if (rewound === "changed")
          return refuse(context, "MESSAGE_CHANGED", 409);
      }
      const delivered = await sendThreadMessageAs(agent, context, {
        threadId,
        body: request.value.body,
        idempotencyKey: key,
        edit: true,
      });
      reindexAfterRewind(context, threadId);
      if (delivered.status !== 202 || delivered.submissionId === undefined)
        return refuse(context, "EDIT_NOT_SENT", 502);
      return context.json(
        Schema.encodeUnknownSync(EditQueuedThreadMessageResponseSchema)({
          status: "success",
          data: { outcome: "restarted", submissionId: delivered.submissionId },
        }),
        200,
      );
    })
    .post(
      "/:threadId/messages/queued/:submissionId/delete",
      async (context) => {
        const threadId = admitThread(context);
        if (threadId instanceof Response) return threadId;
        const submissionId = context.req.param("submissionId");
        const request = decodeDelete(
          await readBoundedJson(context.req.raw).catch(() => undefined),
        );
        if (Option.isNone(request) || !SUBMISSION_ID.test(submissionId))
          return refuse(context, "INVALID_REQUEST", 400);
        const own = await ownQueued(agent, context, threadId, submissionId);
        if (own instanceof Response) return own;
        // Withdrawing changes only the queued message `own` checked the
        // sender of; otherwise it reports where the message went.
        const withdrawn = await agent.withdraw(
          threadId,
          submissionId,
          own?.body ?? NEVER_THE_TEXT,
          context.env,
        );
        if (withdrawn.withdrawn)
          return context.json(
            Schema.encodeUnknownSync(DeleteThreadMessageResponseSchema)({
              status: "success",
              data: { outcome: "withdrawn" },
            }),
            200,
          );
        if (withdrawn.status === "absent")
          return refuse(context, "MESSAGE_GONE", 409);
        if (withdrawn.status === "queued")
          return refuse(context, "MESSAGE_CHANGED", 409);
        return refuseRead(
          context,
          (withdrawn as { readonly entryId: string }).entryId,
        );
      },
    )
    .post("/:threadId/messages/:entryId/delete", async (context) => {
      const threadId = admitThread(context);
      if (threadId instanceof Response) return threadId;
      const entryId = context.req.param("entryId");
      const request = decodeDelete(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (
        Option.isNone(request) ||
        request.value.original === undefined ||
        !THREAD_MESSAGE_ENTRY_ID.test(entryId)
      )
        return refuse(context, "INVALID_REQUEST", 400);
      const db = context.env.DB;
      if (db === undefined)
        return refuse(context, "PERSISTENCE_UNAVAILABLE", 503);
      if (!sentByActor(request.value.original, context.get("actor").userId))
        return refuse(context, "MESSAGE_NOT_YOURS", 403);
      const key = await sha256Hex(
        `message-delete\n${threadId}\n${request.value.idempotencyKey}`,
      );
      // Marked first, so no message reaches the agent after the rewind
      // without it; a refused rewind takes the mark back.
      const mark = await markThreadRewound(db, threadId).catch((cause) => {
        threadPersistenceLogger.warn(
          "A deleted message's rewind was not marked for the agent.",
          { event: "thread_rewind_mark_failed", threadId, cause },
        );
        return undefined;
      });
      if (mark === undefined)
        return refuse(context, "PERSISTENCE_UNAVAILABLE", 503);
      const rewound = await stopAndRewind(agent, context.env, threadId, {
        entryId,
        idempotencyKey: key,
        expectText: request.value.original,
      }).catch(async (cause) => {
        await unmarkThreadRewound(db, threadId, mark).catch(() => undefined);
        throw cause;
      });
      if (rewound !== "rewound")
        await unmarkThreadRewound(db, threadId, mark).catch((cause) =>
          threadPersistenceLogger.warn(
            "A refused delete's rewind mark was not taken back.",
            { event: "thread_rewind_unmark_failed", threadId, cause },
          ),
        );
      if (rewound === "busy") return refuse(context, "AGENT_BUSY", 409);
      if (rewound === "changed") return refuse(context, "MESSAGE_CHANGED", 409);
      reindexAfterRewind(context, threadId);
      return context.json(
        Schema.encodeUnknownSync(DeleteThreadMessageResponseSchema)({
          status: "success",
          data: { outcome: "rewound" },
        }),
        200,
      );
    });
