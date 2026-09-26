import { env } from "cloudflare:workers";
import type { ThinkingLevel } from "@dx/domain";
import type { ModelResolutionContext, SandboxFactory } from "@flue/runtime";
import { Effect } from "effect";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
import type { Bindings } from "../http/types.js";
import {
  loadRuntimeConfiguration,
  selectRuntimeAdapters,
} from "./composition.js";
import { LOCAL_MODEL_FIXTURE_ROUTE } from "./model-fixture-route.js";

export { LOCAL_MODEL_FIXTURE_ROUTE } from "./model-fixture-route.js";

/** Resolved once per submission by `DxAgent.resolvePromptData`. */
export interface DxPromptData {
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

interface ModelSelection {
  readonly model: string;
  readonly options: { readonly thinkingLevel: ThinkingLevel } | undefined;
}

interface AgentModelAdapter {
  readonly select: (promptData: DxPromptData | undefined) => ModelSelection;
  readonly resolvePromptData: (
    context: ModelResolutionContext,
  ) => Promise<DxPromptData | undefined>;
}

/**
 * Prepare one durable route before rendering. The provider and coordinator
 * consume this same route; neither independently selects a connection.
 */
const resolvePromptData =
  (bindings: Bindings) =>
  async (
    context: ModelResolutionContext,
  ): Promise<DxPromptData | undefined> => {
    const namespace = bindings.BYOK_CREDENTIAL_COORDINATOR;
    if (namespace === undefined || context.scope?.kind !== "prompt")
      throw new Error("Model routing is not configured.");
    const response = await namespace
      .get(namespace.idFromName(`byok-${context.instanceId}`))
      .fetch("https://dx-byok.invalid/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: context.instanceId,
          submissionId: context.scope.submissionId,
          recovery: context.recovery,
        }),
        signal: context.signal,
      });
    if (!response.ok) {
      const { code } = await response.json<{ code: string }>();
      throw new Error(
        code.startsWith("MODEL_NOT_SERVED:")
          ? `Model ${code.slice("MODEL_NOT_SERVED:".length).trim()} is not served. Add or enable a connection, then retry.`
          : `Model routing unavailable: ${code}`,
      );
    }
    return response.json<DxPromptData>();
  };

const selectModel = (
  promptData: DxPromptData | undefined,
  fallback: () => ModelSelection,
): ModelSelection =>
  promptData === undefined
    ? fallback()
    : {
        model: promptData.model,
        options: { thinkingLevel: promptData.thinking },
      };

/** Routine local development cannot invoke paid providers. */
const localModelAdapter: AgentModelAdapter = {
  select: () => ({
    model: LOCAL_MODEL_FIXTURE_ROUTE,
    options: undefined,
  }),
  resolvePromptData: async () => undefined,
};

const defaultCloudflareModel = "cloudflare/@cf/zai-org/glm-5.3-flash";

/** Deployed threads must resolve; a missing route fails visibly. */
const cloudflareModelAdapter: AgentModelAdapter = {
  select: (promptData) =>
    selectModel(promptData, () => {
      throw new Error(
        "Model routing unavailable — no thread route or selection resolved.",
      );
    }),
  resolvePromptData: resolvePromptData(env as Bindings),
};

const localModelPreviewAdapter: AgentModelAdapter = {
  select: () => ({ model: defaultCloudflareModel, options: undefined }),
  resolvePromptData: async () => undefined,
};

export const makeAgentRuntimeComposition = (
  bindings: Bindings,
  execution: SandboxFactory,
) => {
  if (
    bindings.DX_RUNTIME_MODE === "local" &&
    bindings.DX_LOCAL_MODEL_PREVIEW === "1"
  ) {
    return {
      capabilities: "model-only" as const,
      execution: undefined,
      model: localModelPreviewAdapter,
    };
  }
  const selected = selectRuntimeAdapters(
    Effect.runSync(loadRuntimeConfiguration(bindings)),
    {
      local: {
        execution,
        model: localModelAdapter,
      },
      deployed: {
        execution,
        model: {
          ...cloudflareModelAdapter,
          resolvePromptData: resolvePromptData(bindings),
        },
      },
    },
  );
  return { ...selected, capabilities: "workspace" as const };
};

export const agentRuntimeComposition = makeAgentRuntimeComposition(
  env as Bindings,
  ExecutionWorkspaces.sandboxFactory,
);
