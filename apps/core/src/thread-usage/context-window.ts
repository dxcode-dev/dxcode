import type { FlueObservation } from "@flue/runtime";
import { moduleListLines } from "../plugins/code/catalog.js";
import { TOOL_SEARCH_TOOL } from "../plugins/code/definitions.js";
import { findCatalogModel } from "../settings/model-routing/catalog.js";
import { effectiveContextWindow } from "../settings/model-routing/context-window.js";

/**
 * A Thread's current context window: what its last agent request sent, by
 * part, so the Cost & Usage dialog shows it without loading the
 * conversation or calling a model.
 *
 * Flue's `turn_request` carries the exact system prompt, tool definitions,
 * and messages of each model request. Each part is estimated at four
 * characters a token, Flue's own estimate; when the turn ends, the
 * provider's measured input replaces the estimate's total and the messages
 * take what the fixed parts leave, plus the reply, which the next request
 * sends too. One row per Thread (thread_context_window) is written beside
 * the turn's usage event.
 */

export const CHARACTERS_PER_TOKEN = 4;
const MAX_PENDING = 256;
const MAX_SERVERS = 64;

const tokens = (characters: number) =>
  Math.ceil(Math.max(0, characters) / CHARACTERS_PER_TOKEN);

export interface ContextComposition {
  readonly systemPromptTokens: number;
  readonly builtinToolTokens: number;
  readonly mcpServers: ReadonlyArray<{
    readonly server: string;
    readonly tokens: number;
  }>;
  readonly messageTokens: number;
}

type TurnRequest = Extract<FlueObservation, { type: "turn_request" }>;

/** The parts of one model request, estimated. */
export const composeContext = (
  input: TurnRequest["request"]["input"],
): ContextComposition => {
  let builtin = 0;
  const servers = new Map<string, number>();
  for (const tool of input.tools ?? []) {
    const characters = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length;
    if (tool.name !== TOOL_SEARCH_TOOL.name) {
      builtin += characters;
      continue;
    }
    let listed = 0;
    for (const line of moduleListLines(tool.description)) {
      servers.set(
        line.module,
        (servers.get(line.module) ?? 0) + line.characters,
      );
      listed += line.characters;
    }
    builtin += characters - listed;
  }
  return {
    systemPromptTokens: tokens(input.systemPrompt?.length ?? 0),
    builtinToolTokens: tokens(builtin),
    mcpServers: [...servers]
      .slice(0, MAX_SERVERS)
      .map(([server, characters]) => ({ server, tokens: tokens(characters) })),
    messageTokens: tokens(JSON.stringify(input.messages).length),
  };
};

/**
 * The composition settled against what the provider measured: `measured`
 * input (uncached, cache reads, and cache writes) and the `output` reply.
 */
export const settleContext = (
  composition: ContextComposition,
  measured: number,
  output: number,
): ContextComposition => {
  if (measured <= 0)
    return {
      ...composition,
      messageTokens: composition.messageTokens + output,
    };
  const fixed =
    composition.systemPromptTokens +
    composition.builtinToolTokens +
    composition.mcpServers.reduce((sum, server) => sum + server.tokens, 0);
  if (fixed <= measured)
    return { ...composition, messageTokens: measured - fixed + output };
  // The estimate of the fixed parts alone exceeds what was measured: shrink
  // them in proportion, and give what flooring leaves over to the messages,
  // so the parts add up to exactly the measured input plus the reply.
  const scale = measured / fixed;
  const systemPromptTokens = Math.floor(composition.systemPromptTokens * scale);
  const builtinToolTokens = Math.floor(composition.builtinToolTokens * scale);
  const mcpServers = composition.mcpServers.map((server) => ({
    server: server.server,
    tokens: Math.floor(server.tokens * scale),
  }));
  return {
    systemPromptTokens,
    builtinToolTokens,
    mcpServers,
    messageTokens:
      measured -
      systemPromptTokens -
      builtinToolTokens -
      mcpServers.reduce((sum, server) => sum + server.tokens, 0) +
      output,
  };
};

const pending = new Map<string, ContextComposition>();

/**
 * Remembers an agent request's composition until its turn ends, in the
 * isolate that runs the turn. Bounded: an isolate keeps at most
 * `MAX_PENDING` turns, oldest dropped.
 */
export const observeTurnRequest = (event: FlueObservation) => {
  if (
    event.type !== "turn_request" ||
    event.purpose !== "agent" ||
    event.instanceId === undefined
  )
    return;
  pending.set(
    `${event.instanceId}:${event.turnId}`,
    composeContext(event.request.input),
  );
  if (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
};

/** Takes the composition of a turn whose request was observed here. */
export const takeTurnComposition = (threadId: string, turnId: string) => {
  const key = `${threadId}:${turnId}`;
  const composition = pending.get(key);
  pending.delete(key);
  return composition;
};

/** The window dx gives `providerId/modelId`, when the catalog knows it. */
export const contextWindowOf = (providerId: string, modelId: string) => {
  const native = findCatalogModel(providerId, modelId)?.contextWindow;
  return native === undefined || native <= 0
    ? null
    : effectiveContextWindow(`${providerId}/${modelId}`, native);
};

/** The upsert of a Thread's context window after one agent turn. */
export const contextWindowStatement = (
  db: D1Database,
  row: {
    readonly threadId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly measuredAt: string;
    readonly composition: ContextComposition;
  },
) =>
  db
    .prepare(
      `INSERT INTO thread_context_window (
         thread_id, provider_id, model_id, context_window, system_prompt_tokens,
         builtin_tool_tokens, mcp_servers, message_tokens, measured_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (thread_id) DO UPDATE SET
         provider_id = excluded.provider_id,
         model_id = excluded.model_id,
         context_window = excluded.context_window,
         system_prompt_tokens = excluded.system_prompt_tokens,
         builtin_tool_tokens = excluded.builtin_tool_tokens,
         mcp_servers = excluded.mcp_servers,
         message_tokens = excluded.message_tokens,
         measured_at = excluded.measured_at
       WHERE excluded.measured_at >= thread_context_window.measured_at`,
    )
    .bind(
      row.threadId,
      row.providerId,
      row.modelId,
      contextWindowOf(row.providerId, row.modelId),
      row.composition.systemPromptTokens,
      row.composition.builtinToolTokens,
      JSON.stringify(row.composition.mcpServers),
      row.composition.messageTokens,
      row.measuredAt,
    );
