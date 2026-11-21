import {
  type EditThreadMessageErrorCode,
  EditThreadMessageErrorResponseSchema,
  EditThreadMessageRequestSchema,
  EditThreadMessageResponseSchema,
  parseMessageAuthor,
  THREAD_MESSAGE_ENTRY_ID,
} from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import { enqueueThreadSearchIndex } from "../thread-search/enqueue.js";
import { ownerSearchIndex } from "../thread-search/index-client.js";
import { sha256Hex } from "./agent-tools.js";

const decodeRequest = Schema.decodeUnknownOption(
  EditThreadMessageRequestSchema,
);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** How long an edit waits for a stopped turn to settle before it gives up. */
const SETTLE_WAIT_MS = 15_000;
const SETTLE_POLL_MS = 250;

const MESSAGES: Record<EditThreadMessageErrorCode, string> = {
  INVALID_REQUEST: "Request validation failed.",
  THREAD_NOT_FOUND: "Thread was not found.",
  THREAD_ARCHIVED: "Thread is archived. Unarchive it before continuing.",
  SPACE_POSTS_EDIT_IN_PLACE: "Edit a Space's posts from the post.",
  MESSAGE_NOT_YOURS: "Only the person who sent a message can edit it.",
  MESSAGE_CHANGED:
    "This message is no longer in the conversation as shown. Reload and try again.",
  AGENT_BUSY: "The agent did not stop in time. Try again in a moment.",
  EDIT_NOT_SENT:
    "The conversation went back to before your message, but the edited message was not sent. Send it again.",
  PERSISTENCE_UNAVAILABLE: "Persistence is temporarily unavailable.",
};

const refuse = (
  context: Context<AppEnv>,
  code: EditThreadMessageErrorCode,
  status: 400 | 403 | 404 | 409 | 502 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(EditThreadMessageErrorResponseSchema)({
      status: "error",
      data: {
        code,
        message: MESSAGES[code],
        requestId: context.get("requestId"),
      },
    } as never),
    status,
  );

/** The Thread's agent, as the edit route drives it. */
export interface MessageEditAgent {
  /** Ends the running turn and everything queued behind it, as Stop does. */
  readonly stop: (threadId: string, env: Bindings) => Promise<void>;
  /** Flue's rewind, answered as Flue answers it (409 busy, 400 refused). */
  readonly rewind: (
    threadId: string,
    input: {
      readonly entryId: string;
      readonly idempotencyKey: string;
      readonly expectText: string;
    },
    env: Bindings,
  ) => Promise<Response> | Response;
  /** The agent's routes behind dx's admission, as mounted at `/v1/agents/dx`. */
  readonly routes: () => Promise<Hono<AppEnv>>;
}

/**
 * Sends a message through the agent's own routes behind dx's admission,
 * signed in as the person, so it is authorized, attributed, and admitted
 * like any message they send. `edit` marks its author tag as an edit.
 */
export const sendThreadMessageAs = async (
  agent: Pick<MessageEditAgent, "routes">,
  context: Context<AppEnv>,
  input: {
    readonly threadId: string;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly edit: boolean;
  },
) => {
  const dxAgentRoutes = await agent.routes();
  const actor = context.get("actor");
  const app = new Hono<AppEnv>();
  app.use(async (inner, next) => {
    inner.set("principal", actor);
    inner.set("requestId", context.get("requestId"));
    inner.set("requestStartedAt", Date.now());
    if (input.edit) inner.set("messageEdit", true);
    await next();
  });
  app.route("/v1/agents/dx", dxAgentRoutes);
  const response = await app.request(
    `/v1/agents/dx/${encodeURIComponent(input.threadId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user",
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      }),
    },
    context.env,
    context.executionCtx,
  );
  const payload = (await response.json().catch(() => undefined)) as
    | { readonly submissionId?: unknown }
    | undefined;
  return {
    status: response.status,
    submissionId:
      typeof payload?.submissionId === "string"
        ? payload.submissionId
        : undefined,
  };
};

/** How a stop-then-rewind ended; anything else throws. */
export type RewindOutcome = "rewound" | "busy" | "changed";

/**
 * Stops the running turn and everything queued, then takes the agent back
 * to just before `entryId`, waiting for the stopped turn to settle. A
 * retry with the same key converges: Flue records the rewind once.
 */
export const stopAndRewind = async (
  agent: Pick<MessageEditAgent, "stop" | "rewind">,
  env: Bindings,
  threadId: string,
  input: {
    readonly entryId: string;
    readonly idempotencyKey: string;
    readonly expectText: string;
  },
): Promise<RewindOutcome> => {
  // An idle agent, or a retry whose rewind this key already recorded, needs
  // no Stop: Stop would end whatever runs now, which the person never saw.
  const first = await agent.rewind(threadId, input, env);
  await first.body?.cancel();
  if (first.ok) return "rewound";
  if (first.status === 400) return "changed";
  if (first.status !== 409)
    throw new Error(`Rewinding the Thread's agent failed (${first.status}).`);
  await agent.stop(threadId, env);
  const deadline = Date.now() + SETTLE_WAIT_MS;
  for (;;) {
    const rewound = await agent.rewind(threadId, input, env);
    await rewound.body?.cancel();
    if (rewound.ok) return "rewound";
    if (rewound.status === 409 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      continue;
    }
    if (rewound.status === 409) return "busy";
    if (rewound.status === 400) return "changed";
    throw new Error(`Rewinding the Thread's agent failed (${rewound.status}).`);
  }
};

/**
 * The turns a rewind removed leave search too: drop the Thread's indexed
 * text and read its history again, after the response.
 */
export const reindexAfterRewind = (
  context: Context<AppEnv>,
  threadId: string,
) =>
  context.executionCtx.waitUntil(
    (async () => {
      try {
        await ownerSearchIndex(
          context.env,
          context.get("threadOwnerUserId"),
        )?.dropThread(threadId);
      } catch (cause) {
        threadPersistenceLogger.warn(
          "An edited Thread's search text could not be dropped.",
          { event: "thread_search_drop_failed", threadId, cause },
        );
      }
      await enqueueThreadSearchIndex(context.env, threadId);
    })(),
  );

/**
 * Whether `original` (a message as Flue holds it) is one the actor typed
 * themselves: not chat, nor one an automation, another Thread, a comment,
 * or a plugin sent.
 */
export const sentByActor = (original: string, actorUserId: string) => {
  const sent = parseMessageAuthor(original);
  return (
    sent.author?.userId === actorUserId &&
    sent.chat !== true &&
    sent.automation === undefined &&
    sent.sourceThreadId === undefined &&
    sent.commentOn === undefined &&
    sent.plugin === undefined
  );
};

/**
 * `POST /v1/threads/:threadId/messages/:entryId/edit`, behind Thread
 * authorization. A person replaces one of their earlier messages:
 *
 * 1. Their own message only, typed by them (not a chat, an automation's, or
 *    another Thread's), in an active Thread that is not a Space; a Space's
 *    posts keep their revisions instead.
 * 2. Stop ends the running turn and anything queued; the rewind waits for
 *    them to settle.
 * 3. The agent goes back to just before the message, if it still has the
 *    text the person saw: the later turns leave the transcript and the
 *    model's context. Files, artifacts, child Threads, and costs stay.
 * 4. The edited message is sent in its place, tagged as an edit, so the
 *    agent knows later work may have changed files it no longer remembers.
 *
 * Retrying with the same key converges: the rewind and the send are each
 * recorded once.
 */
export const createThreadMessageEditRoutes = (agent: MessageEditAgent) =>
  new Hono<AppEnv>().post(
    "/:threadId/messages/:entryId/edit",
    async (context) => {
      const threadId = decodeThreadId(context.req.param("threadId"));
      const entryId = context.req.param("entryId");
      const request = decodeRequest(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (
        Option.isNone(threadId) ||
        Option.isNone(request) ||
        !THREAD_MESSAGE_ENTRY_ID.test(entryId) ||
        request.value.body.trim() === ""
      )
        return refuse(context, "INVALID_REQUEST", 400);
      if (context.get("threadKind") === "space")
        return refuse(context, "SPACE_POSTS_EDIT_IN_PLACE", 409);
      if (context.get("threadLifecycleState") === "archived")
        return refuse(context, "THREAD_ARCHIVED", 409);
      if (!sentByActor(request.value.original, context.get("actor").userId))
        return refuse(context, "MESSAGE_NOT_YOURS", 403);

      const key = await sha256Hex(
        `message-edit\n${threadId.value}\n${request.value.idempotencyKey}`,
      );
      const rewound = await stopAndRewind(agent, context.env, threadId.value, {
        entryId,
        idempotencyKey: key,
        expectText: request.value.original,
      });
      if (rewound === "busy") return refuse(context, "AGENT_BUSY", 409);
      if (rewound === "changed") return refuse(context, "MESSAGE_CHANGED", 409);

      const delivered = await sendThreadMessageAs(agent, context, {
        threadId: threadId.value,
        body: request.value.body,
        idempotencyKey: key,
        edit: true,
      });
      reindexAfterRewind(context, threadId.value);
      if (delivered.status !== 202 || delivered.submissionId === undefined)
        return refuse(context, "EDIT_NOT_SENT", 502);
      return context.json(
        Schema.encodeUnknownSync(EditThreadMessageResponseSchema)({
          status: "success",
          data: { submissionId: delivered.submissionId },
        }),
        200,
      );
    },
  );
