import {
  type CommentedMessage,
  commentLinkId,
  plainCommentText,
} from "@dx/api";
import type { Principal, ThreadId, UserId } from "@dx/domain";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../../http/types.js";
import { spaceLogger } from "../../logging.js";
import { publishNotification } from "../../notifications/publish.js";
import { threadReaders } from "../../thread-artifacts/ask-effects.js";
import { sha256Hex } from "../../threads/agent-tools.js";
import { listMessageComments } from "./store.js";

/**
 * What happens after a person comments on a Space's message, besides the
 * comment itself:
 * - people it mentions (`@[Name](user:ID)`, or everyone with `@[here](here)`)
 *   are notified, if they can open the Space, as artifact comments notify;
 * - a comment that mentions dx (`@[dx](agent)`) is sent to the Space's agent
 *   in the main chat, as a message from the commenter through the same
 *   admission every message takes (`attributeSubmission`), so its author tag
 *   names them and their access decides. Its tag carries `comment_on`, and
 *   the message quotes what it comments on.
 * A comment without the mention never reaches the agent. Each part is best
 * effort and logged; neither can undo the comment.
 */

const PERSON_MENTION = /@\[[^\]\n]+\]\(user:([A-Za-z0-9_-]+)\)/g;
const HERE_MENTION = /@\[[^\]\n]+\]\(here\)/;
const AGENT_MENTION = /@\[[^\]\n]+\]\(agent\)/;
const QUOTE_TAG = /<\/?dx_commented_message\b[^>]*>/gi;

/** How a comment reaches the agent; tests pass their own. */
/** `messageId` for a notification when there is one to open at. */
const linkTo = (messageId: string | undefined) =>
  messageId === undefined ? {} : { messageId };

export type DeliverCommentToAgent = (input: {
  /** The commenter, as authentication saw them. */
  readonly actor: Principal;
  readonly threadId: string;
  readonly messageId: string;
  readonly body: string;
  readonly key: string;
}) => Promise<unknown>;

/**
 * Sends the message through DxAgent's routes behind dx's admission, signed
 * in as the commenter: authorization finds their access to the Space, and
 * the author tag names them.
 */
export const deliverAsCommenter =
  (
    bindings: Bindings,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): DeliverCommentToAgent =>
  async (input) => {
    const { dxAgentRoutes } = await import("../../agents/routes.js");
    const app = new Hono<AppEnv>();
    app.use(async (context, next) => {
      context.set("principal", input.actor);
      context.set("requestId", `message_comment_${crypto.randomUUID()}`);
      context.set("requestStartedAt", Date.now());
      context.set("messageCommentOn", input.messageId);
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
          idempotencyKey: await sha256Hex(input.key),
        }),
      },
      bindings,
      {
        waitUntil: (promise: Promise<unknown>) => {
          const settled = promise.catch(() => undefined);
          waitUntil?.(settled);
        },
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext,
    );
    if (response.status !== 202)
      throw new Error(
        `Sending the comment to the agent failed (${response.status}).`,
      );
    await response.body?.cancel();
  };

const attribute = (value: string) => value.replaceAll('"', "'");

/** Tags a comment block's text could close or open early. */
const BLOCK_TAGS =
  /<\/?(?:comments|comment|post|dx_commented_message)\b[^>]*>/gi;

/**
 * The comment as the agent reads it: its text, with people's mentions as
 * their names (the comment already notified them) and dx's as `@dx`, then a
 * `<comments message_thread="…">` block holding the commented post and
 * every comment on it so far, oldest first.
 */
export const commentForAgent = (
  body: string,
  message: CommentedMessage,
  comments: ReadonlyArray<{
    readonly author: string;
    readonly body: string;
  }>,
) => {
  const text = body
    .replace(QUOTE_TAG, "")
    .replace(/@\[[^\]\n]+\]\(agent\)/g, "@dx")
    .replace(/@\[[^\]\n]+\]\(here\)/g, "everyone")
    .replace(/@\[([^\]\n]+)\]\(user:[A-Za-z0-9_-]+\)/g, "$1");
  const id = attribute(message.messageId);
  return [
    text,
    "",
    `<comments message_thread="${id}">`,
    `<post id="${id}" author="${attribute(message.author?.name ?? "dx")}">`,
    message.excerpt.replace(BLOCK_TAGS, ""),
    "</post>",
    ...comments.flatMap((comment) => [
      `<comment author="${attribute(comment.author)}">`,
      plainCommentText(comment.body).replace(BLOCK_TAGS, ""),
      "</comment>",
    ]),
    "</comments>",
  ].join("\n");
};

export interface MessageCommentedEvent {
  readonly threadId: string;
  readonly commentId: string;
  readonly body: string;
  readonly message: CommentedMessage;
  readonly actor: Principal;
}

/** Runs every after-comment effect; never throws. */
export const messageCommented = async (
  bindings: Bindings,
  event: MessageCommentedEvent,
  options: {
    readonly deliver?: DeliverCommentToAgent;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<{ readonly agentAsked: boolean }> => {
  const db = bindings.DB;
  if (db === undefined) return { agentAsked: false };
  const writerId = event.actor.userId;
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (cause) {
      spaceLogger.warn("Message comment step failed.", {
        event: "space_message_comment_effect_failed",
        step: name,
        threadId: event.threadId,
        commentId: event.commentId,
        cause,
      });
      return false;
    }
  };
  await step("mention", async () => {
    const { readers } = await threadReaders(db, event.threadId);
    const recipients = [
      ...new Set([
        ...[...event.body.matchAll(PERSON_MENTION)].map(
          (match) => match[1] ?? "",
        ),
        ...(HERE_MENTION.test(event.body) ? readers : []),
      ]),
    ].filter((userId) => readers.has(userId) && userId !== writerId);
    if (recipients.length === 0) return;
    const title =
      (await db
        .prepare("SELECT title FROM threads WHERE id = ?")
        .bind(event.threadId)
        .first<string>("title")) ?? "Space";
    await publishNotification(bindings, {
      topic: "mention",
      sourceKey: `message-comment-mention:${event.commentId}`,
      recipients: recipients.map((userId) => userId as UserId),
      threadId: event.threadId as ThreadId,
      actorUserId: writerId as UserId,
      // Opens the post's Comments panel at this comment.
      ...linkTo(commentLinkId(event.message.messageId, event.commentId)),
      // Picked mentions stay tokens, which the inbox shows as chips.
      excerpt: `${title}: ${event.body}`,
    });
  });
  if (!AGENT_MENTION.test(event.body)) return { agentAsked: false };
  const agentAsked = await step("agent", async () => {
    const deliver =
      options.deliver ?? deliverAsCommenter(bindings, options.waitUntil);
    const { comments } = await listMessageComments(
      db,
      event.threadId,
      event.message.messageId,
    );
    await deliver({
      actor: event.actor,
      threadId: event.threadId,
      messageId: event.message.messageId,
      key: `message-comment-agent:${event.commentId}`,
      body: commentForAgent(
        event.body,
        event.message,
        comments.map((comment) => ({
          author: comment.author?.name ?? "Former member",
          body: comment.body,
        })),
      ),
    });
  });
  return { agentAsked };
};
