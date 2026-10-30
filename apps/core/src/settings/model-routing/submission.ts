import {
  isClaudeCodeModel,
  normalizeCustomModelBaseUrl,
  type StoredModelConnection,
  type ThinkingLevel,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import type { Api, Model } from "@earendil-works/pi-ai";
import { claudePlanAccess, loadClaudePlan } from "../../claude-code/plan.js";
import type { Bindings } from "../../http/types.js";
import {
  DEV_PROFILE,
  devWorkersAiConnection,
  workersAiDeploymentEnabled,
} from "../../runtime/model-routing-dev-defaults.js";
import { catalogProviderModels } from "./catalog.js";
import {
  bindThreadClaudeConnection,
  loadModeProfileOverrides,
  loadRoutableConnections,
  loadSubscriptionModelIds,
  loadThreadRoute,
  type ThreadRoute,
} from "./connection-store-d1.js";
import { effectiveContextWindow } from "./context-window.js";
import { copilotModelForCanonical } from "./copilot-mapping.js";
import { DEFAULT_PROFILE } from "./defaults.js";
import {
  type CopilotEntitlements,
  findServingConnection,
  pinThinking,
  resolveSubmissionModel,
  type ServingMatch,
} from "./resolver.js";

/**
 * The first Claude plan, in routing order, that is not used up for `model`;
 * when every plan is, the one that resets first, so `/resolve` refuses with
 * its limit.
 */
const openClaudePlan = async (
  db: D1Database,
  connections: ReadonlyArray<StoredModelConnection>,
  model: string,
  entitlements: CopilotEntitlements,
): Promise<{ match: ServingMatch; open: boolean } | undefined> => {
  const modelId = model.slice(model.indexOf("/") + 1);
  let remaining = connections;
  let soonest: { match: ServingMatch; until: number } | undefined;
  for (;;) {
    const match = findServingConnection(remaining, model, entitlements);
    if (match === undefined)
      return soonest === undefined
        ? undefined
        : { match: soonest.match, open: false };
    const until = claudePlanAccess(
      await loadClaudePlan(db, match.connection.id),
      modelId,
    ).blockedUntil;
    if (until === undefined) return { match, open: true };
    if (soonest === undefined || until < soonest.until)
      soonest = { match, until };
    remaining = remaining.filter(({ id }) => id !== match.connection.id);
  }
};

/**
 * A Claude Code Thread stays on one plan, used up or not. Its first
 * submission that finds a plan not used up puts it on that plan; a deleted
 * or disabled plan lets it take another.
 */
const threadClaudePlan = async (
  db: D1Database,
  thread: ThreadRoute,
  connections: ReadonlyArray<StoredModelConnection>,
  model: string,
  entitlements: CopilotEntitlements,
): Promise<ServingMatch | undefined> => {
  const serving = (id: string | undefined) =>
    id === undefined
      ? undefined
      : findServingConnection(
          connections.filter((connection) => connection.id === id),
          model,
          entitlements,
        );
  const bound = serving(thread.claudeConnectionId);
  if (bound !== undefined) return bound;
  const picked = await openClaudePlan(db, connections, model, entitlements);
  if (picked === undefined || !picked.open) return picked?.match;
  const current = await bindThreadClaudeConnection(
    db,
    thread.threadId,
    thread.claudeConnectionId,
    picked.match.connection.id,
  );
  return serving(current) ?? picked.match;
};

/**
 * Resolves a proposed selection against current routing state without
 * reading credentials, pinning a connection, or persisting anything.
 */
export const resolveSelectionForUser = async (
  bindings: Bindings,
  userId: UserId,
  selection: ThreadModelSelection,
) => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Model routing is not configured.");
  const [stored, overrides] = await Promise.all([
    loadRoutableConnections(db, userId),
    loadModeProfileOverrides(db, userId),
  ]);
  const deployment = workersAiDeploymentEnabled(bindings);
  const connections = deployment
    ? [...stored, devWorkersAiConnection(new Date().toISOString() as never)]
    : stored;
  const entitlements = new Map<string, ReadonlySet<string>>(
    await Promise.all(
      connections
        .filter((connection) => connection.kind === "subscription")
        .map(
          async (connection) =>
            [
              connection.id,
              new Set(
                (await loadSubscriptionModelIds(db, userId, connection.id)) ??
                  [],
              ),
            ] as const,
        ),
    ),
  );
  return resolveSubmissionModel({
    selection,
    connections,
    defaultProfile: deployment ? DEV_PROFILE : DEFAULT_PROFILE,
    modeOverrides: overrides,
    copilotEntitlements: (id) => entitlements.get(id),
  });
};

/** Kept only in the credential DO, never in Flue history or the sandbox. */
export interface SubmissionRoute {
  readonly threadId: string;
  readonly submissionId: string;
  readonly ownerUserId: string;
  readonly connection: StoredModelConnection;
  readonly upstreamModel: string;
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel;
}

/**
 * Catalog compat describes the provider's own endpoint. A custom URL promises
 * only the standard API format, so drop features that need Anthropic's
 * first-party transport: effort-only mid-conversation messages with thinking
 * binding controls, server-side fallback, mid-conversation system messages
 * and inline tool changes, and client tool references. Model traits such as
 * adaptive thinking or no temperature still apply.
 */
const customEndpointCompat = (compat: Model<Api>["compat"]) => {
  const {
    supportsMidConvoEffort: _midConversationEffort,
    allowedFallbackModels: _serverSideFallback,
    supportsMidConvoSystemMessages: _midConversationSystemMessages,
    supportsMidConvoToolChanges: _inlineToolChanges,
    ...traits
  } = (compat ?? {}) as Record<string, unknown>;
  return { ...traits, supportsToolReferences: false };
};

/** One descriptor drives both serialization and credential forwarding. */
export const connectionModel = (
  connection: StoredModelConnection,
  canonical: string,
): Model<Api> =>
  withEffectiveContextWindow(servingModel(connection, canonical));

/** Applies dx's context policy, including to routes pinned before it. */
export const withEffectiveContextWindow = (model: Model<Api>): Model<Api> => ({
  ...model,
  contextWindow: effectiveContextWindow(
    `${model.provider}/${model.id}`,
    model.contextWindow,
  ),
});

const servingModel = (
  connection: StoredModelConnection,
  canonical: string,
): Model<Api> => {
  const slash = canonical.indexOf("/");
  const provider = canonical.slice(0, slash);
  const id = canonical.slice(slash + 1);
  const entry = catalogProviderModels(provider).find(
    (model) => model.id === id,
  );
  if (connection.kind === "subscription") {
    const copilot = copilotModelForCanonical(canonical);
    if (copilot === undefined) throw new Error("MODEL_NOT_SERVED");
    return {
      id,
      provider,
      name: copilot.name,
      api: copilot.protocol,
      baseUrl: "https://api.githubcopilot.com",
      reasoning: copilot.capabilities.reasoning,
      input: copilot.capabilities.vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: copilot.capabilities.contextWindow,
      maxTokens: copilot.capabilities.maxOutputTokens,
      // Selects adaptive thinking for Claude 4.7+; Copilot passes Anthropic's
      // 400 for budget-based thinking straight back.
      compat: copilot.compatibility,
      thinkingLevelMap: copilot.thinkingLevelMap,
    } as Model<Api>;
  }
  if (entry === undefined && connection.kind === "custom") {
    const copilot = copilotModelForCanonical(canonical);
    if (copilot !== undefined && connection.format && connection.baseUrl) {
      return {
        id,
        provider,
        name: copilot.name,
        api: connection.format,
        baseUrl: normalizeCustomModelBaseUrl(
          connection.format,
          connection.baseUrl,
        ),
        reasoning: copilot.capabilities.reasoning,
        input: copilot.capabilities.vision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: copilot.capabilities.contextWindow,
        maxTokens: copilot.capabilities.maxOutputTokens,
      } as Model<Api>;
    }
  }
  if (entry === undefined) throw new Error("MODEL_NOT_SERVED");
  if (connection.kind === "deployment") {
    return {
      ...entry,
      provider,
      api: "cloudflare-ai-binding",
      baseUrl: "",
    } as Model<Api>;
  }
  if (connection.kind === "custom") {
    if (!connection.format || !connection.baseUrl)
      throw new Error("MODEL_NOT_SERVED");
    return {
      ...entry,
      provider,
      api: connection.format,
      // Normalized on read too, so connections saved before normalization work.
      baseUrl: normalizeCustomModelBaseUrl(
        connection.format,
        connection.baseUrl,
      ),
      compat: customEndpointCompat(entry.compat),
    } as Model<Api>;
  }
  let baseUrl = entry.baseUrl;
  const { resourceName, accountId, gatewayId, region } = connection.fields;
  if (provider === "azure-openai-responses" && resourceName)
    baseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;
  if (provider === "cloudflare-ai-gateway" && accountId && gatewayId)
    baseUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
  if (provider === "amazon-bedrock" && region)
    baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`;
  return {
    ...entry,
    provider,
    baseUrl: connection.baseUrl ?? baseUrl,
  } as Model<Api>;
};

export const resolveThreadSubmission = async (
  bindings: Bindings,
  threadId: string,
  submissionId: string,
): Promise<SubmissionRoute> => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Model routing is not configured.");
  const thread = await loadThreadRoute(db, threadId);
  if (thread === undefined) throw new Error("THREAD_ROUTE_NOT_FOUND");
  return resolveRouteSubmission(bindings, thread, submissionId);
};

/**
 * The same resolution for a route not yet persisted: DxTitleAgent starts while
 * its Thread is still being created, from the owner and requested selection.
 */
export const resolveRouteSubmission = async (
  bindings: Bindings,
  thread: ThreadRoute,
  submissionId: string,
): Promise<SubmissionRoute> => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Model routing is not configured.");
  const threadId = thread.threadId;
  const [stored, overrides] = await Promise.all([
    loadRoutableConnections(db, thread.ownerUserId),
    loadModeProfileOverrides(db, thread.ownerUserId),
  ]);
  const deployment = workersAiDeploymentEnabled(bindings);
  const connections = deployment
    ? [...stored, devWorkersAiConnection(new Date().toISOString() as never)]
    : stored;
  const defaults = deployment ? DEV_PROFILE : DEFAULT_PROFILE;
  const slot =
    thread.selection.kind === "mode"
      ? (
          overrides.get(thread.selection.mode) ??
          defaults.modes[thread.selection.mode]
        ).agent
      : {
          model: thread.selection.model,
          thinking: pinThinking(thread.selection),
        };
  const entitlements = new Map<string, ReadonlySet<string>>(
    await Promise.all(
      connections
        .filter((connection) => connection.kind === "subscription")
        .map(
          async (connection) =>
            [
              connection.id,
              new Set(
                (await loadSubscriptionModelIds(
                  db,
                  thread.ownerUserId,
                  connection.id,
                )) ?? [],
              ),
            ] as const,
        ),
    ),
  );
  const servingEntitlements = (id: string) => entitlements.get(id);
  const match = isClaudeCodeModel(slot.model)
    ? await threadClaudePlan(
        db,
        thread,
        connections,
        slot.model,
        servingEntitlements,
      )
    : findServingConnection(connections, slot.model, servingEntitlements);
  if (match === undefined) throw new Error(`MODEL_NOT_SERVED: ${slot.model}`);
  return {
    threadId,
    submissionId,
    ownerUserId: thread.ownerUserId,
    connection: match.connection,
    upstreamModel: match.upstreamModel,
    model: connectionModel(match.connection, slot.model),
    thinking: slot.thinking,
  };
};
