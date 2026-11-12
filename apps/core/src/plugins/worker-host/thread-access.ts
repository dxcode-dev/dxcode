import { parseMessageAttachments, parseMessageAuthor } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import {
  activeMemberSql,
  threadProjectReachableSql,
} from "../../settings/members/membership-sql.js";
import {
  type HistoryMessage,
  type HistoryPage,
  readHistory,
} from "../../thread-search/history.js";
import {
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../../thread-sharing/access.js";
import { ownerRequest } from "../../threads/owner-request.js";
import type { PluginInstallRecord } from "./host.js";

/**
 * A plugin's reach into Threads (`permissions.threads` `read` and `post`).
 * Every request acts as the call's owner, through the routes the web client
 * uses, so a plugin reaches no Thread its owner could not open, and posts
 * only where they may write. The install's scope narrows that further:
 *
 * - personal: Threads the installer owns.
 * - workspace: the caller's own Threads in that workspace's Projects or
 *   their private ones, and Threads members shared with that workspace.
 * - repository: Threads of the repository's Project, though dx drops a
 *   repository plugin's read and post grants (repository-plugins.ts).
 *
 * Inside a Thread shared with its workspace, a plugin reaches only that
 * Thread's parent and children besides itself, as the agent's Thread tools
 * do, so a member cannot have it read the owner's private Threads. Spaces
 * are out of reach.
 *
 * One D1 statement decides reach and reads the Thread's metadata; messages
 * come from the Thread's agent, not D1.
 */

/** Messages `messages()` returns at most at once. */
export const THREAD_MESSAGES_LIMIT = 20;
const DEFAULT_MESSAGES_LIMIT = 10;
/** How far back `offset` may reach. */
export const THREAD_MESSAGES_MAX_OFFSET = 1_000;
const TEXT_CHARS = 32_000;
const TOOL_JSON_CHARS = 4_000;
/**
 * The longest message a plugin may post: room is left for the author tag
 * dx adds, within a note's 32,000 characters.
 */
export const THREAD_POST_MAX_CHARS = 30_000;

export type ThreadReachAccess = "owner" | "contribute" | "view";

export interface ThreadReach {
  readonly id: string;
  readonly title: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly parentThreadId: string | null;
  readonly archived: boolean;
  readonly working: boolean;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
  readonly access: ThreadReachAccess;
}

/** Why dx refused a Thread request; the message is the plugin's error. */
export class ThreadAccessRefused extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

interface ReachRow {
  readonly id: string;
  readonly title: string;
  readonly owner_user_id: string;
  readonly project_id: string;
  readonly project_workspace_id: string | null;
  readonly parent_thread_id: string | null;
  readonly shared_workspace_id: string | null;
  readonly lifecycle_state: string;
  readonly activity_status: string;
  readonly kind: string;
  readonly created_at: string;
  readonly last_activity_at: string | null;
  readonly access: ThreadReachAccess | null;
  readonly in_install_workspace: number;
  readonly calling_shared: number | null;
  readonly calling_root: string | null;
}

const THREAD_ID = /^thr_[A-Za-z0-9_-]{1,64}$/;

/** The Thread `targetId` as this call may reach it, or a refusal. */
export const reachThread = async (
  db: D1Database,
  call: {
    readonly install: PluginInstallRecord;
    readonly ownerUserId: string;
    readonly callingThreadId?: string;
  },
  targetId: unknown,
  need: "read" | "post",
): Promise<ThreadReach> => {
  if (typeof targetId !== "string" || !THREAD_ID.test(targetId))
    throw new ThreadAccessRefused(
      "A Thread id looks like thr_….",
      "invalid_id",
    );
  const { install, ownerUserId, callingThreadId } = call;
  const row = await db
    .prepare(
      `SELECT t.id, t.title, t.owner_user_id, t.project_id,
              p.workspace_id AS project_workspace_id, t.parent_thread_id,
              t.shared_workspace_id, t.lifecycle_state, t.activity_status,
              t.kind, t.created_at, t.last_activity_at,
              CASE
                WHEN t.owner_user_id = ?2
                 AND ${threadProjectReachableSql("p", "?2")} THEN 'owner'
                WHEN ${sharedThreadVisibleSql("t", "p", "?2")}
                  THEN ${sharedThreadAccessSql("t", "?3")}
              END AS access,
              ?5 = 'workspace' AND ${activeMemberSql("?6", "?2")}
                AS in_install_workspace,
              (SELECT c.workspace_access IS NOT NULL AND c.workspace_access != 'none'
                 FROM threads c WHERE c.id = ?4) AS calling_shared,
              (SELECT coalesce(c.parent_thread_id, c.id)
                 FROM threads c WHERE c.id = ?4) AS calling_root
         FROM threads t
         JOIN projects p ON p.id = t.project_id
        WHERE t.id = ?1 AND t.lifecycle_state != 'deleted'`,
    )
    .bind(
      targetId,
      ownerUserId,
      new Date().toISOString(),
      callingThreadId ?? "",
      install.scope,
      install.targetId,
    )
    .first<ReachRow>();
  const missing = () =>
    new ThreadAccessRefused(
      `Thread ${targetId} is not one this plugin may reach.`,
      "out_of_reach",
    );
  if (row === null || row.access === null || row.kind !== "thread")
    throw missing();
  const inScope =
    install.scope === "personal"
      ? row.access === "owner" && install.targetId === ownerUserId
      : install.scope === "repository"
        ? row.project_id === install.targetId
        : row.in_install_workspace === 1 &&
          (row.access === "owner"
            ? row.project_workspace_id === null ||
              row.project_workspace_id === install.targetId
            : row.shared_workspace_id === install.targetId);
  if (!inScope) throw missing();
  if (
    row.calling_shared === 1 &&
    row.id !== callingThreadId &&
    row.id !== row.calling_root &&
    row.parent_thread_id !== row.calling_root
  )
    throw new ThreadAccessRefused(
      `Thread ${targetId} is out of reach: from a Thread shared with its workspace, a plugin reaches only that Thread's parent and children.`,
      "shared_family",
    );
  if (need === "post") {
    if (row.access === "view")
      throw new ThreadAccessRefused(
        `Thread ${targetId} is shared for viewing only, so this plugin cannot post in it.`,
        "view_only",
      );
    if (row.lifecycle_state !== "active")
      throw new ThreadAccessRefused(
        `Thread ${targetId} is archived.`,
        "archived",
      );
  }
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    parentThreadId: row.parent_thread_id,
    archived: row.lifecycle_state !== "active",
    working: row.activity_status === "working",
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    access: row.access,
  };
};

/** What `ctx.thread.info()` answers. */
export const threadInfoOf = (reach: ThreadReach) => ({
  id: reach.id,
  title: reach.title,
  state: reach.working ? ("running" as const) : ("idle" as const),
  archived: reach.archived,
  projectId: reach.projectId,
  parentThreadId: reach.parentThreadId,
  createdAt: reach.createdAt,
  lastActivityAt: reach.lastActivityAt,
  access: reach.access,
});

// ─── Messages ──────────────────────────────────────────────────────────────

export interface ThreadMessagesOptions {
  readonly from: "start" | "end";
  readonly offset: number;
  readonly limit: number;
  readonly roles?: ReadonlyArray<"user" | "assistant">;
}

/** The plugin's options, checked; anything else is a plain error. */
export const threadMessagesOptionsOf = (
  options: unknown,
): ThreadMessagesOptions => {
  const raw =
    typeof options === "object" && options !== null
      ? (options as Record<string, unknown>)
      : {};
  const from = raw.from ?? "end";
  if (from !== "start" && from !== "end")
    throw new Error('messages() takes from "start" or "end".');
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new Error("offset and limit are whole numbers of 0 or more.");
    return Math.min(value, max);
  };
  const roles = raw.roles;
  if (
    roles !== undefined &&
    (!Array.isArray(roles) ||
      roles.some((role) => role !== "user" && role !== "assistant"))
  )
    throw new Error('roles lists "user" and "assistant".');
  return {
    from,
    offset: integer(raw.offset, 0, THREAD_MESSAGES_MAX_OFFSET),
    limit: integer(raw.limit, DEFAULT_MESSAGES_LIMIT, THREAD_MESSAGES_LIMIT),
    ...(roles === undefined
      ? {}
      : { roles: roles as Array<"user" | "assistant"> }),
  };
};

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseID: string;
      readonly status: "done" | "error" | "running";
      readonly output?: unknown;
    };

export interface PluginThreadMessage {
  readonly role: "user" | "assistant";
  readonly id: string;
  readonly createdAt?: string;
  readonly content: ReadonlyArray<Block>;
  readonly stopReason?: "end_turn" | "tool_use" | "cancelled";
  readonly author?:
    | {
        readonly kind: "person";
        readonly userId: string;
        readonly name: string;
      }
    | {
        readonly kind: "plugin";
        readonly pluginId: string;
        readonly name: string;
      }
    | { readonly kind: "thread"; readonly threadId: string }
    | { readonly kind: "automation"; readonly automation: string };
  readonly note?: true;
}

const clip = (text: string) =>
  text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}…` : text;

const compactJson = (value: unknown) => {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return json.length <= TOOL_JSON_CHARS
    ? value
    : { truncated: true, preview: json.slice(0, TOOL_JSON_CHARS) };
};

/** Who wrote a user message, from its author tag, as plugins see it. */
export const messageAuthorOf = (
  tag: ReturnType<typeof parseMessageAuthor>,
): PluginThreadMessage["author"] =>
  tag.plugin !== undefined
    ? { kind: "plugin", pluginId: tag.plugin.id, name: tag.plugin.name }
    : tag.sourceThreadId !== undefined
      ? { kind: "thread", threadId: tag.sourceThreadId }
      : tag.automation !== undefined
        ? { kind: "automation", automation: tag.automation }
        : tag.author !== undefined
          ? { kind: "person", userId: tag.author.userId, name: tag.author.name }
          : undefined;

const userMessageOf = (
  message: HistoryMessage,
): PluginThreadMessage | undefined => {
  const raw = (message.parts ?? [])
    .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
    .join("\n");
  const tag = parseMessageAuthor(raw);
  const text = parseMessageAttachments(tag.text).text.trim();
  if (text === "") return undefined;
  const author = messageAuthorOf(tag);
  return {
    role: "user",
    id: message.id,
    ...(message.timestamp === undefined
      ? {}
      : { createdAt: message.timestamp }),
    content: [{ type: "text", text: clip(text) }],
    ...(author === undefined ? {} : { author }),
    ...(tag.chat === true || message.purpose === "chat" ? { note: true } : {}),
  };
};

const assistantMessageOf = (
  message: HistoryMessage,
  page: HistoryPage,
): PluginThreadMessage | undefined => {
  const content: Block[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === "text" && part.text)
      content.push({ type: "text", text: clip(part.text) });
    else if (part.type === "reasoning" && part.text)
      content.push({ type: "thinking", thinking: clip(part.text) });
    else if (part.type === "dynamic-tool" && part.toolCallId !== undefined) {
      content.push({
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName ?? "tool",
        input: compactJson(part.input) ?? {},
      });
      const status =
        part.state === "output-available"
          ? "done"
          : part.state === "output-error"
            ? "error"
            : "running";
      content.push({
        type: "tool_result",
        toolUseID: part.toolCallId,
        status,
        ...(status === "done"
          ? { output: compactJson(part.output) }
          : status === "error"
            ? { output: part.errorText ?? "The tool failed." }
            : {}),
      });
    }
  }
  if (content.length === 0) return undefined;
  const outcome =
    message.submissionId === undefined
      ? undefined
      : page.settled.get(message.submissionId);
  const last = content.at(-1);
  const stopReason =
    outcome === "aborted"
      ? "cancelled"
      : last?.type === "tool_result"
        ? "tool_use"
        : outcome !== undefined
          ? "end_turn"
          : undefined;
  return {
    role: "assistant",
    id: message.id,
    ...(message.timestamp === undefined
      ? {}
      : { createdAt: message.timestamp }),
    content,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
};

/** One history page as plugin messages, oldest first. */
export const pluginMessagesOf = (
  page: HistoryPage,
): ReadonlyArray<PluginThreadMessage> =>
  page.messages.flatMap((message) => {
    const mapped =
      message.role === "user"
        ? userMessageOf(message)
        : message.role === "assistant" && message.purpose !== "advisory"
          ? assistantMessageOf(message, page)
          : undefined;
    return mapped === undefined ? [] : [mapped];
  });

const select = (
  messages: ReadonlyArray<PluginThreadMessage>,
  options: ThreadMessagesOptions,
) => {
  const kept =
    options.roles === undefined
      ? messages
      : messages.filter(({ role }) => options.roles?.includes(role));
  if (options.from === "start")
    return kept.slice(options.offset, options.offset + options.limit);
  const end = kept.length - options.offset;
  return end <= 0 ? [] : kept.slice(Math.max(0, end - options.limit), end);
};

/**
 * Reads messages as the call's owner. From the end it reads only the latest
 * prompts it needs (each prompt is at least one message), widening only when
 * a role filter leaves too few; from the start it reads the whole history.
 */
export const readPluginThreadMessages = async (
  bindings: Bindings,
  ownerUserId: string,
  threadId: string,
  options: ThreadMessagesOptions,
): Promise<ReadonlyArray<PluginThreadMessage>> => {
  if (options.limit === 0) return [];
  const needed = options.offset + options.limit;
  let promptLimit: number | undefined =
    options.from === "start" ? undefined : needed;
  for (;;) {
    const read = await readHistory(
      bindings,
      ownerUserId as UserId,
      threadId,
      promptLimit,
    );
    if (read.kind === "empty") return [];
    if (read.kind === "busy")
      throw new Error("The Thread's history is busy; try again shortly.");
    if (read.kind === "unavailable")
      throw new Error(
        `dx could not read the Thread's messages (HTTP ${read.status}).`,
      );
    const messages = pluginMessagesOf(read.page);
    const kept =
      options.roles === undefined
        ? messages.length
        : messages.filter(({ role }) => options.roles?.includes(role)).length;
    if (promptLimit === undefined || kept >= needed || !read.page.hasOlder)
      return select(messages, options);
    promptLimit = promptLimit >= 128 ? undefined : promptLimit * 8;
  }
};

// ─── Posting ───────────────────────────────────────────────────────────────

/**
 * Posts a message, or a note, into a Thread as the call's owner, attributed
 * to the plugin. A message wakes the agent (or joins its running turn); a
 * note is recorded for everyone without a model call and reaches the agent
 * as background with its next message.
 */
export const postPluginThreadMessage = async (
  bindings: Bindings,
  input: {
    readonly ownerUserId: string;
    readonly threadId: string;
    readonly install: PluginInstallRecord;
    readonly body: string;
    readonly note: boolean;
    readonly idempotencyKey: string;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  },
) => {
  const { response, payload } = await ownerRequest(
    {
      bindings,
      ownerUserId: input.ownerUserId as UserId,
      plugin: {
        plugin: {
          id: input.install.pluginId,
          name: input.install.displayName,
          scope: input.install.scope,
        },
        note: input.note,
      },
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    },
    "POST",
    `/v1/agents/dx/${encodeURIComponent(input.threadId)}`,
    { kind: "user", body: input.body, idempotencyKey: input.idempotencyKey },
  );
  const submissionId = payload?.submissionId;
  if (response.status !== 202 || typeof submissionId !== "string") {
    const failure =
      (payload?.data as { readonly message?: unknown } | undefined)?.message ??
      (payload?.error as { readonly message?: unknown } | undefined)?.message;
    throw new Error(
      `dx could not post into the Thread (HTTP ${response.status}${
        typeof failure === "string" ? `: ${failure}` : ""
      }).`,
    );
  }
  return { submissionId };
};
