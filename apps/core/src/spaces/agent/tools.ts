import {
  SPACE_GOAL_MAX_LENGTH,
  SPACE_POST_MAX_LENGTH,
  type SpaceThreadState,
} from "@dx/api";
import {
  THREAD_COLORS,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { DateTime } from "effect";
import * as v from "valibot";
import { ownerTimeZone } from "../../automations/schedules.js";
import { userImageSql } from "../../avatars/storage.js";
import { publishRealtimeInvalidation } from "../../realtime/publication.js";
import { searchThreadsItem } from "../../thread-search/routes.js";
import { searchThreads } from "../../thread-search/service.js";
import {
  displayNameSql,
  ownerWorkspaceId,
  userIdentity,
} from "../../thread-sharing/service.js";
import {
  sha256Hex,
  type ThreadToolsContext,
} from "../../threads/agent-tools.js";
import { ownerRequest } from "../../threads/owner-request.js";
import {
  announcePosts,
  dxOrigin,
  notifyPostMentions,
  threadUrl,
} from "../posts/effects.js";
import {
  editSpacePost,
  insertSpacePost,
  listSpacePostRows,
  readSpacePost,
  setSpacePostReaction,
  spacePostDetails,
} from "../posts/store.js";
import { updateSpaceRow } from "../repository-d1.js";
import { spaceThreadItems } from "../service.js";
import { searchDxDocumentation } from "./docs-search.js";
import {
  SPACE_REACTIONS,
  SPACE_THREAD_STATES,
  SPACE_TOOL_DESCRIPTIONS,
  SPACE_TOOL_PARAMETER_DESCRIPTIONS,
  type SpaceToolName,
} from "./tool-descriptions.js";

/**
 * The tools only a Space's main thread has. Each acts for the Space, as its
 * owner, like every Thread tool; none needs an Orb. Their words come from
 * `tool-descriptions.ts`.
 */

/** A thread that has done nothing for this long is inactive. */
export const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1000;
/** The Space's own status line, as the thread lists show it. */
const STATUS_MAX_LENGTH = 120;

const describe = (tool: SpaceToolName, parameter: string) =>
  SPACE_TOOL_PARAMETER_DESCRIPTIONS[tool]?.[parameter] ?? "";

const postIdInput = (tool: SpaceToolName) =>
  v.pipe(
    v.string(),
    v.regex(
      /^pst_[0-9a-z]{26}$/,
      "A post ID looks like pst_ and 26 letters or digits.",
    ),
    v.description(describe(tool, "post_id")),
  );

const reactionInput = (tool: SpaceToolName) =>
  v.pipe(
    v.picklist(SPACE_REACTIONS),
    v.description(describe(tool, "reaction")),
  );

const iso = (value: number | string) => new Date(value).toISOString();

const THREAD_ID =
  /thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;

type ListedState = (typeof SPACE_THREAD_STATES)[number];

/**
 * A thread's state as `list_space_threads` names it, from the state its
 * card shows (`spaceThreadState`): a failure waits on a person like a
 * question does; a question or ask stays needs-input however old it is;
 * any other thread that is not running, shipped, or archived is scheduled
 * while it waits for a scheduled run, else inactive after 72 hours without
 * activity.
 */
export const listedThreadState = (input: {
  readonly state: SpaceThreadState;
  readonly scheduled: boolean;
  readonly lastActivityAt: number;
  readonly now: number;
}): ListedState => {
  if (
    input.state === "working" ||
    input.state === "shipped" ||
    input.state === "archived"
  )
    return input.state;
  if (input.state === "needs_you") return "needs-input";
  if (input.scheduled) return "scheduled";
  if (input.now - input.lastActivityAt >= INACTIVE_AFTER_MS) return "inactive";
  return input.state === "failed"
    ? "needs-input"
    : input.state === "ready_to_ship"
      ? "ready-to-ship"
      : "idle";
};

export const createSpaceTools = (
  spaceThreadId: string,
  getContext: () => ThreadToolsContext,
  /** The submission this turn runs, which a retried tool call shares. */
  submissionId?: string,
  /** The person whose message this turn answers. */
  requesterUserId?: UserId,
): ToolDefinition[] => {
  const callSeed = (toolCallId: string) =>
    toolCallId.trim() === ""
      ? `${spaceThreadId}:${crypto.randomUUID()}`
      : `${spaceThreadId}:${submissionId ?? ""}:${toolCallId}`;

  const space = async (context: ThreadToolsContext) => {
    const row = await context.db
      .prepare(
        `SELECT thread.owner_user_id, thread.lifecycle_state,
                thread.workspace_access, thread.shared_workspace_id,
                thread.contribute_until, thread.visibility
           FROM threads AS thread
          WHERE thread.id = ?1 AND thread.kind = 'space'`,
      )
      .bind(spaceThreadId)
      .first<{
        owner_user_id: UserId;
        lifecycle_state: string;
        workspace_access: string;
        shared_workspace_id: string | null;
        contribute_until: string | null;
        visibility: string;
      }>();
    if (row === null) throw new Error("This Space is unavailable.");
    return row;
  };

  const post = async (context: ThreadToolsContext, postId: string) => {
    const found = await readSpacePost(context.db, spaceThreadId, postId);
    if (found === null)
      throw new Error(`Post ${postId} was not found in this Space.`);
    return found;
  };

  const announceSpace = (context: ThreadToolsContext) =>
    publishRealtimeInvalidation(
      context.bindings,
      spaceThreadId as ThreadId,
      "thread.invalidated",
      "audience",
    ).catch(() => undefined);

  const tool = <T extends SpaceToolName>(name: T) => ({
    name,
    description: SPACE_TOOL_DESCRIPTIONS[name],
  });

  return [
    defineTool({
      ...tool("post"),
      input: v.object({
        text: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(SPACE_POST_MAX_LENGTH),
          v.description(describe("post", "text")),
        ),
      }),
      run: async ({ data, toolCallId }) => {
        const context = getContext();
        if (data.text.trim() === "") throw new Error("A post needs text.");
        const { post: stored, created } = await insertSpacePost(context.db, {
          spaceThreadId,
          authorKind: "agent",
          authorUserId: null,
          text: data.text,
          // Hashed: some models' call IDs run to hundreds of characters,
          // past the key's 256-character limit.
          requestKey: `tool:${await sha256Hex(callSeed(toolCallId))}`,
        });
        if (created) {
          await announcePosts(context.bindings, spaceThreadId);
          await notifyPostMentions(context.bindings, {
            spaceThreadId,
            postId: stored.id,
            text: stored.text,
            author: { kind: "agent" },
          });
        }
        return { output: { post_id: stored.id, duplicate: !created } };
      },
    }),
    defineTool({
      ...tool("edit_post"),
      input: v.object({
        post_id: postIdInput("edit_post"),
        text: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(SPACE_POST_MAX_LENGTH),
          v.description(describe("edit_post", "text")),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const found = await post(context, data.post_id);
        if (found.author_kind !== "agent")
          throw new Error(
            `You can edit only your own posts; ${data.post_id} is a person's post.`,
          );
        if (found.text !== data.text) {
          if (!(await editSpacePost(context.db, found, data.text)))
            throw new Error(
              "The post changed meanwhile; read it and try again.",
            );
          await announcePosts(context.bindings, spaceThreadId);
        }
        return {
          output: { post_id: found.id, edited: found.text !== data.text },
        };
      },
    }),
    defineTool({
      ...tool("read_posts"),
      input: v.object({
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
            v.description(describe("read_posts", "limit")),
          ),
        ),
        before_post_id: v.optional(
          v.pipe(
            v.string(),
            v.description(describe("read_posts", "before_post_id")),
          ),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const before =
          data.before_post_id === undefined
            ? undefined
            : await post(context, data.before_post_id);
        const { rows, more } = await listSpacePostRows(
          context.db,
          spaceThreadId,
          {
            ...(before === undefined ? {} : { before }),
            limit: data.limit ?? 30,
          },
        );
        const details = await spacePostDetails(context.db, rows);
        return {
          output: {
            posts: details.map(({ row, author, reactions, comments }) => ({
              post_id: row.id,
              author: {
                kind: author.kind,
                name: author.name,
                ...(author.handle === undefined
                  ? {}
                  : { handle: author.handle }),
              },
              text: row.text,
              created_at: iso(row.created_at),
              edited: row.edited_at !== null,
              ...(row.edited_at === null
                ? {}
                : { edited_at: iso(row.edited_at) }),
              reactions: reactions.map(({ reaction, count, agent, by }) => ({
                reaction,
                count,
                by_you: agent,
                by,
              })),
              comments: comments.count,
            })),
            ...(more ? { more: true } : {}),
          },
        };
      },
    }),
    ...(["react", "unreact"] as const).map((name) =>
      defineTool({
        ...tool(name),
        input: v.object({
          post_id: postIdInput(name),
          reaction: reactionInput(name),
        }),
        run: async ({ data }) => {
          const context = getContext();
          const found = await post(context, data.post_id);
          if (
            await setSpacePostReaction(context.db, {
              postId: found.id,
              reactor: { kind: "agent" },
              reaction: data.reaction,
              on: name === "react",
            })
          )
            await announcePosts(context.bindings, spaceThreadId);
          return {
            output: {
              post_id: found.id,
              reaction: data.reaction,
              reacted: name === "react",
            },
          };
        },
      }),
    ),
    defineTool({
      ...tool("list_space_threads"),
      input: v.object({
        state: v.optional(
          v.pipe(
            v.picklist(SPACE_THREAD_STATES),
            v.description(describe("list_space_threads", "state")),
          ),
        ),
        since: v.optional(
          v.pipe(
            v.string(),
            v.isoTimestamp(),
            v.description(describe("list_space_threads", "since")),
          ),
        ),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
            v.description(describe("list_space_threads", "limit")),
          ),
        ),
        cursor: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(64),
            v.description(describe("list_space_threads", "cursor")),
          ),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const owner = await space(context);
        const items = await spaceThreadItems(
          context.db,
          spaceThreadId as ThreadId,
          owner.owner_user_id,
          "owner",
        );
        const ids = JSON.stringify(items.map(({ id }) => id));
        const [extras, owners] = await context.db.batch<
          Record<string, unknown>
        >([
          context.db
            .prepare(
              `SELECT thread.id, thread.request_post_id, thread.ship_reason,
                      EXISTS (SELECT 1 FROM thread_schedule AS schedule
                               WHERE schedule.thread_id = thread.id
                                 AND schedule.enabled = 1
                                 AND schedule.next_run_at IS NOT NULL) AS scheduled,
                      (SELECT json_object(
                                'state', json_extract(link.subject_json, '$.state'),
                                'url', 'https://github.com/' || link.repository || '/pull/' || link.number)
                         FROM thread_github_link AS link
                        WHERE link.thread_id = thread.id AND link.kind = 'pull'
                        ORDER BY link.created_at DESC LIMIT 1) AS pull_request
                 FROM threads AS thread
                WHERE thread.id IN (SELECT value FROM json_each(?1))`,
            )
            .bind(ids),
          context.db
            .prepare(
              `SELECT ${displayNameSql('"user"', "account")} AS name,
                      account.username AS handle
                 FROM "user"
                 LEFT JOIN personal_account AS account ON account.user_id = "user".id
                WHERE "user".id = ?1`,
            )
            .bind(owner.owner_user_id),
        ]);
        const extra = new Map(
          (
            (extras?.results ?? []) as Array<{
              id: string;
              request_post_id: string | null;
              ship_reason: string | null;
              scheduled: number;
              pull_request: string | null;
            }>
          ).map((row) => [row.id, row]),
        );
        const ownerRow = owners?.results[0] as
          | { name: string | null; handle: string | null }
          | undefined;
        const origin = await dxOrigin(context.bindings);
        const now = Date.now();
        const since =
          data.since === undefined ? undefined : Date.parse(data.since);
        const listed = items.flatMap((item) => {
          const row = extra.get(item.id);
          const lastActivityAt = DateTime.toEpochMillis(
            item.lastActivityAt ?? item.createdAt,
          );
          const state = listedThreadState({
            state: item.state,
            scheduled: row?.scheduled === 1,
            lastActivityAt,
            now,
          });
          if (
            data.state === undefined
              ? state === "archived"
              : state !== data.state
          )
            return [];
          if (since !== undefined && lastActivityAt < since) return [];
          const pull =
            row?.pull_request === null || row?.pull_request === undefined
              ? null
              : (JSON.parse(row.pull_request) as {
                  state: string | null;
                  url: string;
                });
          return [
            {
              thread_id: item.id,
              title: item.title,
              url: threadUrl(origin, item.id),
              state,
              last_activity_at: new Date(lastActivityAt).toISOString(),
              status_line: item.statusLine,
              owner: {
                name: ownerRow?.name?.trim() || "Owner",
                ...(ownerRow?.handle ? { handle: ownerRow.handle } : {}),
              },
              requester:
                item.requestedBy === null
                  ? null
                  : {
                      userId: item.requestedBy.userId,
                      name: item.requestedBy.name,
                    },
              request_post_id: row?.request_post_id ?? null,
              pull_request:
                pull === null
                  ? null
                  : { state: pull.state ?? "unknown", url: pull.url },
              commits_landed: row?.ship_reason === "default_branch",
              shipped: item.shippedAt !== null,
            },
          ];
        });
        const offset = Number(/^o:(\d+)$/.exec(data.cursor ?? "")?.[1] ?? 0);
        const limit = data.limit ?? 50;
        const page = listed.slice(offset, offset + limit);
        return {
          output: {
            threads: page,
            ...(offset + limit < listed.length
              ? { nextCursor: `o:${offset + limit}` }
              : {}),
          },
        };
      },
    }),
    defineTool({
      ...tool("update_space"),
      input: v.object({
        name: v.optional(
          v.pipe(
            v.string(),
            v.trim(),
            v.minLength(1),
            v.maxLength(200),
            v.description(describe("update_space", "name")),
          ),
        ),
        goal: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(SPACE_GOAL_MAX_LENGTH),
            v.description(describe("update_space", "goal")),
          ),
        ),
        color: v.optional(
          v.pipe(
            v.picklist(THREAD_COLORS.filter((color) => color !== "gray")),
            v.description(describe("update_space", "color")),
          ),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const owner = await space(context);
        if (owner.lifecycle_state !== "active")
          throw new Error("This Space is archived.");
        if (
          data.name === undefined &&
          data.goal === undefined &&
          data.color === undefined
        )
          throw new Error("Name at least one of name, goal, or color.");
        await updateSpaceRow(context.db, {
          threadId: spaceThreadId as ThreadId,
          ownerUserId: owner.owner_user_id,
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.goal === undefined
            ? {}
            : { goal: data.goal.trim() === "" ? null : data.goal }),
          ...(data.color === undefined ? {} : { color: data.color }),
          now: new Date(),
        });
        await announceSpace(context);
        return { output: { updated: true } };
      },
    }),
    defineTool({
      ...tool("add_thread_to_space"),
      input: v.object({
        thread: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(2_048),
          v.description(describe("add_thread_to_space", "thread")),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const owner = await space(context);
        const threadId = THREAD_ID.exec(data.thread)?.[0];
        if (threadId === undefined)
          throw new Error("Give a thread URL or ID, such as thr_….");
        if (threadId === spaceThreadId)
          throw new Error("A Space cannot join itself.");
        const thread = await context.db
          .prepare(
            `SELECT thread.id, thread.kind, thread.parent_thread_id,
                    parent.kind AS parent_kind
               FROM threads AS thread
               LEFT JOIN threads AS parent ON parent.id = thread.parent_thread_id
              WHERE thread.id = ?1 AND thread.owner_user_id = ?2
                AND thread.lifecycle_state != 'deleted'`,
          )
          .bind(threadId, owner.owner_user_id)
          .first<{
            id: string;
            kind: string;
            parent_thread_id: string | null;
            parent_kind: string | null;
          }>();
        if (thread === null)
          throw new Error(
            `Thread ${threadId} was not found among the Space owner's threads.`,
          );
        if (thread.kind === "space")
          throw new Error("A Space cannot join another Space.");
        if (thread.parent_thread_id === spaceThreadId)
          return {
            output: { added: [], note: "It is already in this Space." },
          };
        if (thread.parent_kind === "space")
          throw new Error("That thread already belongs to another Space.");
        const { results } = await context.db
          .prepare(
            `UPDATE threads
                SET parent_thread_id = ?1,
                    requested_by_user_id = COALESCE(requested_by_user_id, ?4),
                    visibility = ?5, workspace_access = ?6,
                    shared_workspace_id = ?7, contribute_until = ?8,
                    updated_at = ?9
              WHERE owner_user_id = ?3 AND lifecycle_state != 'deleted'
                AND kind = 'thread'
                AND (id = ?2 OR parent_thread_id = ?2)
              RETURNING id`,
          )
          .bind(
            spaceThreadId,
            threadId,
            owner.owner_user_id,
            requesterUserId ?? owner.owner_user_id,
            owner.visibility,
            owner.workspace_access,
            owner.shared_workspace_id,
            owner.contribute_until,
            new Date().toISOString(),
          )
          .all<{ id: string }>();
        const added = results.map(({ id }) => id).sort();
        for (const id of added)
          await publishRealtimeInvalidation(
            context.bindings,
            id as ThreadId,
            "thread.invalidated",
            "audience",
          ).catch(() => undefined);
        await announceSpace(context);
        return { output: { added } };
      },
    }),
    defineTool({
      ...tool("set_thread_status"),
      input: v.object({
        status: v.pipe(
          v.string(),
          v.maxLength(STATUS_MAX_LENGTH),
          v.description(describe("set_thread_status", "status")),
        ),
        waiting_on_input: v.optional(
          v.pipe(
            v.boolean(),
            v.description(describe("set_thread_status", "waiting_on_input")),
          ),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const status = data.status.replace(/\s+/g, " ").trim();
        const waiting = status !== "" && data.waiting_on_input === true;
        await context.db.batch([
          context.db
            .prepare(
              "UPDATE threads SET status_line = ?2 WHERE id = ?1 AND kind = 'space'",
            )
            .bind(spaceThreadId, status === "" ? null : status),
          context.db
            .prepare(
              "UPDATE space SET waiting_on_input = ?2 WHERE thread_id = ?1",
            )
            .bind(spaceThreadId, waiting ? 1 : 0),
        ]);
        await announceSpace(context);
        return {
          output: {
            status: status === "" ? null : status,
            waiting_on_input: waiting,
          },
        };
      },
    }),
    defineTool({
      ...tool("archive_threads"),
      input: v.object({
        query: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
          v.description(describe("archive_threads", "query")),
        ),
        dryRun: v.pipe(
          v.boolean(),
          v.description(describe("archive_threads", "dryRun")),
        ),
      }),
      run: async ({ data }) => {
        const context = getContext();
        const owner = await space(context);
        const matches: Array<{ id: string; title: string }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = await searchThreads({
            db: context.db,
            bindings: context.bindings,
            scope: { userId: owner.owner_user_id },
            query: data.query,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const hit of result.items) {
            const item = searchThreadsItem(hit);
            if (
              item.ownerUserId === owner.owner_user_id &&
              !item.archived &&
              item.id !== spaceThreadId
            )
              matches.push({ id: item.id, title: item.title });
          }
          cursor = result.nextCursor;
          if (cursor === undefined) break;
        }
        // Never a Space: archiving one ends its whole room.
        const spaces = new Set(
          (
            await context.db
              .prepare(
                `SELECT id FROM threads WHERE kind = 'space'
                   AND id IN (SELECT value FROM json_each(?1))`,
              )
              .bind(JSON.stringify(matches.map(({ id }) => id)))
              .all<{ id: string }>()
          ).results.map(({ id }) => id),
        );
        const targets = matches.filter(({ id }) => !spaces.has(id));
        if (data.dryRun)
          return {
            output: {
              dryRun: true,
              count: targets.length,
              sample: targets.slice(0, 10).map(({ title }) => title),
            },
          };
        const failed: string[] = [];
        let archived = 0;
        for (const target of targets) {
          const { response } = await ownerRequest(
            {
              bindings: context.bindings,
              ownerUserId: owner.owner_user_id,
              sourceThreadId: spaceThreadId,
              ...(context.waitUntil === undefined
                ? {}
                : { waitUntil: context.waitUntil }),
            },
            "PATCH",
            `/v1/threads/${encodeURIComponent(target.id)}/archive`,
            { archived: true },
          );
          if (response.ok) archived += 1;
          else failed.push(target.id);
        }
        return {
          output: {
            dryRun: false,
            archived,
            ...(failed.length === 0 ? {} : { failed }),
          },
        };
      },
    }),
    defineTool({
      ...tool("get_current_time"),
      input: v.object({}),
      run: async () => {
        const context = getContext();
        const owner = await space(context);
        const timeZone = await ownerTimeZone(context.db, owner.owner_user_id);
        const now = new Date();
        let local: string;
        try {
          local = now.toLocaleString("en-US", {
            timeZone,
            dateStyle: "full",
            timeStyle: "long",
          });
        } catch {
          local = now.toUTCString();
        }
        return { output: { now: now.toISOString(), timeZone, local } };
      },
    }),
    defineTool({
      ...tool("get_current_user_identity"),
      input: v.object({}),
      run: async () => {
        const context = getContext();
        const owner = await space(context);
        const person = async (userId: string) => {
          const [identity, email] = await Promise.all([
            userIdentity(context.db, userId as UserId),
            context.db
              .prepare('SELECT email FROM "user" WHERE id = ?')
              .bind(userId)
              .first<string>("email"),
          ]);
          return { userId, ...identity, ...(email === null ? {} : { email }) };
        };
        return {
          output: {
            actsAs: await person(owner.owner_user_id),
            ...(requesterUserId === undefined ||
            requesterUserId === owner.owner_user_id
              ? {}
              : {
                  asker: {
                    userId: requesterUserId,
                    ...(await userIdentity(context.db, requesterUserId)),
                  },
                }),
          },
        };
      },
    }),
    defineTool({
      ...tool("list_workspace_members"),
      input: v.object({}),
      run: async () => {
        const context = getContext();
        const owner = await space(context);
        const workspaceId =
          owner.shared_workspace_id ??
          (await ownerWorkspaceId(context.db, owner.owner_user_id));
        if (workspaceId === undefined)
          return {
            output: {
              members: [
                {
                  userId: owner.owner_user_id,
                  ...(await userIdentity(context.db, owner.owner_user_id)),
                  role: "owner",
                },
              ],
            },
          };
        const { results } = await context.db
          .prepare(
            `SELECT "user".id AS user_id,
                    ${displayNameSql('"user"', "account")} AS name,
                    account.username AS handle, member.role,
                    ${userImageSql('"user"', "account")} AS image
               FROM member
               JOIN "user" ON "user".id = member.userId
               LEFT JOIN personal_account AS account ON account.user_id = "user".id
              WHERE member.organizationId = ?1
              ORDER BY member.createdAt, "user".id
              LIMIT 500`,
          )
          .bind(workspaceId)
          .all<{
            user_id: string;
            name: string | null;
            handle: string | null;
            role: string;
          }>();
        return {
          output: {
            members: results.map((row) => ({
              userId: row.user_id,
              name: row.name?.trim() || "Member",
              ...(row.handle === null || row.handle === ""
                ? {}
                : { handle: row.handle }),
              role: row.role,
            })),
          },
        };
      },
    }),
    defineTool({
      ...tool("search_dx_documentation"),
      input: v.object({
        query: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(500),
          v.description(describe("search_dx_documentation", "query")),
        ),
      }),
      run: async ({ data }) => ({
        output: { results: searchDxDocumentation(data.query) },
      }),
    }),
  ];
};
