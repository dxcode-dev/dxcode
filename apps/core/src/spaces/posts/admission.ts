import {
  parseMessageAttachments,
  SPACE_POST_MAX_LENGTH,
  spacePostTag,
  spaceWorkerReport,
  stripMessageAuthorTags,
} from "@dx/api";
import type { Context } from "hono";
import type { AppEnv } from "../../http/types.js";
import {
  dxOrigin,
  notifyPostMentions,
  postReachedAgent,
  threadUrl,
} from "./effects.js";
import { deleteSpacePost, insertSpacePost } from "./store.js";

/**
 * Whether the reporting thread has an open ask: an unchecked checklist item
 * mentioning a person in one of its artifacts (`thread_open_ask`, which
 * its card reads as Needs
 * you). The mention notified that person, so the Space's agent need not ask
 * them again. Undefined when it has none: then no one was notified of
 * anything the report waits on.
 */
export const openAskLine = async (
  db: D1Database,
  threadId: string,
): Promise<string | undefined> => {
  const open = await db
    .prepare(
      `SELECT 1 AS open FROM thread_open_ask AS ask
         JOIN thread_artifact AS artifact ON artifact.id = ask.artifact_id
        WHERE ask.thread_id = ?1 AND artifact.deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(threadId)
    .first<{ open: number }>()
    .catch(() => null);
  return open === null
    ? undefined
    : "(dx: this thread has an open ask in its artifacts, whose mention notified the person it waits on; its card shows Needs you.)";
};

/**
 * What a message to a Space's agent becomes before Flue admits it, called
 * from `attributeSubmission` for every user message to a Space:
 *
 * - A person's own message is a post. One the posts routes stored arrives
 *   tagged already (`spacePost`); one sent straight to the agent, as older
 *   clients do, is stored here, keyed by its delivery key so a retry finds
 *   it, and gains its `<post id="…" />` tag. Once Flue admits it, dx shows
 *   `eyes` on it; a refused one is forgotten.
 * - Another Thread's message, such as a child's report or the report dx
 *   sends for a child that did not report, reaches the agent as
 *   `Worker report from <title> (<url>)`, with a line when the thread has
 *   an open ask (`openAskLine`). It is never a post.
 * - Automations, `@dx` comments, and the setup message pass unchanged.
 */
export const admitSpaceMessage = async (
  context: Context<AppEnv>,
  input: {
    readonly db: D1Database;
    readonly threadId: string;
    readonly actorUserId: string;
    /** The message as the agent would read it, without the author tag. */
    readonly body: string;
    /** The message as the client sent it. */
    readonly sent: string;
    readonly idempotencyKey?: string;
  },
): Promise<{
  readonly body: string;
  /** Runs once Flue answered. */
  readonly after: (response: Response) => Promise<void>;
}> => {
  const none = async () => undefined;
  const sourceThreadId = context.get("messageSourceThreadId");
  if (sourceThreadId !== undefined) {
    const title =
      (await input.db
        .prepare("SELECT title FROM threads WHERE id = ?")
        .bind(sourceThreadId)
        .first<string>("title")) ?? "a thread";
    const asked = await openAskLine(input.db, sourceThreadId);
    return {
      body: spaceWorkerReport({
        title,
        url: threadUrl(await dxOrigin(context.env), sourceThreadId),
        text: asked === undefined ? input.body : `${input.body}\n\n${asked}`,
      }),
      after: none,
    };
  }
  if (
    context.get("messageAutomation") !== undefined ||
    context.get("messageCommentOn") !== undefined ||
    context.get("spaceSetup") === true
  )
    return { body: input.body, after: none };
  const submissionOf = async (response: Response) => {
    const payload = (await response
      .clone()
      .json()
      .catch(() => undefined)) as { submissionId?: unknown } | undefined;
    return typeof payload?.submissionId === "string"
      ? payload.submissionId
      : undefined;
  };
  const stored = context.get("spacePost");
  if (stored !== undefined)
    return {
      body: input.body,
      after: async (response) => {
        if (response.status !== 202) return;
        await postReachedAgent(context.env, {
          spaceThreadId: input.threadId,
          postId: stored.id,
          ...(await submissionOf(response).then((submissionId) =>
            submissionId === undefined ? {} : { submissionId },
          )),
        });
      },
    };
  const text = parseMessageAttachments(
    stripMessageAuthorTags(input.sent),
  ).text.trim();
  const { post, created } = await insertSpacePost(input.db, {
    spaceThreadId: input.threadId,
    authorKind: "user",
    authorUserId: input.actorUserId,
    text: (text === "" ? "(Attachment)" : text).slice(0, SPACE_POST_MAX_LENGTH),
    requestKey: `message:${input.idempotencyKey ?? crypto.randomUUID()}`,
  });
  return {
    body: `${input.body}\n\n${spacePostTag(post.id)}`,
    after: async (response) => {
      if (response.status === 202) {
        const submissionId = await submissionOf(response);
        await postReachedAgent(context.env, {
          spaceThreadId: input.threadId,
          postId: post.id,
          ...(submissionId === undefined ? {} : { submissionId }),
        });
        // A retry of the same delivery finds its people already notified.
        await notifyPostMentions(context.env, {
          spaceThreadId: input.threadId,
          postId: post.id,
          text: post.text,
          author: { userId: input.actorUserId },
        });
      } else if (created) await deleteSpacePost(input.db, post.id);
    },
  };
};
