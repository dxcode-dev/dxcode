import { env } from "cloudflare:workers";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getModelInvocationContext, setProvider } from "@flue/runtime";
import { getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import { registerClaudeCodeProvider } from "./claude-code/registration.js";
import { ExecutionWorkspaces } from "./execution/execution-workspaces.js";
import type { Bindings } from "./http/types.js";
import { settingsPersistenceLogger } from "./logging.js";
import { installContentFreeFlueTracing } from "./observability/flue-tracing.js";
import { createDxCloudflareModelProvider } from "./runtime/cloudflare-model-provider.js";
import { scheduled } from "./scheduled.js";
import { createDxModelRoutingProvider } from "./settings/model-byok/flue-provider.js";

export { OrbProviderPreparationObject } from "./plugins/execution/preparation-object.js";
export { RealtimeHub } from "./realtime/realtime-hub.js";
export { ByokCredentialCoordinatorObject } from "./settings/model-byok/invocation.js";
export { SubscriptionCredentialCoordinatorObject } from "./settings/model-subscriptions/invocation.js";
export { PluginTriggerDeliveryObject } from "./settings/triggers/durable-object.js";
export { ThreadSearchIndexObject } from "./thread-search/index-object.js";
export { ThreadExecutionObject } from "./threads/terminal-object.js";

/**
 * The Worker's non-HTTP handlers. Flue's generated entry serves `fetch` from
 * app.ts and spreads this default export beside it; a handler attached
 * anywhere else never runs.
 */
export default { scheduled } satisfies ExportedHandler<Bindings>;

declare const __DX_CORE_DEV_FIXTURES__: boolean;

// Before the generated entry's body installs Flue's content-bearing default.
installContentFreeFlueTracing();

const bindings = env as Bindings;
if (
  typeof __DX_CORE_DEV_FIXTURES__ !== "undefined" &&
  __DX_CORE_DEV_FIXTURES__ &&
  bindings.DX_RUNTIME_MODE === "local" &&
  bindings.DX_LOCAL_MODEL_PREVIEW !== "1"
) {
  const { registerLocalModelFixtureProvider } = await import(
    "./runtime/model-fixtures.js"
  );
  registerLocalModelFixtureProvider();
}
if (
  bindings.DX_RUNTIME_MODE === "local" &&
  bindings.DX_LOCAL_MODEL_PREVIEW === "1" &&
  bindings.AI !== undefined
) {
  setProvider(createDxCloudflareModelProvider(bindings.AI));
} else if (
  bindings.DX_RUNTIME_MODE !== "local" &&
  bindings.DB !== undefined &&
  bindings.BYOK_CREDENTIAL_COORDINATOR !== undefined
) {
  const deps = {
    namespace: bindings.BYOK_CREDENTIAL_COORDINATOR,
    identity: getDurableObjectIdentity,
    invocation: getModelInvocationContext,
  };
  for (const providerId of [
    ...getBuiltinProviders(),
    "cloudflare",
    "github-copilot",
    "azure-openai-responses",
  ]) {
    // dx's canonical ids for these pi providers are registered above.
    if (providerId === "cloudflare-workers-ai" || providerId === "azure")
      continue;
    const { provider, options } = createDxModelRoutingProvider(
      providerId,
      deps,
    );
    setProvider(provider, options);
  }
} else {
  settingsPersistenceLogger.warn(
    "Model routing provider registration skipped.",
    {
      event: "model_routing_provider_registration_skipped",
      hasDatabaseBinding: bindings.DB !== undefined,
      hasCoordinatorBinding: bindings.BYOK_CREDENTIAL_COORDINATOR !== undefined,
    },
  );
}

// Claude Code mode runs on the owner's Claude plan, never on a dx-billed
// provider, so local development offers it only behind its own opt-in.
if (
  bindings.BYOK_CREDENTIAL_COORDINATOR !== undefined &&
  bindings.DX_LOCAL_MODEL_PREVIEW !== "1" &&
  (bindings.DX_RUNTIME_MODE !== "local" ||
    bindings.DX_LOCAL_CLAUDE_CODE === "1")
) {
  registerClaudeCodeProvider({
    coordinator: bindings.BYOK_CREDENTIAL_COORDINATOR,
    execution: () => ExecutionWorkspaces.sandboxFactory,
  });
}
