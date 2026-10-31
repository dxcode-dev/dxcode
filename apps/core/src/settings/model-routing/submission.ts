import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudePlanRefused,
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
  lastThreadClaudeConnection,
  loadModeProfileOverrides,
  loadRoutableConnections,
  loadSubscriptionModelIds,
  loadThreadClaudePlan,
  loadThreadRoute,
  type ThreadClaudePlan,
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
 * A Claude Code Thread's plan is disabled, deleted, or out of its owner's
 * reach. The Thread takes no other plan; `/resolve` refuses with this text.
 */
export class ClaudePlanUnavailable extends Error {
  readonly code = "CLAUDE_PLAN_UNAVAILABLE";
  constructor(
    readonly cause: "disabled" | "removed",
    planName?: string,
  ) {
    super(
      cause === "disabled"
        ? `This Thread runs on the Claude plan "${planName}", which is disabled. Enable it in Model Routing, or start a new Thread.`
        : "The Claude plan this Thread ran on was removed. A Thread never moves to another plan: start a new Thread.",
    );
  }
}

/**
 * A Claude Code Thread stays on one plan, whatever happens to it: used up,
 * disabled, or deleted. A Thread that ran turns before it had a binding is
 * on the plan of its latest turn. Only a Thread that never ran Claude Code
 * takes a plan, the first not used up, at its first submission that finds
 * one.
 */
const threadClaudePlan = async (
  db: D1Database,
  thread: ThreadRoute,
  connections: ReadonlyArray<StoredModelConnection>,
  model: string,
  entitlements: CopilotEntitlements,
): Promise<ServingMatch | undefined> => {
  // The Thread's own plan, never another: disabled or gone, it is refused.
  const own = (connectionId: string): ServingMatch => {
    const connection = connections.find(({ id }) => id === connectionId);
    if (connection === undefined) throw new ClaudePlanUnavailable("removed");
    if (!connection.enabled)
      throw new ClaudePlanUnavailable("disabled", connection.name);
    const match = findServingConnection([connection], model, entitlements);
    if (match === undefined) throw new Error(`MODEL_NOT_SERVED: ${model}`);
    return match;
  };
  // Nothing only when the Thread never had a plan.
  const held = (plan: ThreadClaudePlan): ServingMatch | undefined => {
    if (plan.connectionId !== undefined) return own(plan.connectionId);
    if (plan.boundAt !== undefined) throw new ClaudePlanUnavailable("removed");
    return undefined;
  };
  const bound = held(await loadThreadClaudePlan(db, thread.threadId));
  if (bound !== undefined) return bound;
  const bind = async (match: ServingMatch) => {
    const current = await bindThreadClaudeConnection(
      db,
      thread.threadId,
      match.connection.id,
    );
    return current.connectionId === match.connection.id ||
      (current.connectionId === undefined && current.boundAt === undefined)
      ? match
      : held(current);
  };
  const earlier = await lastThreadClaudeConnection(
    db,
    thread.ownerUserId,
    thread.threadId,
  );
  if (earlier !== undefined) return bind(own(earlier));
  const picked = await openClaudePlan(db, connections, model, entitlements);
  if (picked === undefined || !picked.open) return picked?.match;
  return bind(picked.match);
};

const resetText = (seconds: number) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The Claude plan a new Thread is bound to at creation: the one picked, if
 * it is the owner's, enabled, and not used up for `model`. With no pick, a
 * Thread whose owner has one enabled plan takes it at its first submission;
 * with more, a plan must be picked. A Thread that does not run Claude Code
 * takes no plan.
 */
const pickedClaudePlan = async (
  db: D1Database,
  connections: ReadonlyArray<StoredModelConnection>,
  model: string,
  picked: string | undefined,
): Promise<string | undefined> => {
  const plans = connections.filter(
    ({ providerId, enabled }) =>
      providerId === CLAUDE_CODE_PROVIDER_ID && enabled,
  );
  if (!isClaudeCodeModel(model)) {
    if (picked === undefined) return undefined;
    throw new ClaudePlanRefused({
      reason: "unavailable",
      message: "A Claude plan applies only to a Thread that runs Claude Code.",
    });
  }
  if (picked === undefined) {
    if (plans.length <= 1) return undefined;
    throw new ClaudePlanRefused({
      reason: "required",
      message: `Pick the Claude plan this Thread runs on: ${plans
        .map(({ id, name }) => `${name} (${id})`)
        .join(", ")}.`,
    });
  }
  const plan = plans.find(({ id }) => id === picked);
  if (plan === undefined)
    throw new ClaudePlanRefused({
      reason: "unavailable",
      message:
        "That Claude plan is not one of your enabled Claude Pro/Max plans.",
    });
  const blockedUntil = claudePlanAccess(
    await loadClaudePlan(db, plan.id),
    model.slice(model.indexOf("/") + 1),
  ).blockedUntil;
  if (blockedUntil !== undefined)
    throw new ClaudePlanRefused({
      reason: "used-up",
      message: `${plan.name} is used up until ${resetText(blockedUntil)}. Pick another plan or start the Thread after then.`,
      resetsAt: blockedUntil,
    });
  return plan.id;
};

/**
 * Resolves a proposed selection against current routing state without
 * reading credentials, pinning a connection, or persisting anything, and the
 * Claude plan a new Thread is bound to (see `pickedClaudePlan`).
 */
export const resolveSelectionForUser = async (
  bindings: Bindings,
  userId: UserId,
  selection: ThreadModelSelection,
  claudeConnectionId?: string,
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
  const defaultProfile = deployment ? DEV_PROFILE : DEFAULT_PROFILE;
  const model =
    selection.kind === "mode"
      ? (overrides.get(selection.mode) ?? defaultProfile.modes[selection.mode])
          .agent.model
      : selection.model;
  const claudePlan = await pickedClaudePlan(
    db,
    connections,
    model,
    claudeConnectionId,
  );
  return {
    ...resolveSubmissionModel({
      selection,
      connections,
      defaultProfile,
      modeOverrides: overrides,
      copilotEntitlements: (id) => entitlements.get(id),
    }),
    ...(claudePlan === undefined ? {} : { claudeConnectionId: claudePlan }),
  };
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
