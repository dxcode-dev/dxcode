import type { OrbProviderId } from "@dx/domain";
import type {
  OrbProviderConnector,
  OrbProviderConnectors,
} from "../plugins/execution/connector.js";
import type {
  ExecutionProvider,
  ExecutionProviderId,
} from "../plugins/execution/provider.js";
import { makeBoatConnector } from "./boat/connector.js";
import { boatExecutionProvider } from "./boat/provider.js";
import { makeCloudflareConnector } from "./cloudflare/connector.js";
import { cloudflareExecutionProvider } from "./cloudflare/provider.js";
import { makeDockerConnector } from "./docker/connector.js";
import { dockerExecutionProvider } from "./docker/provider.js";
import { makeE2BConnector } from "./e2b/connector.js";
import { e2bExecutionProvider } from "./e2b/provider.js";
import { makeFreestyleConnector } from "./freestyle/connector.js";
import { freestyleExecutionProvider } from "./freestyle/provider.js";
import { localExecutionProvider } from "./local/provider.js";

/**
 * One Orb provider's implementation: its `ExecutionProvider` (the workspace
 * lifecycle, commands, files, and dxd) and, when people and workspaces can
 * connect their own accounts, its connector. What the provider is (ID,
 * names, capabilities, sizes) is its `@dx/domain` descriptor.
 */
export interface OrbProviderModule {
  readonly execution: ExecutionProvider;
  readonly connector?: OrbProviderConnector;
}

/** Cloudflare connections need a published public Orb image to copy. */
const cloudflareConnector = makeCloudflareConnector();
/** Docker Sandboxes connections boot the published public Orb image. */
const dockerConnector = makeDockerConnector();

/**
 * Every Orb provider's implementation, one entry per `@dx/domain`
 * descriptor. See wiki/plugin-platform-direction.md "Adding an Orb
 * provider".
 */
export const ORB_PROVIDER_MODULES: Readonly<
  Record<OrbProviderId, OrbProviderModule>
> = Object.freeze({
  e2b: {
    execution: e2bExecutionProvider as ExecutionProvider,
    connector: makeE2BConnector(),
  },
  cloudflare: {
    execution: cloudflareExecutionProvider as ExecutionProvider,
    ...(cloudflareConnector === undefined
      ? {}
      : { connector: cloudflareConnector }),
  },
  freestyle: {
    execution: freestyleExecutionProvider as ExecutionProvider,
    connector: makeFreestyleConnector(),
  },
  docker: {
    execution: dockerExecutionProvider as ExecutionProvider,
    ...(dockerConnector === undefined ? {} : { connector: dockerConnector }),
  },
  boat: {
    execution: boatExecutionProvider as ExecutionProvider,
    connector: makeBoatConnector(),
  },
  local: { execution: localExecutionProvider },
});

const providerIds = Object.keys(
  ORB_PROVIDER_MODULES,
) as Array<ExecutionProviderId>;

/** Implementations of the providers the Execution plugin registers. */
export const executionProviders: Readonly<
  Record<ExecutionProviderId, ExecutionProvider>
> = Object.freeze(
  Object.fromEntries(
    providerIds.map((id) => [id, ORB_PROVIDER_MODULES[id].execution]),
  ) as Record<ExecutionProviderId, ExecutionProvider>,
);

/**
 * The Orb providers a person or workspace can connect their own account
 * for. A provider without a connector runs only on the deployment's
 * account.
 */
export const orbProviderConnectors: OrbProviderConnectors = Object.freeze(
  Object.fromEntries(
    providerIds.flatMap((id) => {
      const connector = ORB_PROVIDER_MODULES[id].connector;
      return connector === undefined ? [] : [[id, connector] as const];
    }),
  ),
);
