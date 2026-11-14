import {
  PLUGIN_NOTICE_SECONDS,
  PLUGIN_PROMPT_DEFAULT_SECONDS,
  PLUGIN_PROMPT_MAX_SECONDS,
  PLUGIN_PROMPT_PENDING_LIMIT,
  PLUGIN_QUICK_ACTION_LIMIT,
  PluginNotice,
  PluginPrompt,
  PluginQuickAction,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { publishRealtimeInvalidation } from "../../realtime/publication.js";

/**
 * The rows behind plugin UI in a Thread (migration 0167): prompts a
 * plugin's call waits on, toasts, and quick actions. Plugin code writes
 * them through the plugin host; the Thread page reads and answers them
 * through `routes.ts`. Every change tells the Thread's viewers to refetch.
 */

export type PromptKind = "confirm" | "input" | "select";

/** dx's own prompts (`manage_dx`): a settings change, or a secret request. */
export type DxPromptKind = "change" | "secret";

/** What the plugin asked, as stored: the prompt without its row fields. */
export type PromptSpec = PluginPrompt extends infer P
  ? P extends PluginPrompt
    ? Omit<P, "id" | "plugin" | "kind" | "createdAt" | "expiresAt">
    : never
  : never;

export const invalidatePluginUi = (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: string,
) =>
  publishRealtimeInvalidation(
    bindings,
    threadId as ThreadId,
    "plugin-ui.invalidated",
  );

export const promptSeconds = (timeoutSeconds: unknown) =>
  typeof timeoutSeconds === "number" &&
  Number.isFinite(timeoutSeconds) &&
  timeoutSeconds > 0
    ? Math.min(Math.ceil(timeoutSeconds), PLUGIN_PROMPT_MAX_SECONDS)
    : PLUGIN_PROMPT_DEFAULT_SECONDS;

export class PluginUiLimit extends Error {
  override readonly name = "PluginUiLimit";
}

/** Adds a prompt; refuses one past the Thread's pending limit. */
export const insertPrompt = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    /** Null for dx's own prompts. */
    readonly pluginId: string | null;
    readonly pluginName: string;
    readonly kind: PromptKind | DxPromptKind;
    readonly spec: PromptSpec;
    readonly ownerOnly: boolean;
    readonly seconds: number;
    /** dx's own prompts: what applying it runs; never sent to the page. */
    readonly plan?: unknown;
  },
) => {
  const id = `pui_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date();
  await prune(db, input.threadId, now).run();
  const result = await db
    .prepare(
      `INSERT INTO plugin_ui_prompt
         (id, thread_id, plugin_id, plugin_name, kind, spec_json, owner_only,
          status, created_at, expires_at, plan_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?11
        WHERE (SELECT count(*) FROM plugin_ui_prompt
                WHERE thread_id = ?2 AND status = 'pending'
                  AND expires_at > ?8) < ?10`,
    )
    .bind(
      id,
      input.threadId,
      input.pluginId,
      input.pluginName.slice(0, 96),
      input.kind,
      JSON.stringify(input.spec),
      input.ownerOnly ? 1 : 0,
      now.toISOString(),
      new Date(now.getTime() + input.seconds * 1_000).toISOString(),
      PLUGIN_PROMPT_PENDING_LIMIT,
      input.plan === undefined ? null : JSON.stringify(input.plan),
    )
    .run();
  if (result.meta.changes === 0)
    throw new PluginUiLimit(
      `At most ${PLUGIN_PROMPT_PENDING_LIMIT} questions wait in a Thread at once.`,
    );
  return id;
};

export type PromptState =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: unknown }
  | { readonly status: "gone" };

/**
 * The prompt's state for the waiting call. An answered row hands its answer
 * over once: the answer is cleared, so a secret is never kept.
 */
export const takePromptAnswer = async (
  db: D1Database,
  id: string,
): Promise<PromptState> => {
  const row = await db
    .prepare(`SELECT status, answer_json FROM plugin_ui_prompt WHERE id = ?`)
    .bind(id)
    .first<{ status: string; answer_json: string | null }>();
  // A dx change being applied is still on its way to an answer.
  if (row?.status === "pending" || row?.status === "applying")
    return { status: "pending" };
  if (row?.status !== "answered" || row.answer_json === null)
    return { status: "gone" };
  // Only the call that clears the answer takes it.
  const cleared = await db
    .prepare(
      `UPDATE plugin_ui_prompt SET answer_json = NULL
        WHERE id = ? AND answer_json IS NOT NULL`,
    )
    .bind(id)
    .run();
  if (cleared.meta.changes === 0) return { status: "gone" };
  return {
    status: "answered",
    answer: JSON.parse(row.answer_json) as unknown,
  };
};

/**
 * Ends a prompt its call no longer waits on: it timed out, or the call
 * ended. An answer the call never took is cleared, so a secret is not kept.
 * True when it was still pending.
 */
export const expirePrompt = async (db: D1Database, id: string) => {
  const [expired] = await db.batch([
    db
      .prepare(
        `UPDATE plugin_ui_prompt SET status = 'expired', answered_at = ?2,
                plan_json = NULL
          WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(id, new Date().toISOString()),
    db
      .prepare(
        `UPDATE plugin_ui_prompt SET answer_json = NULL
          WHERE id = ? AND answer_json IS NOT NULL AND status != 'applying'`,
      )
      .bind(id),
  ]);
  return (expired?.meta.changes ?? 0) > 0;
};

/**
 * Drops the Thread's settled rows more than a day old, and clears any
 * answer left past its prompt's expiry. Runs as plugins add rows.
 */
const prune = (db: D1Database, threadId: string, now: Date) =>
  db
    .prepare(
      `DELETE FROM plugin_ui_prompt
        WHERE thread_id = ?1 AND status != 'pending' AND expires_at < ?2`,
    )
    .bind(threadId, new Date(now.getTime() - 86_400_000).toISOString());

/**
 * Records a person's answer to a pending, unexpired prompt. `ownerOnly`
 * prompts take only the owner's answer.
 */
export const answerPrompt = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly promptId: string;
    readonly userId: string;
    readonly isOwner: boolean;
    readonly answer: unknown;
  },
): Promise<"answered" | "not-found" | "owner-only" | PendingDxPrompt> => {
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT owner_only, kind, plugin_id, spec_json, plan_json FROM plugin_ui_prompt
        WHERE id = ? AND thread_id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(input.promptId, input.threadId, now)
    .first<{
      owner_only: number;
      kind: string;
      plugin_id: string | null;
      spec_json: string;
      plan_json: string | null;
    }>();
  if (row === null) return "not-found";
  if (row.owner_only === 1 && !input.isOwner) return "owner-only";
  // dx's own prompts are answered by running them: the caller settles it.
  if (
    row.plugin_id === null &&
    (row.kind === "change" || row.kind === "secret")
  )
    return {
      kind: row.kind,
      spec: JSON.parse(row.spec_json) as unknown,
      plan:
        row.plan_json === null ? null : (JSON.parse(row.plan_json) as unknown),
    };
  const result = await db
    .prepare(
      `UPDATE plugin_ui_prompt
          SET status = 'answered', answer_json = ?3, answered_by_user_id = ?4,
              answered_at = ?5
        WHERE id = ?1 AND thread_id = ?2 AND status = 'pending'`,
    )
    .bind(
      input.promptId,
      input.threadId,
      JSON.stringify(input.answer ?? null),
      input.userId,
      now,
    )
    .run();
  return result.meta.changes > 0 ? "answered" : "not-found";
};

/** A pending dx prompt a person answered, for the caller to run. */
export interface PendingDxPrompt {
  readonly kind: DxPromptKind;
  readonly spec: unknown;
  readonly plan: unknown;
}

/**
 * Takes a pending dx prompt for applying: only one answer runs it. False
 * when it was answered, expired, or taken meanwhile.
 */
export const claimDxPrompt = async (
  db: D1Database,
  input: { readonly threadId: string; readonly promptId: string },
) => {
  const result = await db
    .prepare(
      `UPDATE plugin_ui_prompt SET status = 'applying'
        WHERE id = ?1 AND thread_id = ?2 AND status = 'pending'
          AND kind IN ('change', 'secret') AND expires_at > ?3`,
    )
    .bind(input.promptId, input.threadId, new Date().toISOString())
    .run();
  return result.meta.changes > 0;
};

/**
 * Records how a dx prompt ended, for the waiting tool call: its plan is
 * dropped, and the outcome never holds a secret's value.
 */
export const settleDxPrompt = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly promptId: string;
    readonly userId: string;
    readonly outcome: unknown;
    /**
     * `pending` for a cancel, which loses to an apply already running;
     * `applying` for the apply that claimed it.
     */
    readonly from: "pending" | "applying";
  },
) => {
  const result = await db
    .prepare(
      `UPDATE plugin_ui_prompt
          SET status = 'answered', answer_json = ?3, answered_by_user_id = ?4,
              answered_at = ?5, plan_json = NULL
        WHERE id = ?1 AND thread_id = ?2 AND status = ?6`,
    )
    .bind(
      input.promptId,
      input.threadId,
      JSON.stringify(input.outcome ?? null),
      input.userId,
      new Date().toISOString(),
      input.from,
    )
    .run();
  return result.meta.changes > 0;
};

export const insertNotice = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly pluginName: string;
    readonly message: string;
    readonly level: PluginNotice["level"];
  },
) => {
  const now = new Date();
  await prune(db, input.threadId, now).run();
  await db
    .prepare(
      `INSERT INTO plugin_ui_prompt
         (id, thread_id, plugin_id, plugin_name, kind, spec_json, status,
          created_at, expires_at)
       VALUES (?, ?, ?, ?, 'notify', ?, 'shown', ?, ?)`,
    )
    .bind(
      `pui_${crypto.randomUUID().replaceAll("-", "")}`,
      input.threadId,
      input.pluginId,
      input.pluginName.slice(0, 96),
      JSON.stringify({ message: input.message, level: input.level }),
      now.toISOString(),
      new Date(now.getTime() + PLUGIN_NOTICE_SECONDS * 1_000).toISOString(),
    )
    .run();
};

/** Counts a plugin's recent notices in a Thread, for its rate limit. */
export const recentNoticeCount = async (
  db: D1Database,
  threadId: string,
  pluginId: string,
) => {
  const row = await db
    .prepare(
      `SELECT count(*) AS count FROM plugin_ui_prompt
        WHERE thread_id = ? AND plugin_id = ? AND kind = 'notify'
          AND created_at > ?`,
    )
    .bind(threadId, pluginId, new Date(Date.now() - 60_000).toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const decodePrompt = Schema.decodeUnknownOption(PluginPrompt);
const decodeNotice = Schema.decodeUnknownOption(PluginNotice);
const decodeQuickAction = Schema.decodeUnknownOption(PluginQuickAction);

interface PromptRow {
  readonly id: string;
  readonly plugin_id: string;
  readonly plugin_name: string;
  readonly kind: string;
  readonly spec_json: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/**
 * The Thread's waiting prompts and recent notices, oldest first, each with
 * its plugin's manifest name when the install still runs.
 */
export const listThreadPrompts = async (
  db: D1Database,
  threadId: string,
  /** Each running install's plugin name, by install id, as quick actions take it. */
  pluginsPromise: Promise<ReadonlyMap<string, string>>,
) => {
  const rowsPromise = db
    .prepare(
      `SELECT id, plugin_id, plugin_name, kind, spec_json, created_at, expires_at
         FROM plugin_ui_prompt
        WHERE thread_id = ?1 AND expires_at > ?2 AND status = 'pending'
        UNION ALL
       SELECT * FROM (
         SELECT id, plugin_id, plugin_name, kind, spec_json, created_at, expires_at
           FROM plugin_ui_prompt
          WHERE thread_id = ?1 AND expires_at > ?2 AND status = 'shown'
          ORDER BY created_at DESC, id DESC
          LIMIT 20)
        ORDER BY created_at, id`,
    )
    .bind(threadId, new Date().toISOString())
    .all<PromptRow>();
  const [rows, plugins] = await Promise.all([rowsPromise, pluginsPromise]);
  const prompts: PluginPrompt[] = [];
  const notices: PluginNotice[] = [];
  for (const row of rows.results) {
    const { pluginName: _ignored, ...spec } = JSON.parse(
      row.spec_json,
    ) as Record<string, unknown>;
    const pluginName = plugins.get(row.plugin_id);
    const named = pluginName === undefined ? {} : { pluginName };
    if (row.kind === "notify") {
      const notice = decodeNotice({
        ...spec,
        ...named,
        id: row.id,
        plugin: row.plugin_name,
        createdAt: row.created_at,
      });
      if (Option.isSome(notice)) notices.push(notice.value);
      continue;
    }
    const prompt = decodePrompt({
      ...spec,
      ...named,
      id: row.id,
      plugin: row.plugin_name,
      kind: row.kind,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
    if (Option.isSome(prompt)) prompts.push(prompt.value);
  }
  return { prompts, notices };
};

export const insertQuickAction = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly pluginName: string;
    readonly label: string;
    readonly action: PluginQuickAction["action"];
    readonly args: PluginQuickAction["args"];
  },
) => {
  const id = `pqa_${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await db
    .prepare(
      `INSERT INTO plugin_quick_action
         (id, thread_id, plugin_id, plugin_name, label, action, args_json,
          created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE (SELECT count(*) FROM plugin_quick_action action
                 JOIN trusted_plugin plugin ON plugin.id = action.plugin_id
                WHERE action.thread_id = ?2 AND plugin.enabled = 1
                  AND plugin.removed_at IS NULL) < ?9`,
    )
    .bind(
      id,
      input.threadId,
      input.pluginId,
      input.pluginName.slice(0, 96),
      input.label,
      input.action,
      JSON.stringify(input.args),
      new Date().toISOString(),
      PLUGIN_QUICK_ACTION_LIMIT,
    )
    .run();
  if (result.meta.changes === 0)
    throw new PluginUiLimit(
      `A Thread shows at most ${PLUGIN_QUICK_ACTION_LIMIT} plugin quick actions. Remove one first.`,
    );
  return id;
};

/** Removes one of the plugin's own quick actions in the Thread. */
export const deleteQuickAction = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly id: string;
  },
) => {
  const result = await db
    .prepare(
      `DELETE FROM plugin_quick_action
        WHERE id = ? AND thread_id = ? AND plugin_id = ?`,
    )
    .bind(input.id, input.threadId, input.pluginId)
    .run();
  return result.meta.changes > 0;
};

/**
 * A run-command action names its install, as the run request needs; an
 * open-pane action names its pane's tab key, `<plugin name>/<pane id>`.
 */
const withOwner = (args: unknown, pluginId: string, pluginName: string) => {
  if (typeof args !== "object" || args === null) return args;
  const { command, pane } = args as { command?: unknown; pane?: unknown };
  if (typeof command === "string")
    return { ...args, command: `${pluginId}:${command}` };
  if (typeof pane === "string")
    return { ...args, pane: `${pluginName}/${pane}` };
  return args;
};

/**
 * The Thread's quick actions, from installs that still run in it: a plugin
 * removed or disabled since leaves no buttons behind.
 */
export const listThreadQuickActions = async (
  db: D1Database,
  threadId: string,
  /**
   * Each running install's plugin name, by install id. A promise, so the
   * read starts while the Thread's plugins are still being resolved.
   */
  pluginsPromise: Promise<ReadonlyMap<string, string>>,
) => {
  const rowsPromise = db
    .prepare(
      `SELECT id, plugin_id, plugin_name, label, action, args_json
         FROM plugin_quick_action
        WHERE thread_id = ?
        ORDER BY created_at, id`,
    )
    .bind(threadId)
    .all<{
      id: string;
      plugin_id: string;
      plugin_name: string;
      label: string;
      action: string;
      args_json: string;
    }>();
  const [rows, plugins] = await Promise.all([rowsPromise, pluginsPromise]);
  if (plugins.size === 0) return [];
  const actions: PluginQuickAction[] = [];
  for (const row of rows.results) {
    const pluginName = plugins.get(row.plugin_id);
    if (pluginName === undefined) continue;
    const action = decodeQuickAction({
      id: row.id,
      plugin: row.plugin_name,
      pluginName,
      label: row.label,
      action: row.action,
      args: withOwner(
        JSON.parse(row.args_json) as unknown,
        row.plugin_id,
        pluginName,
      ),
    });
    if (Option.isSome(action)) actions.push(action.value);
  }
  return actions;
};
