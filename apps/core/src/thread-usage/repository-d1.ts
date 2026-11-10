import {
  THREAD_ORB_SESSION_PAGE,
  THREAD_USAGE_REQUEST_PAGE,
  type ThreadContextWindow,
  type ThreadOrbBilling,
  type ThreadOrbSession,
  type ThreadUsageData,
  type ThreadUsageModel,
  type ThreadUsageRequest,
  type ThreadUsageRoute,
  type ThreadUsageRouteKind,
} from "@dx/api";
import {
  DEV_WORKERS_AI_CONNECTION_ID,
  devWorkersAiConnection,
} from "../runtime/model-routing-dev-defaults.js";
import { usageModelName } from "../settings/usage/display-names.js";
import { backfillChunk, backfillRollups } from "../settings/usage/rollup-d1.js";
import { orbSizeResources } from "./orb-sessions.js";

/**
 * A Thread's Cost & Usage from D1 (migration 0161). The summary is one
 * batch of primary-key reads: the Thread's rows of usage_thread_model with
 * their connections, thread_orb_usage, thread_context_window, and the
 * Thread's model selection. Only while the rollup backfill runs does it sum
 * the Thread's raw model events instead, through usage_event_thread_model_idx.
 * Requests and Orb sessions are read a bounded page at a time.
 */

const CLAUDE_CODE_PROVIDER = "claude-code";

/**
 * Connections the runtime composes without a model_connection row: the
 * deployment's own Workers AI binding in dev and preview stages.
 */
const SYNTHETIC_CONNECTIONS: Readonly<
  Record<string, { readonly name: string; readonly kind: ThreadUsageRouteKind }>
> = {
  [DEV_WORKERS_AI_CONNECTION_ID]: {
    name: devWorkersAiConnection(new Date(0).toISOString() as never).name,
    kind: "deployment",
  },
};

interface ModelRow {
  readonly connection_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly requests: number;
  readonly compactions: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly estimated_cost_micros: number;
  readonly known_cost_events: number;
  readonly connection_name: string | null;
  readonly connection_kind: string | null;
  readonly connection_provider: string | null;
  readonly connection_scope: "personal" | "workspace" | null;
  readonly owner_name: string | null;
}

const connectionColumns = `
  connection.name AS connection_name,
  connection.kind AS connection_kind,
  connection.provider_id AS connection_provider,
  connection.scope AS connection_scope,
  CASE connection.scope
    WHEN 'workspace' THEN
      (SELECT name FROM organization WHERE id = connection.target_id)
    WHEN 'personal' THEN
      (SELECT name FROM "user" WHERE id = connection.target_id)
  END AS owner_name`;

const rolledUp = `
  SELECT model.*, ${connectionColumns}
  FROM usage_thread_model AS model
  LEFT JOIN model_connection AS connection
    ON connection.id = model.connection_id
  WHERE model.thread_id = ?1`;

// The same rows from the Thread's raw model events, while the backfill runs.
const raw = `
  SELECT model.*, ${connectionColumns}
  FROM (
    SELECT connection_id,
      observed_provider_id AS provider_id,
      observed_model_id AS model_id,
      COUNT(*) AS requests,
      SUM(turn_purpose = 'compaction' AND outcome = 'success') AS compactions,
      SUM(COALESCE(input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
      SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
      SUM(COALESCE(estimated_cost_micros_snapshot, 0)) AS estimated_cost_micros,
      SUM(estimated_cost_micros_snapshot IS NOT NULL) AS known_cost_events
    FROM usage_event
    WHERE kind = 'model' AND thread_id = ?1
    GROUP BY connection_id, observed_provider_id, observed_model_id
  ) AS model
  LEFT JOIN model_connection AS connection
    ON connection.id = model.connection_id`;

const routeKind = (row: ModelRow): ThreadUsageRouteKind => {
  if (
    row.provider_id === CLAUDE_CODE_PROVIDER ||
    row.connection_provider === CLAUDE_CODE_PROVIDER
  )
    return "claude-code";
  const synthetic = SYNTHETIC_CONNECTIONS[row.connection_id];
  if (row.connection_kind === null && synthetic !== undefined)
    return synthetic.kind;
  switch (row.connection_kind) {
    case "deployment":
    case "custom":
    case "provider":
    case "subscription":
      return row.connection_kind;
    default:
      return "unknown";
  }
};

const routeName = (row: ModelRow) =>
  row.connection_name ??
  SYNTHETIC_CONNECTIONS[row.connection_id]?.name ??
  (row.connection_id === "unresolved" ? "Unknown route" : "Removed connection");

interface OrbUsageRow {
  readonly sessions: number;
  readonly runtime_ms: number;
  readonly cost_micros: number;
  readonly credits_micros: number;
  readonly provider: string;
  readonly runner_profile_id: string;
  readonly billing: ThreadOrbBilling;
}

interface ContextRow {
  readonly provider_id: string;
  readonly model_id: string;
  readonly context_window: number | null;
  readonly system_prompt_tokens: number;
  readonly builtin_tool_tokens: number;
  readonly mcp_servers: string;
  readonly message_tokens: number;
  readonly measured_at: string;
}

interface ThreadRow {
  readonly model_selection: string;
  readonly lifecycle_state: string;
}

const isClaudeCodeSelection = (selection: string) => {
  try {
    const parsed = JSON.parse(selection) as { kind?: unknown; model?: unknown };
    return (
      parsed.kind === "model" &&
      typeof parsed.model === "string" &&
      parsed.model.startsWith(`${CLAUDE_CODE_PROVIDER}/`)
    );
  } catch {
    return false;
  }
};

const summarize = (
  rows: ReadonlyArray<ModelRow>,
  orbRow: OrbUsageRow | undefined,
  contextRow: ContextRow | undefined,
  thread: ThreadRow | undefined,
  catalog: string | undefined,
): ThreadUsageData => {
  const routes = new Map<string, ThreadUsageRoute>();
  const models = new Map<string, ThreadUsageModel>();
  let dxModelMicros = 0;
  let byok = 0;
  let list = 0;
  let compactions = 0;
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let requests = 0;
  for (const row of rows) {
    if (row.requests <= 0) continue;
    const kind = routeKind(row);
    const dxCost = kind === "deployment" ? row.estimated_cost_micros : 0;
    dxModelMicros += dxCost;
    if (kind !== "deployment") byok += row.estimated_cost_micros;
    list += row.estimated_cost_micros;
    compactions += row.compactions;
    requests += row.requests;
    tokens.input += row.input_tokens;
    tokens.cacheRead += row.cache_read_tokens;
    tokens.cacheWrite += row.cache_write_tokens;
    tokens.output += row.output_tokens;
    const route = routes.get(row.connection_id);
    routes.set(row.connection_id, {
      connectionId: row.connection_id,
      name: routeName(row),
      kind,
      scope: row.connection_scope,
      ownerName: row.owner_name,
      requests: (route?.requests ?? 0) + row.requests,
      listPriceMicros:
        (route?.listPriceMicros ?? 0) + row.estimated_cost_micros,
    });
    const key = `${row.provider_id}/${row.model_id}`;
    const model = models.get(key);
    models.set(key, {
      providerId: row.provider_id,
      modelId: row.model_id,
      modelName: usageModelName(row.provider_id, row.model_id),
      requests: (model?.requests ?? 0) + row.requests,
      inputTokens: (model?.inputTokens ?? 0) + row.input_tokens,
      cacheReadTokens: (model?.cacheReadTokens ?? 0) + row.cache_read_tokens,
      cacheWriteTokens: (model?.cacheWriteTokens ?? 0) + row.cache_write_tokens,
      outputTokens: (model?.outputTokens ?? 0) + row.output_tokens,
      dxCostMicros: (model?.dxCostMicros ?? 0) + dxCost,
      listPriceMicros:
        (model?.listPriceMicros ?? 0) + row.estimated_cost_micros,
      unpricedRequests:
        (model?.unpricedRequests ?? 0) +
        Math.max(0, row.requests - row.known_cost_events),
    });
  }
  const claudeCode =
    thread !== undefined && isClaudeCodeSelection(thread.model_selection);
  const resources =
    orbRow === undefined
      ? undefined
      : orbSizeResources(catalog, orbRow.runner_profile_id);
  const orbDxMicros =
    orbRow !== undefined &&
    (orbRow.billing === "credits" || orbRow.billing === "deployment")
      ? orbRow.cost_micros
      : 0;
  const context: ThreadContextWindow = claudeCode
    ? { available: false, reason: "claude-code" }
    : thread !== undefined && thread.lifecycle_state !== "active"
      ? { available: false, reason: "archived" }
      : contextRow === undefined
        ? { available: false, reason: "not-loaded" }
        : (() => {
            const mcpServers = (
              JSON.parse(contextRow.mcp_servers) as Array<{
                server: string;
                tokens: number;
              }>
            ).slice(0, 64);
            return {
              available: true as const,
              providerId: contextRow.provider_id,
              modelId: contextRow.model_id,
              modelName: usageModelName(
                contextRow.provider_id,
                contextRow.model_id,
              ),
              usedTokens:
                contextRow.system_prompt_tokens +
                contextRow.builtin_tool_tokens +
                mcpServers.reduce((sum, server) => sum + server.tokens, 0) +
                contextRow.message_tokens,
              maxTokens: contextRow.context_window,
              compactions,
              systemPromptTokens: contextRow.system_prompt_tokens,
              builtinToolTokens: contextRow.builtin_tool_tokens,
              mcpServers,
              messageTokens: contextRow.message_tokens,
              measuredAt: contextRow.measured_at,
            };
          })();
  return {
    claudeCode,
    totalMicros: dxModelMicros + orbDxMicros,
    byokListPriceMicros: byok,
    creditsMicros: orbRow?.credits_micros ?? 0,
    listPriceMicros: list,
    tokens,
    requests,
    routes: [...routes.values()]
      .sort(
        (a, b) =>
          b.listPriceMicros - a.listPriceMicros || b.requests - a.requests,
      )
      .slice(0, 64),
    models: [...models.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 64),
    orb:
      orbRow === undefined || orbRow.sessions <= 0
        ? null
        : {
            sessions: orbRow.sessions,
            runtimeMs: orbRow.runtime_ms,
            costMicros: orbRow.cost_micros,
            creditsMicros: orbRow.credits_micros,
            billing: orbRow.billing,
            providerId: orbRow.provider,
            runnerProfileId: orbRow.runner_profile_id,
            cpuCores: resources?.cpuCores ?? null,
            memoryMb: resources?.memoryMb ?? null,
          },
    context,
  };
};

/**
 * The Thread's Cost & Usage summary: one D1 round trip once the rollup
 * backfill is done (two while it runs).
 */
export const readThreadUsage = async (
  db: D1Database,
  threadId: string,
  catalog: string | undefined,
): Promise<ThreadUsageData> => {
  const [ready, models, orb, context, thread] = await db.batch([
    db.prepare(
      "SELECT through_rowid >= end_rowid AS ready FROM usage_thread_rollup_backfill",
    ),
    db.prepare(rolledUp).bind(threadId),
    db
      .prepare(
        `SELECT sessions, runtime_ms, cost_micros, credits_micros, provider,
           runner_profile_id, billing
         FROM thread_orb_usage WHERE thread_id = ?`,
      )
      .bind(threadId),
    db
      .prepare("SELECT * FROM thread_context_window WHERE thread_id = ?")
      .bind(threadId),
    db
      .prepare(
        "SELECT model_selection, lifecycle_state FROM threads WHERE id = ?",
      )
      .bind(threadId),
  ]);
  const backfilled =
    (ready?.results[0] as { ready?: number } | undefined)?.ready === 1;
  const rows = backfilled
    ? ((models?.results ?? []) as ModelRow[])
    : (await db.prepare(raw).bind(threadId).all<ModelRow>()).results;
  return summarize(
    rows,
    orb?.results[0] as OrbUsageRow | undefined,
    context?.results[0] as ContextRow | undefined,
    thread?.results[0] as ThreadRow | undefined,
    catalog,
  );
};

interface RequestRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly turn_purpose: ThreadUsageRequest["purpose"];
  readonly outcome: ThreadUsageRequest["outcome"];
  readonly input_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly output_tokens: number | null;
  readonly estimated_cost_micros_snapshot: number | null;
  readonly connection_id: string;
  readonly connection_name: string | null;
  readonly connection_kind: string | null;
  readonly connection_provider: string | null;
}

const CURSOR_SEPARATOR = "|";

/**
 * One page of the Thread's requests to one model, newest first: at most
 * `THREAD_USAGE_REQUEST_PAGE` rows (one more to know whether a page
 * follows), read in index order from usage_event_thread_model_idx.
 */
export const readThreadUsageRequests = async (
  db: D1Database,
  threadId: string,
  query: {
    readonly providerId: string;
    readonly modelId: string;
    readonly cursor?: string | undefined;
  },
) => {
  const separator = query.cursor?.lastIndexOf(CURSOR_SEPARATOR) ?? -1;
  const after =
    query.cursor === undefined || separator <= 0
      ? undefined
      : {
          occurredAt: query.cursor.slice(0, separator),
          id: query.cursor.slice(separator + 1),
        };
  const { results } = await db
    .prepare(
      `SELECT event.id, event.occurred_at, event.turn_purpose, event.outcome,
         event.input_tokens, event.cache_read_tokens, event.cache_write_tokens,
         event.output_tokens, event.estimated_cost_micros_snapshot,
         event.connection_id,
         connection.name AS connection_name,
         connection.kind AS connection_kind,
         connection.provider_id AS connection_provider
       FROM usage_event AS event
       LEFT JOIN model_connection AS connection
         ON connection.id = event.connection_id
       WHERE event.kind = 'model' AND event.thread_id = ?1
         AND event.observed_provider_id = ?2 AND event.observed_model_id = ?3
         ${after === undefined ? "" : "AND (event.occurred_at, event.id) < (?4, ?5)"}
       ORDER BY event.occurred_at DESC, event.id DESC
       LIMIT ${THREAD_USAGE_REQUEST_PAGE + 1}`,
    )
    .bind(
      threadId,
      query.providerId,
      query.modelId,
      ...(after === undefined ? [] : [after.occurredAt, after.id]),
    )
    .all<RequestRow>();
  const page = results.slice(0, THREAD_USAGE_REQUEST_PAGE);
  const last = page[page.length - 1];
  return {
    requests: page.map((row): ThreadUsageRequest => {
      const kind = routeKind({
        connection_id: row.connection_id,
        provider_id: query.providerId,
        connection_kind: row.connection_kind,
        connection_provider: row.connection_provider,
      } as ModelRow);
      const listPrice = row.estimated_cost_micros_snapshot;
      return {
        id: row.id,
        occurredAt: row.occurred_at,
        purpose: row.turn_purpose,
        outcome: row.outcome,
        routeName: routeName(row as unknown as ModelRow),
        inputTokens: row.input_tokens ?? 0,
        cacheReadTokens: row.cache_read_tokens ?? 0,
        cacheWriteTokens: row.cache_write_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        dxCostMicros: kind === "deployment" ? (listPrice ?? 0) : 0,
        listPriceMicros: listPrice,
      };
    }),
    nextCursor:
      results.length > THREAD_USAGE_REQUEST_PAGE && last !== undefined
        ? `${last.occurred_at}${CURSOR_SEPARATOR}${last.id}`
        : null,
  };
};

interface SessionRow {
  readonly started_at: number;
  readonly ended_at: number;
  readonly provider: string;
  readonly runner_profile_id: string;
  readonly billing: ThreadOrbBilling;
  readonly cost_micros: number;
}

/** One page of the Thread's Orb sessions, newest first, by primary key. */
export const readThreadOrbSessions = async (
  db: D1Database,
  threadId: string,
  cursor: string | undefined,
  catalog: string | undefined,
) => {
  const before = cursor === undefined ? undefined : Number(cursor);
  const { results } = await db
    .prepare(
      `SELECT started_at, ended_at, provider, runner_profile_id, billing,
         cost_micros
       FROM thread_orb_session
       WHERE thread_id = ?1 ${before === undefined || !Number.isSafeInteger(before) ? "" : "AND started_at < ?2"}
       ORDER BY started_at DESC
       LIMIT ${THREAD_ORB_SESSION_PAGE + 1}`,
    )
    .bind(
      threadId,
      ...(before === undefined || !Number.isSafeInteger(before)
        ? []
        : [before]),
    )
    .all<SessionRow>();
  const page = results.slice(0, THREAD_ORB_SESSION_PAGE);
  const last = page[page.length - 1];
  return {
    sessions: page.map((row): ThreadOrbSession => {
      const resources = orbSizeResources(catalog, row.runner_profile_id);
      return {
        startedAt: new Date(row.started_at).toISOString(),
        endedAt: new Date(row.ended_at).toISOString(),
        runtimeMs: row.ended_at - row.started_at,
        providerId: row.provider,
        runnerProfileId: row.runner_profile_id,
        cpuCores: resources?.cpuCores ?? null,
        memoryMb: resources?.memoryMb ?? null,
        costMicros: row.cost_micros,
        billing: row.billing,
      };
    }),
    nextCursor:
      results.length > THREAD_ORB_SESSION_PAGE && last !== undefined
        ? String(last.started_at)
        : null,
  };
};

const chunk = backfillChunk("usage_thread_rollup_backfill");

const threadModelBackfill = `INSERT INTO usage_thread_model (
    thread_id, connection_id, provider_id, model_id, requests, compactions,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    estimated_cost_micros, known_cost_events
  )
  SELECT * FROM (
    SELECT event.thread_id, event.connection_id,
      COALESCE(event.observed_provider_id, event.provider_id),
      COALESCE(event.observed_model_id, event.model_id),
      COUNT(*),
      SUM(event.turn_purpose = 'compaction' AND event.outcome = 'success'),
      SUM(COALESCE(event.input_tokens, 0)),
      SUM(COALESCE(event.output_tokens, 0)),
      SUM(COALESCE(event.cache_read_tokens, 0)),
      SUM(COALESCE(event.cache_write_tokens, 0)),
      SUM(COALESCE(event.estimated_cost_micros_snapshot, 0)),
      SUM(event.estimated_cost_micros_snapshot IS NOT NULL)
    FROM usage_event AS event
    WHERE event.kind = 'model' AND ${chunk}
    GROUP BY 1, 2, 3, 4
  ) WHERE true
  ORDER BY 1, 2, 3, 4
  ON CONFLICT DO UPDATE SET
    requests = requests + excluded.requests,
    compactions = compactions + excluded.compactions,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
    known_cost_events = known_cost_events + excluded.known_cost_events`;

/** Backfills migration 0161's Thread rollup; see `backfillRollups`. */
export const backfillThreadUsageRollup = (
  db: D1Database,
  chunks: number,
  chunkRows = 50_000,
): Promise<boolean> =>
  backfillRollups(
    db,
    "usage_thread_rollup_backfill",
    [threadModelBackfill],
    chunks,
    chunkRows,
  );

/** Drops Orb sessions that ended before `before` (epoch ms). */
export const purgeExpiredOrbSessions = (db: D1Database, before: number) =>
  db
    .prepare("DELETE FROM thread_orb_session WHERE ended_at <= ?")
    .bind(before)
    .run();
