import {
  ListSpacePostsQuerySchema,
  ListSpacePostsResponseSchema,
  parseMessageAttachments,
  SPACE_POSTS_DEFAULT_LIMIT,
  SpacePostReactionSchema,
  SpacePostResponseSchema,
  SpacePostRevisionsResponseSchema,
  SpacePostTextRequestSchema,
  spacePostEditForAgent,
  spacePostForAgent,
  withMessageAttachments,
} from "@dx/api";
import type { Principal, ThreadId, UserId } from "@dx/domain";
import { DateTime, Option, Schema } from "effect";
import type { Context } from "hono";
import {
  linkMessageAttachments,
  MessageAttachmentsRejected,
  messageAttachmentBody,
  resolveMessageAttachments,
} from "../../attachments/message.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import { spaceLogger } from "../../logging.js";
import { ownerAgentInitialization } from "../../thread-sharing/middleware.js";
import type {
  DeliverToSpaceAgent,
  SpaceAgentDelivery,
} from "../agent-delivery.js";
import type { SpaceRow } from "../repository-d1.js";
import { SpaceError } from "../service.js";
import { announcePosts, notifyPostMentions } from "./effects.js";
import {
  deleteSpacePost,
  editSpacePost,
  insertSpacePost,
  listSpacePostRevisions,
  listSpacePostRows,
  newSpacePostId,
  readSpacePost,
  type SpacePostRow,
  setSpacePostReaction,
  spacePostData,
  spacePostDetails,
} from "./store.js";

/**
 * `/v1/spaces/:threadId/posts…`: the Space's posts as people read and write
 * them. Everyone who can open the Space reads; its owner and Contribute
 * members post, edit their own posts, and react. A post reaches the agent
 * through the same admission as any message (`deliverToSpaceAgent`), and is
 * stored only when the agent accepted it.
 */

export interface SpacePostRouteDeps {
  readonly readSpace: (
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
  ) => Promise<SpaceRow>;
  readonly deliver: (context: Context<AppEnv>) => DeliverToSpaceAgent;
}

const invalid = () =>
  new SpaceError("INVALID_REQUEST", 400, "Request validation failed.");

const postNotFound = () =>
  new SpaceError("POST_NOT_FOUND", 404, "Post not found.");

const writable = (space: SpaceRow) => {
  if (space.access === "view")
    throw new SpaceError(
      "SPACE_READ_ONLY",
      403,
      "You can read this Space. Ask its owner for Contribute access to post.",
    );
  if (space.lifecycle_state !== "active")
    throw new SpaceError(
      "SPACE_ARCHIVED",
      409,
      "This Space is archived. Unarchive it to continue.",
    );
};

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => {
  const decoded = Schema.decodeUnknownOption(schema as never)(value);
  if (Option.isNone(decoded)) throw invalid();
  return decoded.value as S["Type"];
};

const postOf = async (
  db: D1Database,
  space: SpaceRow,
  postId: string,
): Promise<SpacePostRow> => {
  const post = await readSpacePost(db, space.id, postId);
  if (post === null) throw postNotFound();
  return post;
};

const postResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  principal: Principal,
  postId: string,
  spaceThreadId: string,
  status: 200 | 201 = 200,
) => {
  const post = await readSpacePost(db, spaceThreadId, postId);
  if (post === null) throw postNotFound();
  const [details] = await spacePostDetails(db, [post], principal.userId);
  if (details === undefined) throw postNotFound();
  return context.json(
    Schema.encodeUnknownSync(SpacePostResponseSchema)({
      status: "success",
      data: { post: spacePostData(details) },
    }),
    status,
  );
};

/**
 * Delivers to the agent; a Space whose agent was never created (one made
 * before setup messages) is created with its owner's initialization.
 */
const deliverCreating = async (
  context: Context<AppEnv>,
  deps: SpacePostRouteDeps,
  db: D1Database,
  space: SpaceRow,
  delivery: SpaceAgentDelivery,
) => {
  const deliver = deps.deliver(context);
  const first = await deliver(delivery);
  if (first.status === 202 || first.status === 403 || first.status === 409)
    return first;
  const initialData = await ownerAgentInitialization(
    context.env,
    db,
    space.id as ThreadId,
    space.owner_user_id as UserId,
  ).catch(() => undefined);
  return initialData === undefined
    ? first
    : deliver({ ...delivery, initialData });
};

/**
 * A person's post with its files, as a Thread message carries them: each
 * `<dx_attachment>` the client named must be a finished upload the author
 * can read, the block is rewritten from Core's records (real name, type,
 * size, download URL), and the files are recorded in the Space's Thread so
 * everyone who can open the Space, and its agent, can open them. Tags a
 * person typed never pose as files.
 */
const postBody = async (
  context: Context<AppEnv>,
  db: D1Database,
  space: SpaceRow,
  principal: Principal,
  text: string,
) => {
  try {
    const resolved = await resolveMessageAttachments(context.env, {
      senderUserId: principal.userId,
      body: text,
    });
    if (resolved.text.trim() === "" && resolved.rows.length === 0)
      throw invalid();
    await linkMessageAttachments(db, {
      threadId: space.id,
      senderUserId: principal.userId,
      rows: resolved.rows,
    });
    const { body, attachments } = messageAttachmentBody(
      context.env,
      resolved,
      context.req.url,
    );
    // The agent reads the files as a Thread message's: its block last.
    return {
      text: body,
      forAgent: (wrap: (words: string) => string) =>
        withMessageAttachments(wrap(resolved.text.trimEnd()), attachments),
    };
  } catch (cause) {
    if (cause instanceof MessageAttachmentsRejected)
      throw new SpaceError("INVALID_REQUEST", 400, cause.message);
    throw cause;
  }
};

const agentUnavailable = (status: number) => {
  spaceLogger.warn("A Space's agent refused a post.", {
    event: "space_post_refused",
    status,
  });
  return new SpaceError(
    "SPACE_AGENT_UNAVAILABLE",
    503,
    "The Space's agent could not take this post. Try again.",
  );
};

export const spacePostHandlers = (deps: SpacePostRouteDeps) => ({
  list: async (
    context: Context<AppEnv>,
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
  ) => {
    const query = decode(ListSpacePostsQuerySchema, context.req.query());
    const space = await deps.readSpace(db, principal, threadId);
    const before =
      query.before === undefined
        ? undefined
        : await readSpacePost(db, space.id, query.before);
    if (before === null) throw postNotFound();
    const { rows, more } = await listSpacePostRows(db, space.id, {
      ...(before === undefined ? {} : { before }),
      limit: query.limit ?? SPACE_POSTS_DEFAULT_LIMIT,
    });
    const details = await spacePostDetails(db, rows, principal.userId);
    return context.json(
      Schema.encodeUnknownSync(ListSpacePostsResponseSchema)({
        status: "success",
        data: {
          items: details.map(spacePostData),
          ...(more && rows[0] !== undefined ? { nextBefore: rows[0].id } : {}),
        },
      }),
      200,
    );
  },

  revisions: async (
    context: Context<AppEnv>,
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
  ) => {
    const space = await deps.readSpace(db, principal, threadId);
    const post = await postOf(db, space, context.req.param("postId") ?? "");
    const revisions = await listSpacePostRevisions(db, post);
    return context.json(
      Schema.encodeUnknownSync(SpacePostRevisionsResponseSchema)({
        status: "success",
        data: {
          items: revisions.map(({ revision, text, created_at }) => ({
            revision,
            text,
            createdAt: DateTime.makeUnsafe(new Date(created_at)),
          })),
        },
      }),
      200,
    );
  },

  create: async (
    context: Context<AppEnv>,
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
  ) => {
    const request = decode(
      SpacePostTextRequestSchema,
      await readBoundedJson(context.req.raw).catch(() => undefined),
    );
    if (request.text.trim() === "") throw invalid();
    const space = await deps.readSpace(db, principal, threadId);
    writable(space);
    const { text, forAgent } = await postBody(
      context,
      db,
      space,
      principal,
      request.text,
    );
    const id = newSpacePostId();
    await insertSpacePost(db, {
      id,
      spaceThreadId: space.id,
      authorKind: "user",
      authorUserId: principal.userId,
      text,
      requestKey: `post:${id}`,
    });
    let delivered: { readonly status: number };
    try {
      delivered = await deliverCreating(context, deps, db, space, {
        actor: principal,
        threadId: space.id,
        body: forAgent((words) => spacePostForAgent(id, words)),
        key: `space-post:${id}`,
        variables: { spacePost: { id, kind: "create" } },
      });
    } catch (cause) {
      await deleteSpacePost(db, id);
      throw cause;
    }
    if (delivered.status !== 202) {
      await deleteSpacePost(db, id);
      throw agentUnavailable(delivered.status);
    }
    await notifyPostMentions(context.env, {
      spaceThreadId: space.id,
      postId: id,
      text,
      author: { userId: principal.userId },
    });
    return postResponse(context, db, principal, id, space.id, 201);
  },

  edit: async (
    context: Context<AppEnv>,
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
  ) => {
    const request = decode(
      SpacePostTextRequestSchema,
      await readBoundedJson(context.req.raw).catch(() => undefined),
    );
    if (request.text.trim() === "") throw invalid();
    const space = await deps.readSpace(db, principal, threadId);
    writable(space);
    const post = await postOf(db, space, context.req.param("postId") ?? "");
    if (post.author_kind !== "user" || post.author_user_id !== principal.userId)
      throw new SpaceError(
        "POST_NOT_YOURS",
        403,
        "Only a post's author can edit it.",
      );
    const { text, forAgent } = await postBody(
      context,
      db,
      space,
      principal,
      request.text,
    );
    if (post.text !== text) {
      const revision = (await listSpacePostRevisions(db, post)).length;
      const delivered = await deliverCreating(context, deps, db, space, {
        actor: principal,
        threadId: space.id,
        body: forAgent((words) =>
          spacePostEditForAgent(
            post.id,
            words,
            parseMessageAttachments(post.text).text,
          ),
        ),
        key: `space-post-edit:${post.id}:${revision}`,
        variables: { spacePost: { id: post.id, kind: "edit" } },
      });
      if (delivered.status !== 202) throw agentUnavailable(delivered.status);
      await editSpacePost(db, post, text);
      await announcePosts(context.env, space.id);
      await notifyPostMentions(context.env, {
        spaceThreadId: space.id,
        postId: post.id,
        text,
        previousText: post.text,
        author: { userId: principal.userId },
      });
    }
    return postResponse(context, db, principal, post.id, space.id);
  },

  react: async (
    context: Context<AppEnv>,
    db: D1Database,
    principal: Principal,
    threadId: ThreadId,
    on: boolean,
  ) => {
    const reaction = decode(
      SpacePostReactionSchema,
      context.req.param("reaction"),
    );
    const space = await deps.readSpace(db, principal, threadId);
    writable(space);
    const post = await postOf(db, space, context.req.param("postId") ?? "");
    if (
      await setSpacePostReaction(db, {
        postId: post.id,
        reactor: { userId: principal.userId },
        reaction,
        on,
      })
    )
      await announcePosts(context.env, space.id);
    return postResponse(context, db, principal, post.id, space.id);
  },
});
