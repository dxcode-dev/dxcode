import {
  generateThreadTitle,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { listenForThreadHints } from "../../realtime/thread-hints.js";
import { pluginAgentClaudePlan } from "../../settings/model-routing/submission.js";
import { ownerRequest } from "../../threads/owner-request.js";
import { insertPluginAudit } from "../audit/audit.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { agentSelection, type PluginAgentDefinition } from "./definition.js";

/**
 * Starting a Thread that runs a plugin's agent, and waiting for its answer.
 * The Thread is an ordinary dx Thread: its creation goes through the same
 * route as the web client's, so model routing, workspace policy, the Claude
 * plan rules, Orb admission, and usage all apply as for any Thread. What
 * makes it the agent is its `plugin_agent_thread` row, written first, which
 * each submission reads with its plugins (`resolveAgentCodePlugins`).
 */

export interface PluginAgentThread {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly modeKey?: string;
  readonly definition: PluginAgentDefinition;
}

interface AgentRow {
  readonly plugin_id: string;
  readonly plugin_name: string;
  readonly plugin_version: string;
  readonly mode_key: string | null;
  readonly definition_json: string;
}

export const pluginAgentThreadOf = (
  row: AgentRow | undefined | null,
): PluginAgentThread | undefined => {
  if (row === undefined || row === null) return undefined;
  return {
    pluginId: row.plugin_id,
    pluginName: row.plugin_name,
    pluginVersion: row.plugin_version,
    ...(row.mode_key === null ? {} : { modeKey: row.mode_key }),
    definition: JSON.parse(row.definition_json) as PluginAgentDefinition,
  };
};

/**
 * Records that a Thread runs the agent, before the Thread exists, so its
 * first submission already runs as the agent. A retry keeps the first row.
 */
const insertAgentThread = (
  db: D1Database,
  row: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly install: PluginInstallRecord;
    readonly definition: PluginAgentDefinition;
    readonly modeKey?: string;
    readonly parentThreadId?: string;
  },
) =>
  db
    .prepare(
      `INSERT INTO plugin_agent_thread (
         thread_id, owner_user_id, plugin_id, plugin_name, plugin_display_name,
         plugin_version, agent_name, mode_key, parent_thread_id,
         definition_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id) DO NOTHING`,
    )
    .bind(
      row.threadId,
      row.ownerUserId,
      row.install.pluginId,
      row.install.name,
      row.install.displayName.slice(0, 96),
      row.install.version,
      row.definition.name,
      row.modeKey ?? null,
      row.parentThreadId ?? null,
      JSON.stringify(row.definition),
      new Date().toISOString(),
    )
    .run();

/** No installed plugin offers the mode to this person. */
export class PluginAgentModeNotOffered extends Error {
  override readonly name = "PluginAgentModeNotOffered";
}

/**
 * Whether a Thread may start an agent Thread. An agent Thread that another
 * Thread started (a subagent, or a mode Thread an agent started) starts no
 * more, so plugins and `create_thread` cannot chain agent Threads without
 * end: at most two agent Threads below a Thread a person started.
 */
const agentDepthRefusal = async (
  db: D1Database,
  ownerUserId: string,
  parentThreadId: string | undefined,
) => {
  if (parentThreadId === undefined) return undefined;
  const parent = await db
    .prepare(
      `SELECT parent_thread_id FROM plugin_agent_thread
        WHERE thread_id = ? AND owner_user_id = ?`,
    )
    .bind(parentThreadId, ownerUserId)
    .first<{ parent_thread_id: string | null }>();
  return parent !== null && parent.parent_thread_id !== null
    ? "This Thread is an agent's Thread another Thread started, so it cannot start another agent Thread."
    : undefined;
};

/**
 * A person starts a Thread in a plugin's agent mode (`pluginAgentMode` on
 * `POST /v1/threads`): the mode must be one the person's installed plugins
 * declare, register, and may run. Returns the Thread's selection: the
 * agent's model, or the one the person picked when the agent names none.
 */
export const bindPluginAgentMode = async (input: {
  readonly bindings: Bindings;
  readonly db: D1Database;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly agentMode: string;
  readonly selection: ThreadModelSelection | undefined;
  readonly parentThreadId?: string;
}): Promise<ThreadModelSelection | undefined> => {
  // A Thread ID someone else owns is never bound; a retry of this person's
  // own creation keeps the agent it was first bound to.
  const [existing, bound] = await input.db.batch([
    input.db
      .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
      .bind(input.threadId),
    input.db
      .prepare(
        "SELECT owner_user_id, definition_json FROM plugin_agent_thread WHERE thread_id = ?",
      )
      .bind(input.threadId),
  ]);
  const thread = existing?.results[0] as
    | { readonly owner_user_id: string }
    | undefined;
  const row = bound?.results[0] as
    | { readonly owner_user_id: string; readonly definition_json: string }
    | undefined;
  if (thread !== undefined && thread.owner_user_id !== input.ownerUserId)
    throw new PluginAgentModeNotOffered("That Thread ID is taken.");
  if (row !== undefined) {
    if (row.owner_user_id !== input.ownerUserId)
      throw new PluginAgentModeNotOffered("That Thread ID is taken.");
    return agentSelection(
      JSON.parse(row.definition_json) as PluginAgentDefinition,
      input.selection,
    );
  }
  const depth = await agentDepthRefusal(
    input.db,
    input.ownerUserId,
    input.parentThreadId,
  );
  if (depth !== undefined) throw new PluginAgentModeNotOffered(depth);
  const { listOwnerPluginAgentModes } = await import("./modes.js");
  const modes = await listOwnerPluginAgentModes(
    input.bindings,
    input.db,
    input.ownerUserId,
  );
  const mode = modes.find(({ agentMode }) => agentMode === input.agentMode);
  if (mode === undefined)
    throw new PluginAgentModeNotOffered(
      `No installed plugin offers the agent mode ${input.agentMode} to you.`,
    );
  await insertAgentThread(input.db, {
    threadId: input.threadId,
    ownerUserId: input.ownerUserId,
    install: mode.install,
    definition: mode.definition,
    modeKey: mode.key,
    ...(input.parentThreadId === undefined
      ? {}
      : { parentThreadId: input.parentThreadId }),
  });
  await insertPluginAudit(input.db, {
    pluginId: mode.install.pluginId,
    pluginName: mode.install.name,
    pluginVersion: mode.install.version,
    scope: mode.install.scope,
    ownerUserId: input.ownerUserId,
    action: "agent.mode.start",
    target: input.threadId,
    outcome: "success",
    detail: {
      agent: mode.definition.name,
      mode: mode.key,
      model: mode.definition.model ?? "inherited",
      startedBy: "person",
    },
  });
  return agentSelection(mode.definition, input.selection);
};

export interface StartAgentThreadInput {
  readonly bindings: Bindings;
  readonly db: D1Database;
  readonly install: PluginInstallRecord;
  readonly ownerUserId: string;
  /** The member whose click started the call, when not the owner. */
  readonly actorUserId?: string;
  readonly definition: PluginAgentDefinition;
  /** The declared mode it starts in; absent for `agent.run`. */
  readonly modeKey?: string;
  readonly prompt: string;
  readonly title?: string;
  /** The Thread that starts it; its child, in its Project. */
  readonly parent?: {
    readonly threadId: string;
    readonly projectId?: string;
    readonly selection: ThreadModelSelection | undefined;
  };
  /** Who the audit records it was started by, when not the plugin's code. */
  readonly startedBy: "plugin" | "agent" | "person";
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface StartedAgentThread {
  readonly threadId: string;
  readonly submissionId?: string;
  readonly selection?: ThreadModelSelection;
}

const failureText = (status: number, payload: unknown) => {
  // dx's routes answer `{ status: "error", data: { code, message } }`.
  const body = payload as
    | {
        readonly data?: { readonly code?: string; readonly message?: string };
        readonly error?: { readonly code?: string; readonly message?: string };
      }
    | undefined;
  const error = body?.data ?? body?.error;
  const code = error?.code ?? `HTTP_${status}`;
  return error?.message === undefined ? code : `${code}: ${error.message}`;
};

/**
 * Starts a Thread running the agent. Refused unless the install was granted
 * `permissions.agents`; the definition must already be validated against
 * the install (`pluginAgentDefinitionOf`).
 */
export const startAgentThread = async (
  input: StartAgentThreadInput,
): Promise<StartedAgentThread> => {
  const { bindings, db, install, definition } = input;
  const audit = (
    outcome: "success" | "rejected" | "failed",
    target: string | undefined,
    detail: Record<string, unknown>,
  ) =>
    insertPluginAudit(db, {
      ...(input.actorUserId === undefined
        ? {}
        : { actorUserId: input.actorUserId }),
      pluginId: install.pluginId,
      pluginName: install.name,
      pluginVersion: install.version,
      scope: install.scope,
      ownerUserId: input.ownerUserId,
      ...(input.parent === undefined
        ? {}
        : { threadId: input.parent.threadId }),
      action: input.modeKey === undefined ? "agent.run" : "agent.mode.start",
      ...(target === undefined ? {} : { target }),
      outcome,
      detail: {
        agent: definition.name,
        ...(input.modeKey === undefined ? {} : { mode: input.modeKey }),
        model: definition.model ?? "inherited",
        ...(definition.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: definition.reasoningEffort }),
        startedBy: input.startedBy,
        ...detail,
      },
    });
  if (install.code.permissions.agents !== true) {
    await audit("rejected", undefined, { reason: "not granted agents" });
    throw new Error(
      `${install.name} was not granted running agents (permissions.agents).`,
    );
  }
  if (install.scope === "repository") {
    await audit("rejected", undefined, { reason: "repository plugin" });
    throw new Error(
      "A repository's own plugin cannot start agent Threads; install the plugin to use its agents.",
    );
  }
  const depth = await agentDepthRefusal(
    db,
    input.ownerUserId,
    input.parent?.threadId,
  );
  if (depth !== undefined) {
    await audit("rejected", undefined, { reason: "nested agent Thread" });
    throw new Error(depth);
  }
  const selection = agentSelection(definition, input.parent?.selection);
  // A Claude Code agent with several plans to run on takes the one with the
  // most room that resets soonest; nobody is there to pick.
  let claudeConnectionId: string | undefined;
  try {
    claudeConnectionId = await pluginAgentClaudePlan(
      bindings,
      input.ownerUserId as UserId,
      selection,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await audit("failed", undefined, { reason: reason.slice(0, 300) });
    throw new Error(`dx could not start the agent's Thread (${reason}).`);
  }
  const threadId = `thr_${crypto.randomUUID()}`;
  await insertAgentThread(db, {
    threadId,
    ownerUserId: input.ownerUserId,
    install,
    definition,
    ...(input.modeKey === undefined ? {} : { modeKey: input.modeKey }),
    ...(input.parent === undefined
      ? {}
      : { parentThreadId: input.parent.threadId }),
  });
  const { response, payload } = await ownerRequest(
    {
      bindings,
      ownerUserId: input.ownerUserId as UserId,
      ...(input.parent === undefined
        ? {}
        : { sourceThreadId: input.parent.threadId }),
      ...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
    },
    "POST",
    "/v1/threads",
    {
      threadId,
      ...(input.parent === undefined
        ? {}
        : { parentThreadId: input.parent.threadId }),
      ...(input.parent?.projectId === undefined
        ? {}
        : { projectId: input.parent.projectId }),
      // A Thread title is at most 80 characters; a longer one would refuse
      // the whole request.
      ...(input.title === undefined
        ? {}
        : { title: generateThreadTitle(input.title), generateTitle: false }),
      ...(selection === undefined ? {} : { selection }),
      ...(claudeConnectionId === undefined ? {} : { claudeConnectionId }),
      initialMessage: { body: input.prompt, attachments: [] },
    },
  );
  const created = payload?.data as { readonly id?: string } | undefined;
  // The row stays when creation fails: should the route have kept the
  // Thread after all, it still runs as the agent; an unused row reaches
  // nothing, since only the Thread's owner's Thread reads it.
  if (!response.ok || created?.id !== threadId) {
    const reason = failureText(response.status, payload);
    await audit("failed", undefined, { reason: reason.slice(0, 300) });
    throw new Error(`dx could not start the agent's Thread (${reason}).`);
  }
  await audit("success", threadId, {
    ...(selection === undefined ? {} : { selection }),
    ...(claudeConnectionId === undefined
      ? {}
      : { claudePlan: claudeConnectionId }),
  });
  const submission = payload?.initialSubmission as
    | { readonly submissionId?: string }
    | undefined;
  return {
    threadId,
    ...(submission?.submissionId === undefined
      ? {}
      : { submissionId: submission.submissionId }),
    ...(selection === undefined ? {} : { selection }),
  };
};

/** The longest an agent's answer is waited for. */
export const AGENT_RUN_MAX_MS = 30 * 60_000;
export const AGENT_RUN_DEFAULT_MS = 10 * 60_000;
const POLL_MS = 2_000;
const HINT_RECHECK_MS = 10_000;

const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

interface TurnRow {
  readonly lifecycle_state: string;
  readonly state: string | null;
  readonly turn_failed: number | null;
  /** `failed` when the first message was never admitted. */
  readonly dispatch_state: string | null;
}

/** The latest assistant text, read as the web client reads history. */
const lastAnswer = async (
  bindings: Bindings,
  ownerUserId: string,
  threadId: string,
) => {
  const { response, payload } = await ownerRequest(
    { bindings, ownerUserId: ownerUserId as UserId },
    "GET",
    `/v1/agents/dx/${encodeURIComponent(threadId)}?view=history&promptLimit=1`,
  );
  if (!response.ok) return "";
  const messages = (payload?.messages ?? []) as ReadonlyArray<{
    readonly role?: string;
    readonly purpose?: string;
    readonly parts?: ReadonlyArray<{ readonly type?: string; text?: string }>;
  }>;
  const message = messages.findLast(
    ({ role, purpose }) => role === "assistant" && purpose === "assistant",
  );
  return (message?.parts ?? [])
    .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
    .join("\n")
    .trim();
};

/**
 * Waits until the agent's first submission settles and returns its answer.
 * A realtime hint wakes the wait; D1 decides, and is read every 10 seconds
 * anyway, or every 2 seconds without the hub. One indexed read per wake.
 */
export const waitForAgentAnswer = async (input: {
  readonly bindings: Bindings;
  readonly db: D1Database;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly submissionId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  const read = () =>
    input.db
      .prepare(
        `SELECT thread.lifecycle_state, thread.turn_failed, submission.state,
                dispatch.state AS dispatch_state
           FROM threads thread
           LEFT JOIN thread_activity_submission submission
             ON submission.thread_id = thread.id AND submission.submission_id = ?2
           LEFT JOIN thread_initial_dispatch dispatch
             ON dispatch.thread_id = thread.id
          WHERE thread.id = ?1 AND thread.owner_user_id = ?3`,
      )
      .bind(input.threadId, input.submissionId, input.ownerUserId)
      .first<TurnRow>();
  const settled = (row: TurnRow | null) =>
    row === null ||
    row.lifecycle_state !== "active" ||
    row.state === "settled" ||
    row.dispatch_state === "failed";
  const deadline = Date.now() + input.timeoutMs;
  let row = await read();
  const hints = settled(row)
    ? undefined
    : await listenForThreadHints(input.bindings, input.ownerUserId as UserId, [
        input.threadId,
      ]);
  let listening = hints !== undefined;
  try {
    if (hints !== undefined) row = await read();
    while (!settled(row)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (listening && hints !== undefined) {
        const wake = await hints.next(
          Math.min(remaining, HINT_RECHECK_MS),
          input.signal,
        );
        if (wake === "closed") listening = false;
      } else await pause(Math.min(remaining, POLL_MS), input.signal);
      row = await read();
    }
  } finally {
    hints?.close();
  }
  if (row === null) throw new Error("The agent's Thread is gone.");
  if (row.lifecycle_state !== "active")
    throw new Error("The agent's Thread was archived before it answered.");
  if (row.dispatch_state === "failed" && row.state !== "settled")
    throw new Error(
      `dx could not deliver the agent's first message; open its Thread ${input.threadId} to see why.`,
    );
  if (row.state !== "settled")
    throw new Error(
      `The agent did not answer within ${Math.round(input.timeoutMs / 1000)} seconds; its Thread ${input.threadId} keeps running.`,
    );
  const text = await lastAnswer(
    input.bindings,
    input.ownerUserId,
    input.threadId,
  );
  if (row.turn_failed === 1 && text === "")
    throw new Error(
      `The agent's turn failed; open its Thread ${input.threadId} to see why.`,
    );
  return text;
};

/** What a Thread's detail shows of its plugin agent, batched with its reads. */
export const threadPluginAgentStatement = (db: D1Database, threadId: string) =>
  db
    .prepare(
      `SELECT agent.plugin_display_name, agent.mode_key, agent.definition_json
         FROM plugin_agent_thread agent
         JOIN threads thread
           ON thread.id = agent.thread_id
          AND thread.owner_user_id = agent.owner_user_id
        WHERE agent.thread_id = ?`,
    )
    .bind(threadId);

export const threadPluginAgentData = (
  row:
    | {
        readonly plugin_display_name: string;
        readonly mode_key: string | null;
        readonly definition_json: string;
      }
    | undefined,
) => {
  if (row === undefined) return undefined;
  const definition = JSON.parse(row.definition_json) as PluginAgentDefinition;
  return {
    name: definition.name,
    label: definition.display?.label ?? definition.name,
    ...(definition.display?.color === undefined
      ? {}
      : { color: definition.display.color }),
    plugin: row.plugin_display_name,
    ...(row.mode_key === null ? {} : { mode: row.mode_key }),
    ...(definition.model === undefined ? {} : { model: definition.model }),
  };
};
