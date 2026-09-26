import type {
  StoredModelConnection,
  ThinkingLevel,
  ThreadModelSelection,
  UserId,
} from "@dx/domain";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Bindings } from "../../http/types.js";
import {
  DEV_PROFILE,
  devWorkersAiConnection,
  workersAiDeploymentEnabled,
} from "../../runtime/model-routing-dev-defaults.js";
import { catalogProviderModels } from "./catalog.js";
import {
  loadModeProfileOverrides,
  loadRoutableConnections,
  loadSubscriptionModelIds,
  loadThreadRoute,
} from "./connection-store-d1.js";
import { copilotModelForCanonical } from "./copilot-mapping.js";
import { DEFAULT_PROFILE } from "./defaults.js";
import {
  findServingConnection,
  RAW_MODEL_THINKING,
  resolveSubmissionModel,
} from "./resolver.js";

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

/** One descriptor drives both serialization and credential forwarding. */
export const connectionModel = (
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
        baseUrl: connection.baseUrl,
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
      baseUrl: connection.baseUrl,
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
      : { model: thread.selection.model, thinking: RAW_MODEL_THINKING };
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
  const match = findServingConnection(connections, slot.model, (id) =>
    entitlements.get(id),
  );
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
