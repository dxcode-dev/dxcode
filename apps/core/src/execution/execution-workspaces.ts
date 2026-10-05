import { env } from "cloudflare:workers";
import type { Bindings } from "../http/types.js";
import {
  composeExecutionWorkspaces,
  type ExecutionProvider,
  type ExecutionProviderId,
} from "../plugins/execution/provider.js";
import { makeExecutionActivation } from "./activation.js";
import { cloudflareExecutionProvider } from "./cloudflare/provider.js";
import { e2bExecutionProvider } from "./e2b/provider.js";
import { localExecutionProvider } from "./local/provider.js";

/** Implementations of the providers the Execution plugin registers. */
export const executionProviders = Object.freeze({
  e2b: e2bExecutionProvider as ExecutionProvider,
  cloudflare: cloudflareExecutionProvider as ExecutionProvider,
  local: localExecutionProvider,
}) satisfies Record<ExecutionProviderId, ExecutionProvider>;

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
) => composeExecutionWorkspaces(bindings, providers, makeExecutionActivation());

export const ExecutionWorkspaces = makeExecutionWorkspaces(env as Bindings);
