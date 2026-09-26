import { env } from "cloudflare:workers";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getModelInvocationContext, setProvider } from "@flue/runtime";
import { getDurableObjectIdentity } from "@flue/runtime/cloudflare";
import type { Bindings } from "./http/types.js";
import { settingsPersistenceLogger } from "./logging.js";
import { createDxCloudflareModelProvider } from "./runtime/cloudflare-model-provider.js";
import { createDxModelRoutingProvider } from "./settings/model-byok/flue-provider.js";

export { RealtimeHub } from "./realtime/realtime-hub.js";
export { ByokCredentialCoordinatorObject } from "./settings/model-byok/invocation.js";
export { SubscriptionCredentialCoordinatorObject } from "./settings/model-subscriptions/invocation.js";
export { PluginTriggerDeliveryObject } from "./settings/triggers/durable-object.js";
export { ThreadExecutionObject } from "./threads/terminal-object.js";

declare const __DX_CORE_DEV_FIXTURES__: boolean;

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
  ]) {
    if (providerId === "cloudflare-workers-ai") continue;
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
