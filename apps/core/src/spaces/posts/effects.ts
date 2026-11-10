import { AGENT_MENTION } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { spaceLogger } from "../../logging.js";
import { publishNotification } from "../../notifications/publish.js";
import { publishRealtimeInvalidation } from "../../realtime/publication.js";
import { threadMembers } from "../../thread-sharing/members.js";
import { spaceAppOrigin } from "../agent-prompt.js";
import { spacesEnabledFor } from "../gate.js";
import { recordPostSubmission, setSpacePostReaction } from "./store.js";

/**
 * What follows a change to a Space's posts: everyone watching the Space
 * refetches them; a person's post that reached the agent shows dx's `eyes`
 * until the turn ends (`eyes.ts`) and ends the Space's wait on input; an
 * agent post that tags members notifies them. Each step is best effort and never undoes the change.
 */

const warn = (step: string, spaceThreadId: string, cause: unknown) =>
  spaceLogger.warn("A Space post effect failed.", {
    event: "space_post_effect_failed",
    step,
    spaceThreadId,
    cause,
  });

/** Tells everyone watching the Space that its posts changed. */
export const announcePosts = async (
  bindings: Bindings,
  spaceThreadId: string,
) => {
  try {
    await publishRealtimeInvalidation(
      bindings,
      spaceThreadId as ThreadId,
      "space.posts.invalidated",
    );
  } catch (cause) {
    warn("announce", spaceThreadId, cause);
  }
};

/**
 * A person's post (or its edit) reached the agent in `submissionId`: dx
 * shows `eyes` on it until that turn ends.
 */
export const postReachedAgent = async (
  bindings: Bindings,
  input: {
    readonly spaceThreadId: string;
    readonly postId: string;
    readonly submissionId?: string;
  },
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  try {
    if (input.submissionId !== undefined)
      await recordPostSubmission(db, input.postId, input.submissionId);
    await setSpacePostReaction(db, {
      postId: input.postId,
      reactor: { kind: "agent" },
      reaction: "eyes",
      on: true,
    });
  } catch (cause) {
    warn("eyes", input.spaceThreadId, cause);
  }
  await announcePosts(bindings, input.spaceThreadId);
  // A person answered: the Space no longer waits on input, even if the turn
  // that reads the answer fails before it sets a new status. The status
  // text stays until the agent replaces it.
  try {
    const answered = await db
      .prepare(
        "UPDATE space SET waiting_on_input = 0 WHERE thread_id = ?1 AND waiting_on_input = 1",
      )
      .bind(input.spaceThreadId)
      .run();
    if (answered.meta.changes > 0)
      await publishRealtimeInvalidation(
        bindings,
        input.spaceThreadId as ThreadId,
        "thread.invalidated",
        "audience",
      );
  } catch (cause) {
    warn("waiting", input.spaceThreadId, cause);
  }
};

/** Text outside code, where a mention counts. */
const outsideCode = (text: string) =>
  text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

/** A person picked from the mention list: `@[Name](user:ID)`. */
const PICKED_MENTION = /@\[[^\]\n]+\]\(user:([A-Za-z0-9_-]+)\)/g;

/** Who a post mentions: people picked by ID, and typed `@handle`s. */
const mentionsIn = (text: string) => {
  const plain = outsideCode(text);
  const userIds = new Set(
    [...plain.matchAll(PICKED_MENTION)].flatMap(([, id]) =>
      id === undefined ? [] : [id],
    ),
  );
  const handles = new Set(
    [
      // Picked mentions and dx's own mention are not typed handles.
      ...plain
        .replace(PICKED_MENTION, "")
        .replace(/@\[[^\]\n]+\]\((?:agent|here)\)/g, "")
        .matchAll(/(?:^|[^\w@])@([A-Za-z0-9][\w.-]{0,63})/g),
    ].flatMap(([, handle]) => {
      const name = handle?.replace(/[.-]+$/, "").toLowerCase();
      return name === undefined || name === AGENT_MENTION ? [] : [name];
    }),
  );
  return { userIds, handles };
};

/** Who can be notified in a Space: its owner and, while shared, members. */
const spaceAudience = async (db: D1Database, spaceThreadId: string) => {
  const owner = await db
    .prepare(
      `SELECT thread.owner_user_id, account.username
         FROM threads AS thread
         LEFT JOIN personal_account AS account
           ON account.user_id = thread.owner_user_id
        WHERE thread.id = ?1`,
    )
    .bind(spaceThreadId)
    .first<{ owner_user_id: string; username: string | null }>();
  if (owner === null) return [];
  return [
    { userId: owner.owner_user_id, handle: owner.username ?? "" },
    ...(await threadMembers(db, spaceThreadId as ThreadId)).map(
      ({ userId, handle }) => ({ userId, handle }),
    ),
  ];
};

/**
 * Notifies the people a post mentions, picked (`@[Name](user:ID)`) or typed
 * (`@handle`), as a mention: once per person per post, so an edit notifies
 * only people it newly mentions. Only people who can open the Space and have
 * Spaces on hear of it, never its author. The notification comes from the
 * author (dx for the agent's posts) and opens the Space at the post.
 */
export const notifyPostMentions = async (
  bindings: Bindings,
  input: {
    readonly spaceThreadId: string;
    readonly postId: string;
    readonly text: string;
    /** An edit's earlier text: people it mentioned already heard. */
    readonly previousText?: string;
    readonly author: { readonly kind: "agent" } | { readonly userId: string };
  },
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  const mentioned = mentionsIn(input.text);
  if (mentioned.userIds.size === 0 && mentioned.handles.size === 0) return;
  try {
    const audience = await spaceAudience(db, input.spaceThreadId);
    const named = (mentions: ReturnType<typeof mentionsIn>) =>
      new Set(
        audience
          .filter(
            ({ userId, handle }) =>
              mentions.userIds.has(userId) ||
              (handle !== "" && mentions.handles.has(handle.toLowerCase())),
          )
          .map(({ userId }) => userId),
      );
    const already =
      input.previousText === undefined
        ? new Set<string>()
        : named(mentionsIn(input.previousText));
    const authorId = "userId" in input.author ? input.author.userId : undefined;
    const candidates = [...named(mentioned)].filter(
      (userId) => userId !== authorId && !already.has(userId),
    );
    const recipients: UserId[] = [];
    for (const userId of candidates)
      if (await spacesEnabledFor(bindings, userId))
        recipients.push(userId as UserId);
    if (recipients.length === 0) return;
    await publishNotification(bindings, {
      topic: "mention",
      sourceKey: `space-post-mention:${input.postId}`,
      recipients,
      threadId: input.spaceThreadId as ThreadId,
      messageId: input.postId,
      ...(authorId === undefined
        ? { actorName: "dx" }
        : { actorUserId: authorId as UserId }),
      // Picked mentions stay tokens, which the inbox shows as chips.
      excerpt: input.text,
    });
  } catch (cause) {
    warn("mention", input.spaceThreadId, cause);
  }
};

/** Where people open dx, for links: the configured origin. */
export const dxOrigin = async (bindings: Bindings) => {
  const origin = await spaceAppOrigin(bindings);
  if (origin !== undefined) return origin;
  try {
    return bindings.DX_AUTH_URL === undefined || bindings.DX_AUTH_URL === ""
      ? ""
      : new URL(bindings.DX_AUTH_URL).origin;
  } catch {
    return "";
  }
};

/** A Thread's URL in dx. */
export const threadUrl = (origin: string, threadId: string) =>
  `${origin}/threads/${threadId}`;
