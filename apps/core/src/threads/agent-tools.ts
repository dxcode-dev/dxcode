import {
  CLAUDE_CODE_DEFAULT_EFFORT,
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_MODELS,
  CLAUDE_CODE_PROVIDER_ID,
  isClaudeCodeModel,
  ModeId,
  PROJECTLESS_PROJECT_NAME,
  type RunnerProfileCatalog,
  THREAD_COLORS,
  type ThreadId,
  type ThreadModelSelection,
} from "@dx/domain";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { Effect, Result, Schema } from "effect";
import * as v from "valibot";
import { loadRunnerProfileCatalog } from "../execution/runner-profiles/catalog.js";
import type { Bindings } from "../http/types.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import { listenForThreadHints } from "../realtime/thread-hints.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import { createThreadSearchTools } from "../thread-search/agent-tools.js";
import { resolveOrbChoice } from "./agent-orbs.js";
import { type CallingThread, readCallingThread } from "./calling-thread.js";
import { ownerRequest as requestAsOwner } from "./owner-request.js";

/** The Worker bindings the Thread tools resolve against at call time. */
export interface ThreadToolsContext {
  readonly db: D1Database;
  readonly bindings: Bindings;
  /** Keeps work a route starts, such as title generation, running. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** The longest `wait_for_threads` blocks. */
const WAIT_MAX_SECONDS = 300;
/** How often `wait_for_threads` reads D1 without realtime hints. */
const WAIT_POLL_MS = 2_000;
/** How long a hinted wait trusts the hub before reading D1 anyway. */
const WAIT_HINT_RECHECK_MS = 10_000;
const WAIT_MAX_THREADS = 20;
const MESSAGE_MAX_CHARS = 32_000;
const THREAD_ID_MAX_CHARS = 128;

const description = (lines: ReadonlyArray<string>) => lines.join("\n\n");

const pause = (milliseconds: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    // A long wait pauses many times; each pause removes its listener.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });

const sha256Hex = async (seed: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** A stable Thread ID per tool call, so a retried call reuses its Thread. */
const idempotentThreadId = async (seed: string) => {
  const hex = (await sha256Hex(seed)).slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `thr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

interface ThreadRow {
  readonly id: string;
  readonly title: string;
  readonly title_pending_until: string | null;
  readonly project_id: string;
  readonly parent_thread_id: string | null;
  readonly color: string | null;
  readonly lifecycle_state: string;
  readonly activity_status: "idle" | "working";
  readonly last_activity_at: string | null;
  readonly created_at: string;
  readonly snoozed_until: string | null;
}

/** What the tools report for one Thread. */
const threadState = (row: ThreadRow) => ({
  threadId: row.id,
  title: row.title,
  ...(row.title_pending_until !== null &&
  Date.parse(row.title_pending_until) > Date.now()
    ? { titlePending: true }
    : {}),
  projectId: row.project_id,
  ...(row.parent_thread_id === null
    ? {}
    : { parentThreadId: row.parent_thread_id }),
  color: row.color ?? "auto",
  state: row.activity_status,
  archived: row.lifecycle_state !== "active",
  ...(row.snoozed_until !== null &&
  row.lifecycle_state === "active" &&
  Date.parse(row.snoozed_until) > Date.now()
    ? { snoozedUntil: row.snoozed_until }
    : {}),
  lastActivityAt: row.last_activity_at ?? row.created_at,
  createdAt: row.created_at,
});

const isMode = Schema.is(ModeId);

/** The agent modes create_thread accepts, in the order they are listed. */
const AGENT_MODES = [
  ...ModeId.literals,
  CLAUDE_CODE_PROVIDER_ID,
  ...CLAUDE_CODE_MODELS.map(({ id }) => `${CLAUDE_CODE_PROVIDER_ID}/${id}`),
];

/**
 * A child Thread's selection for an agent mode. A dx mode keeps the calling
 * Thread's profile. Claude Code (`claude-code`, or `claude-code/<model>`)
 * pins a Claude Code model on the owner's Claude Pro/Max plan: bare, the
 * calling Thread's Claude Code model or the default; at the calling Thread's
 * Claude Code effort or the default.
 */
const agentModeSelection = (
  agentMode: string,
  caller: ThreadModelSelection | undefined,
): ThreadModelSelection => {
  if (isMode(agentMode))
    return {
      kind: "mode",
      profileId: caller?.kind === "mode" ? caller.profileId : "default",
      mode: agentMode,
    } as ThreadModelSelection;
  const claudeCaller =
    caller?.kind === "model" && isClaudeCodeModel(caller.model)
      ? caller
      : undefined;
  const model =
    agentMode === CLAUDE_CODE_PROVIDER_ID
      ? (claudeCaller?.model ?? CLAUDE_CODE_DEFAULT_MODEL)
      : agentMode;
  if (!AGENT_MODES.includes(model) || isMode(model))
    throw new Error(
      `agent_mode must be one of ${ModeId.literals.join(", ")}. For Claude Code, use ${CLAUDE_CODE_PROVIDER_ID} or ${CLAUDE_CODE_PROVIDER_ID}/<model> from list_agent_modes.`,
    );
  return {
    kind: "model",
    model,
    thinking: claudeCaller?.thinking ?? CLAUDE_CODE_DEFAULT_EFFORT,
  } as ThreadModelSelection;
};

/**
 * Tools that let the agent start, message, check on, wait for, and update
 * the owner's other Threads. Every call acts as the calling Thread's owner,
 * whoever sent the message that started the turn, and reaches only Threads
 * that owner owns. A Thread started here is the owner's private Thread and
 * lists under the calling Thread, or under its parent when the calling
 * Thread is itself a child.
 */
export const createThreadTools = (
  callingThreadId: string,
  getContext: () => ThreadToolsContext,
  /** The submission this turn runs, which a retried tool call shares. */
  submissionId?: string,
  /** Claude Code mode: read_thread returns material instead of an answer. */
  claudeCode = false,
): ToolDefinition[] => {
  /**
   * What a tool call's Thread IDs and message keys derive from, so a retry
   * of the call reuses them. Providers may repeat or omit tool call IDs
   * across turns, so the submission is part of it; a call with no ID gets a
   * fresh seed and is not retried safely, but never reuses another's work.
   */
  const callSeed = (toolCallId: string) =>
    toolCallId.trim() === ""
      ? `${callingThreadId}:${crypto.randomUUID()}`
      : `${callingThreadId}:${submissionId ?? ""}:${toolCallId}`;

  const callingThread = (context: ThreadToolsContext) =>
    readCallingThread(context.db, callingThreadId);

  /** The owner's Threads among `threadIds`; others are absent. */
  const readThreads = async (
    context: ThreadToolsContext,
    owner: CallingThread,
    threadIds: ReadonlyArray<string>,
  ) => {
    const rows = await context.db
      .prepare(
        `SELECT id, title, title_pending_until, project_id, parent_thread_id, color,
           lifecycle_state, activity_status, last_activity_at, created_at,
           snoozed_until
         FROM threads
         WHERE owner_user_id = ? AND lifecycle_state != 'deleted'
           AND id IN (${threadIds.map(() => "?").join(", ")})${
             owner.sharedFamilyRoot === undefined
               ? ""
               : " AND (id = ? OR parent_thread_id = ?)"
}`,
      )
      .bind(
        owner.ownerUserId,
        ...threadIds,
        ...(owner.sharedFamilyRoot === undefined
          ? []
          : [owner.sharedFamilyRoot, owner.sharedFamilyRoot]),
      )
      .all<ThreadRow>();
    return new Map(rows.results.map((row) => [row.id, row]));
  };

  const readThread = async (
    context: ThreadToolsContext,
    owner: CallingThread,
    threadId: string,
  ) => {
    const row = (await readThreads(context, owner, [threadId])).get(threadId);
    if (row === undefined)
      throw new Error(
        owner.sharedFamilyRoot === undefined
          ? `Thread ${threadId} was not found among this Thread owner's Threads.`
          : `Thread ${threadId} is not reachable from this shared Thread: it reaches only its parent and child Threads.`,
      );
    return row;
  };

  /** Calls the web client's routes as the Thread owner; see `ownerRequest`. */
  const ownerRequest = (
    context: ThreadToolsContext,
    owner: CallingThread,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ) =>
    requestAsOwner(
      {
        bindings: context.bindings,
        ownerUserId: owner.ownerUserId,
        // Messages this request delivers come from the calling Thread.
        sourceThreadId: callingThreadId,
        ...(context.waitUntil === undefined
          ? {}
          : { waitUntil: context.waitUntil }),
      },
      method,
      path,
      body,
    );

  /** The route's error code and message, from a dx or a Flue error body. */
  const routeFailure = (
    operation: string,
    status: number,
    payload: Record<string, unknown> | undefined,
  ) => {
    const detail = (payload?.data ?? payload?.error) as
      | { code?: string; type?: string; message?: string }
      | undefined;
    const code = detail?.code ?? detail?.type ?? status;
    return new Error(
      `${operation} failed: ${code}${detail?.message === undefined ? "" : ` (${detail.message})`}`,
    );
  };

  /**
   * Waits briefly until Thread activity has recorded a just-admitted
   * submission, so a status check or wait that follows reports it working.
   */
  const awaitActivity = async (
    context: ThreadToolsContext,
    threadId: string,
    submissionId: string,
    signal: AbortSignal | undefined,
  ) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await context.db
        .prepare(
          "SELECT 1 AS seen FROM thread_activity_submission WHERE thread_id = ? AND submission_id = ?",
        )
        .bind(threadId, submissionId)
        .first();
      if (row !== null) return;
      await pause(200, signal);
    }
  };

  interface HistoryMessage {
    readonly role?: string;
    readonly purpose?: string;
    readonly parts?: ReadonlyArray<{ readonly type?: string; text?: string }>;
  }

  /**
   * The whole text of the Thread's latest agent message, read from the
   * history route the web client loads, so a parent gets a child's full
   * report; null before the agent has answered.
   */
  const lastAgentMessage = async (
    context: ThreadToolsContext,
    owner: CallingThread,
    threadId: string,
  ) => {
    const { response, payload } = await ownerRequest(
      context,
      owner,
      "GET",
      `/v1/agents/dx/${encodeURIComponent(threadId)}?view=history&promptLimit=1`,
    );
    // No conversation yet, archived, or Flue is still indexing its history.
    if (
      response.status === 404 ||
      response.status === 409 ||
      response.status === 503
    )
      return null;
    if (!response.ok)
      throw routeFailure("Reading the Thread", response.status, payload);
    const messages = (payload?.messages ?? []) as ReadonlyArray<HistoryMessage>;
    const message = messages.findLast(
      ({ role, purpose }) => role === "assistant" && purpose === "assistant",
    );
    const text = (message?.parts ?? [])
      .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
      .join("\n")
      .trim();
    return text === "" ? null : text;
  };

  /** The project a child joins when the call names none: the caller's. */
  const defaultProjectId = async (
    context: ThreadToolsContext,
    owner: CallingThread,
  ) => {
    const project = await context.db
      .prepare("SELECT name, owner_user_id FROM projects WHERE id = ?")
      .bind(owner.projectId)
      .first<{ name: string; owner_user_id: string }>();
    // A projectless Thread's child is projectless too; the route resolves
    // the owner's projectless defaults when no project is named.
    return project !== null &&
      project.name === PROJECTLESS_PROJECT_NAME &&
      project.owner_user_id === owner.ownerUserId
      ? undefined
      : owner.projectId;
  };

  const withContext = async <T>(
    use: (context: ThreadToolsContext, owner: CallingThread) => Promise<T>,
  ) => {
    const context = getContext();
    return use(context, await callingThread(context));
  };

  const threadIdInput = (text: string) =>
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(THREAD_ID_MAX_CHARS),
      v.description(text),
    );

  /** The deployment's Orb catalog; a missing or invalid one has no Orbs. */
  const orbCatalog = async (context: ThreadToolsContext) => {
    const loaded = await Effect.runPromise(
      Effect.result(loadRunnerProfileCatalog(context.bindings)),
    );
    if (Result.isFailure(loaded))
      throw new Error("This deployment's Orb catalog is unavailable.");
    return loaded.success.publicCatalog;
  };
  return [
    defineTool({
      name: "create_thread",
      description: description([
        "Start a child Thread: a new dx Thread with its own agent and its own Orb that works on a task while you continue. It belongs to this Thread's owner, stays private to them, and lists under this Thread in their sidebar.",
        "Use a child Thread for a self-contained task that can run on its own or in parallel with yours, or that needs a separate Orb. Do the work yourself when it is small, when you need its result immediately, or when it depends on files you changed here.",
        "Files do not transfer. The child starts from its project's repository, not from this Orb, so uncommitted changes here are invisible to it. Put everything it needs in the prompt, and push any commits it must build on first.",
        "Returns the child's thread ID. The child sends its result to this Thread as a message when it finishes, and that message starts a new turn here. Use send_thread_message for follow-ups.",
        "Before choosing an Orb or a mode, call list_orbs for the providers and sizes the owner can start, and list_agent_modes for the modes and the models they run. Omit them to use the project's Orb and this Thread's mode.",
      ]),
      input: v.object({
        prompt: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MESSAGE_MAX_CHARS),
          v.description(
            "The complete task for the child's agent. It cannot see this conversation.",
          ),
        ),
        title: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(256),
            v.description(
              "Title for the child Thread in the sidebar; kept as given. Omit to have one generated.",
            ),
          ),
        ),
        project_id: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Project ID for the child Thread. Defaults to this Thread's project.",
            ),
          ),
        ),
        orb_provider: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(64),
            v.description(
              "The Orb provider, such as e2b or cloudflare. With no orb_size, the provider's default size. Omit both for the project's Orb.",
            ),
          ),
        ),
        orb_size: v.optional(
          v.pipe(
            v.string(),
            v.maxLength(64),
            v.description(
              "The Orb size: a size ID such as a1.tiny, or its short name such as tiny when orb_provider is set. Omit both for the project's Orb.",
            ),
          ),
        ),
        agent_mode: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "How much model effort the child gets: low, medium, high, or ultra. Or claude-code, or claude-code/<model> from list_agent_modes, to run the child through Claude Code on the owner's Claude Pro/Max plan. Defaults to this Thread's mode.",
            ),
          ),
        ),
      }),
      run: async ({ data, toolCallId, signal }) =>
        withContext(async (context, owner) => {
          const selection: ThreadModelSelection | undefined =
            data.agent_mode === undefined
              ? owner.selection
              : agentModeSelection(data.agent_mode, owner.selection);
          const runnerProfileId =
            data.orb_provider === undefined && data.orb_size === undefined
              ? undefined
              : resolveOrbChoice(
                  await orbCatalog(context),
                  data.orb_provider,
                  data.orb_size,
                );
          const projectId =
            data.project_id ?? (await defaultProjectId(context, owner));
          // A retried tool call reuses its Thread.
          const threadId = await idempotentThreadId(callSeed(toolCallId));
          signal?.throwIfAborted();
          const { response, payload } = await ownerRequest(
            context,
            owner,
            "POST",
            "/v1/threads",
            {
              threadId,
              parentThreadId: callingThreadId,
              ...(projectId === undefined ? {} : { projectId }),
              // An explicit title is final: DxTitleAgent does not replace it.
              ...(data.title === undefined
                ? {}
                : { title: data.title, generateTitle: false }),
              ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
              ...(selection === undefined ? {} : { selection }),
              initialMessage: { body: data.prompt, attachments: [] },
            },
          );
          const created = payload?.data as
            | { readonly id?: string; readonly projectId?: string }
            | undefined;
          const submission = payload?.initialSubmission as
            | { readonly submissionId?: string }
            | undefined;
          if (!response.ok || created?.id === undefined)
            throw routeFailure("create_thread", response.status, payload);
          if (submission?.submissionId !== undefined)
            await awaitActivity(
              context,
              created.id,
              submission.submissionId,
              signal,
            );
          return {
            output: {
              threadId: created.id,
              projectId: created.projectId ?? projectId ?? null,
            },
          };
        }),
    }),
    defineTool({
      name: "send_thread_message",
      description: description([
        "Send a message to another of this Thread owner's Threads, such as a child you started. It shows there as a message from this Thread. Returns as soon as the Thread accepts it. A child you started replies with a message to this Thread; ask any other Thread for a reply in the message if you want one.",
        "Only the owner's own Threads can receive it, not Threads other people shared with them. If the Thread is working, the message steers its current turn. A message carries text only: files and commits do not transfer.",
      ]),
      input: v.object({
        thread: threadIdInput("The thread ID, as create_thread returned it."),
        message: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MESSAGE_MAX_CHARS),
          v.description("The message to deliver. Write it in full."),
        ),
      }),
      run: async ({ data, toolCallId, signal }) =>
        withContext(async (context, owner) => {
          if (data.thread === callingThreadId)
            throw new Error("A Thread cannot send a message to itself.");
          const thread = await readThread(context, owner, data.thread);
          if (thread.lifecycle_state !== "active")
            throw new Error(`Thread ${data.thread} is archived.`);
          const working = thread.activity_status === "working";
          signal?.throwIfAborted();
          const { response, payload } = await ownerRequest(
            context,
            owner,
            "POST",
            `/v1/agents/dx/${encodeURIComponent(data.thread)}`,
            {
              kind: "user",
              body: data.message,
              idempotencyKey: await sha256Hex(`${callSeed(toolCallId)}:send`),
            },
          );
          const submissionId = payload?.submissionId;
          if (response.status !== 202 || typeof submissionId !== "string")
            throw routeFailure("send_thread_message", response.status, payload);
          await awaitActivity(context, data.thread, submissionId, signal);
          // Flue shows a message joining a running turn only once it joins;
          // until then the Thread's clients show that it is on its way. The
          // message itself stays in Flue.
          if (working) {
            const markSource = async () =>
              (
                await context.db
                  .prepare(
                    `UPDATE thread_activity_submission SET source_thread_id = ?
                      WHERE thread_id = ? AND submission_id = ?`,
                  )
                  .bind(callingThreadId, data.thread, submissionId)
                  .run()
              ).meta.changes > 0;
            // Thread activity can record the submission after the first
            // wait; one more wait catches a slow record.
            if (!(await markSource())) {
              await awaitActivity(context, data.thread, submissionId, signal);
              await markSource();
            }
            await publishRealtimeInvalidation(
              context.bindings,
              data.thread as ThreadId,
              "thread.invalidated",
            ).catch(() => undefined);
          }
          return {
            output: { threadId: data.thread, submissionId, steered: working },
          };
        }),
    }),
    defineTool({
      name: "get_thread_status",
      description: description([
        "Check one of this Thread owner's Threads: whether its agent is working or idle, its title, its last activity, and the text of its latest agent message.",
        "Idle means the Thread finished its turn and is waiting for a message, not that it failed. A child you started messages this Thread when it finishes, so do not call this repeatedly.",
      ]),
      input: v.object({ thread: threadIdInput("The thread ID.") }),
      run: async ({ data }) =>
        withContext(async (context, owner) => {
          const thread = await readThread(context, owner, data.thread);
          return {
            output: {
              ...threadState(thread),
              lastMessage: await lastAgentMessage(context, owner, data.thread),
            },
          };
        }),
    }),
    defineTool({
      name: "wait_for_threads",
      description: description([
        "Wait until each listed Thread is idle, meaning its agent finished its turn, or until the timeout. Returns each Thread's state and the text of its latest agent message, and settled: true when every Thread is idle or archived.",
        "Use it only when you cannot continue your turn without a Thread's result; otherwise a child's result arrives as a message that starts a new turn here. On a timeout, call it again to keep waiting.",
      ]),
      input: v.object({
        threads: v.pipe(
          v.array(threadIdInput("A thread ID.")),
          v.minLength(1),
          v.maxLength(WAIT_MAX_THREADS),
          v.description(`Thread IDs to wait on, at most ${WAIT_MAX_THREADS}.`),
        ),
        timeout_seconds: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(WAIT_MAX_SECONDS),
            v.description(
              `Seconds to wait, from 1 to ${WAIT_MAX_SECONDS}. Defaults to 120.`,
            ),
          ),
        ),
      }),
      run: async ({ data, signal }) =>
        withContext(async (context, owner) => {
          const ids = [...new Set(data.threads)];
          if (ids.includes(callingThreadId))
            throw new Error("A Thread cannot wait for itself.");
          const deadline = Date.now() + (data.timeout_seconds ?? 120) * 1_000;
          const isSettled = (rows: ReadonlyMap<string, ThreadRow>) =>
            ids.every((id) => {
              const row = rows.get(id);
              return (
                row === undefined ||
                row.activity_status === "idle" ||
                row.lifecycle_state !== "active"
              );
            });
          let rows = await readThreads(context, owner, ids);
          // Threads already settled need no hub connection. Otherwise
          // subscribe, then read again, so a Thread that settled before the
          // subscription is seen and one that settles after sends this wait
          // a hint. Without the hub, poll D1.
          const hints = isSettled(rows)
            ? undefined
            : await listenForThreadHints(
                context.bindings,
                owner.ownerUserId,
                ids,
              );
          let listening = hints !== undefined;
          try {
            if (hints !== undefined)
              rows = await readThreads(context, owner, ids);
            while (!isSettled(rows)) {
              const remaining = deadline - Date.now();
              if (listening && hints !== undefined) {
                if (remaining <= 0) break;
                // A hint wakes the wait; D1 decides. The periodic read
                // covers a hint the best-effort hub dropped.
                const wake = await hints.next(
                  Math.min(remaining, WAIT_HINT_RECHECK_MS),
                  signal,
                );
                if (wake === "closed") listening = false;
              } else {
                if (remaining < WAIT_POLL_MS) break;
                await pause(WAIT_POLL_MS, signal);
              }
              rows = await readThreads(context, owner, ids);
            }
          } finally {
            hints?.close();
          }
          const settled = isSettled(rows);
          return {
            output: {
              settled,
              threads: await Promise.all(
                ids.map(async (id) => {
                  const row = rows.get(id);
                  return row === undefined
                    ? { threadId: id, state: "not-found" }
                    : {
                        ...threadState(row),
                        lastMessage: await lastAgentMessage(context, owner, id),
                      };
                }),
              ),
            },
          };
        }),
    }),
    defineTool({
      name: "list_orbs",
      description: description([
        "List the Orbs this Thread's owner can start a child Thread on: each provider (such as e2b or cloudflare) with its status and whose key pays, and the sizes it offers with CPU, memory, and disk. Also returns the size a new Thread in the project gets by default.",
        "Call it before create_thread when the user names a provider or size, or asks what is available. Pass the provider ID and a size ID to create_thread as orb_provider and orb_size.",
      ]),
      input: v.object({
        project_id: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Project ID to check. Defaults to this Thread's project.",
            ),
          ),
        ),
      }),
      run: async ({ data }) =>
        withContext(async (context, owner) => {
          const projectId =
            data.project_id ?? (await defaultProjectId(context, owner));
          const query =
            projectId === undefined
              ? ""
              : `?projectId=${encodeURIComponent(projectId)}`;
          const [providers, defaults] = await Promise.all([
            ownerRequest(
              context,
              owner,
              "GET",
              `/v1/settings/personal/orb-providers${query}`,
            ),
            ownerRequest(
              context,
              owner,
              "GET",
              "/v1/settings/personal/projects",
            ),
          ]);
          if (!providers.response.ok)
            throw routeFailure(
              "list_orbs",
              providers.response.status,
              providers.payload,
            );
          if (!defaults.response.ok)
            throw routeFailure(
              "list_orbs",
              defaults.response.status,
              defaults.payload,
            );
          const resolved =
            (
              providers.payload?.data as
                | {
                    readonly resolved: ReadonlyArray<{
                      readonly providerId: string;
                      readonly scope: string;
                      readonly status: string;
                    }>;
                  }
                | undefined
            )?.resolved ?? [];
          const settings = defaults.payload?.data as
            | {
                readonly catalog: RunnerProfileCatalog;
                readonly restrictions: {
                  readonly allowedRunnerProfileIds: ReadonlyArray<string> | null;
                };
                readonly resolved: {
                  readonly runnerProfileId: { readonly value: string };
                };
              }
            | undefined;
          if (settings === undefined)
            throw new Error(
              "list_orbs failed: the Orb catalog is unavailable.",
            );
          const allowed = settings.restrictions.allowedRunnerProfileIds;
          // Only a project the owner reaches: their own, or their
          // workspace's while they belong to it.
          const projectDefault =
            projectId === undefined
              ? null
              : await context.db
                  .prepare(
                    `SELECT runner_profile_id FROM projects
                      WHERE id = ?1 AND ${threadProjectReachableSql("projects", "?2")}`,
                  )
                  .bind(projectId, owner.ownerUserId)
                  .first<string>("runner_profile_id");
          if (data.project_id !== undefined && projectDefault === null)
            throw new Error(`Project ${data.project_id} was not found.`);
          return {
            output: {
              projectId: projectId ?? null,
              defaultSize:
                projectDefault ?? settings.resolved.runnerProfileId.value,
              providers: (
                settings.catalog.providers ??
                [
                  ...new Set(settings.catalog.profiles.map((p) => p.adapter)),
                ].map((adapter) => ({ adapter, displayName: adapter }))
              ).map((provider) => {
                const usable = resolved.find(
                  ({ providerId }) => providerId === provider.adapter,
                );
                return {
                  provider: provider.adapter,
                  name: provider.displayName,
                  // ready, building, or failed; unavailable when the owner
                  // has no key or deployment access for it.
                  status: usable?.status ?? "unavailable",
                  ...(usable === undefined ? {} : { paidBy: usable.scope }),
                  sizes: settings.catalog.profiles
                    .filter(
                      (profile) =>
                        profile.adapter === provider.adapter &&
                        profile.availability === "available" &&
                        (allowed === null || allowed.includes(profile.id)),
                    )
                    .map((profile) => ({
                      size: profile.id,
                      cpu: profile.resources.cpuCores,
                      memoryGb: profile.resources.memoryMb / 1024,
                      diskGb: profile.resources.diskGb,
                    })),
                };
              }),
            },
          };
        }),
    }),
    defineTool({
      name: "list_agent_modes",
      description: description([
        "List the agent modes a child Thread can run in (low, medium, high, ultra) with the model and thinking level each uses for this Thread's owner, and whether a connection serves that model now. When the owner has connected a Claude Pro/Max plan, it also lists claude-code/<model> modes, which run the child through Claude Code on that plan. Also returns this Thread's mode, which a child gets by default.",
        "Call it before create_thread when the user asks for a mode or a model. Pass the mode to create_thread as agent_mode.",
      ]),
      input: v.object({}),
      run: async () =>
        withContext(async (context, owner) => {
          const { response, payload } = await ownerRequest(
            context,
            owner,
            "GET",
            "/v1/settings/personal/model-routing/choices",
          );
          if (!response.ok)
            throw routeFailure("list_agent_modes", response.status, payload);
          const choices = payload?.data as
            | {
                readonly modes: ReadonlyArray<{
                  readonly mode: string;
                  readonly config: {
                    readonly model: string;
                    readonly thinking: string;
                  };
                  readonly served: boolean;
                  readonly servingConnectionName: string | null;
                }>;
                readonly models?: ReadonlyArray<{
                  readonly canonical: string;
                  readonly connectionName?: string | null;
                }>;
              }
            | undefined;
          const claudeCaller =
            owner.selection?.kind === "model" &&
            isClaudeCodeModel(owner.selection.model)
              ? owner.selection
              : undefined;
          return {
            output: {
              currentMode:
                owner.selection?.kind === "mode"
                  ? owner.selection.mode
                  : claudeCaller !== undefined
                    ? claudeCaller.model
                    : owner.selection?.kind === "model"
                      ? `model:${owner.selection.model}`
                      : "medium",
              modes: [
                ...(choices?.modes ?? []).map((mode) => ({
                  mode: mode.mode,
                  model: mode.config.model,
                  thinking: mode.config.thinking,
                  served: mode.served,
                  ...(mode.servingConnectionName === null
                    ? {}
                    : { connection: mode.servingConnectionName }),
                })),
                // Served only while the owner's plan is connected.
                ...(choices?.models ?? [])
                  .filter(({ canonical }) => isClaudeCodeModel(canonical))
                  .map((model) => ({
                    mode: model.canonical,
                    model: model.canonical,
                    thinking:
                      claudeCaller?.thinking ?? CLAUDE_CODE_DEFAULT_EFFORT,
                    served: true,
                    agent: "Claude Code",
                    ...(model.connectionName == null
                      ? {}
                      : { connection: model.connectionName }),
                  })),
              ],
            },
          };
        }),
    }),
    defineTool({
      name: "update_thread",
      description: description([
        "Rename, recolor, pin or unpin, snooze or wake, or archive or restore one of this Thread owner's Threads. Omit thread to update this Thread. Change only what the user asked for.",
        "Archiving stops the Thread's Orb, so this Thread cannot archive itself.",
        "Snoozing hides a Thread from the owner's sidebar until its wake time; it keeps its Orb and keeps working. A message someone sends wakes it early. Threads started by another Thread follow their parent and cannot be snoozed.",
      ]),
      input: v.object({
        thread: v.optional(
          threadIdInput("The thread ID. Omit to update this Thread."),
        ),
        title: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(256),
            v.description("New title."),
          ),
        ),
        color: v.optional(
          v.pipe(
            v.picklist([...THREAD_COLORS, "auto"]),
            v.description(
              `The Thread's color in the sidebar: ${THREAD_COLORS.join(", ")}, or auto to derive one from the Thread.`,
            ),
          ),
        ),
        pinned: v.optional(
          v.pipe(v.boolean(), v.description("True to pin, false to unpin.")),
        ),
        archived: v.optional(
          v.pipe(
            v.boolean(),
            v.description("True to archive, false to restore."),
          ),
        ),
        snoozed_until: v.optional(
          v.pipe(
            v.string(),
            v.check(
              (value) => value === "none" || !Number.isNaN(Date.parse(value)),
              "Use an ISO 8601 date and time, or none.",
            ),
            v.description(
              "ISO 8601 date and time to snooze the Thread until, within a year, such as 2026-10-22T09:00:00+05:30; or none to wake it.",
            ),
          ),
        ),
      }),
      run: async ({ data }) =>
        withContext(async (context, owner) => {
          const threadId = data.thread ?? callingThreadId;
          if (
            data.title === undefined &&
            data.color === undefined &&
            data.pinned === undefined &&
            data.archived === undefined &&
            data.snoozed_until === undefined
          )
            throw new Error(
              "Name at least one of title, color, pinned, snoozed_until, or archived.",
            );
          if (data.archived === true && threadId === callingThreadId)
            throw new Error("This Thread cannot archive itself.");
          await readThread(context, owner, threadId);
          const patch = async (path: string, body: unknown) => {
            const { response, payload } = await ownerRequest(
              context,
              owner,
              "PATCH",
              `/v1/threads/${encodeURIComponent(threadId)}${path}`,
              body,
            );
            if (!response.ok)
              throw routeFailure("update_thread", response.status, payload);
          };
          // Restore before pinning: only an active Thread can be pinned.
          if (data.archived === false)
            await patch("/archive", { archived: false });
          // A rename also ends a pending generated title.
          if (data.title !== undefined || data.color !== undefined)
            await patch("", {
              ...(data.title === undefined ? {} : { title: data.title }),
              ...(data.color === undefined
                ? {}
                : { color: data.color === "auto" ? null : data.color }),
            });
          if (data.pinned !== undefined)
            await patch("/pin", { pinned: data.pinned });
          // After pinning, which wakes a snoozed Thread.
          if (data.snoozed_until !== undefined)
            await patch("/snooze", {
              snoozedUntil:
                data.snoozed_until === "none"
                  ? null
                  : new Date(data.snoozed_until).toISOString(),
            });
          if (data.archived === true)
            await patch("/archive", { archived: true });
          return {
            output: threadState(await readThread(context, owner, threadId)),
          };
        }),
    }),
    // find_thread and read_thread only read; see thread-search/agent-tools.ts.
    ...createThreadSearchTools(callingThreadId, getContext, { claudeCode }),
  ];
};
