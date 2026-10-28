import { env } from "cloudflare:workers";
import type { Bindings } from "../http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionProvider,
  type ExecutionProviderId,
} from "../plugins/execution/provider.js";
import { makeExecutionActivation } from "./activation.js";
import { executionProviders, orbProviderConnectors } from "./orb-providers.js";

export { executionProviders };

/**
 * The deployment's Execution providers, resolved from the plugin registry and
 * bindings, behind Core's activation pipeline. Every Thread's workspace comes
 * from the provider its runner profile names; none fails closed.
 */
export const makeExecutionWorkspaces = (
  bindings: Bindings,
  providers: Readonly<
    Partial<Record<ExecutionProviderId, ExecutionProvider>>
  > = executionProviders,
) =>
  composeExecutionWorkspaces(
    bindings,
    providers,
    makeExecutionActivation(),
    undefined,
    undefined,
    (providerId) => orbProviderConnectors[providerId] !== undefined,
  );

export const ExecutionWorkspaces = makeExecutionWorkspaces(env as Bindings);
