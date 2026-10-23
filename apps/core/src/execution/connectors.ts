import type { OrbProviderConnectors } from "../plugins/execution/connector.js";
import { makeCloudflareConnector } from "./cloudflare/connector.js";
import { makeE2BConnector } from "./e2b/connector.js";

/** Cloudflare connections need a published public Orb image to copy. */
const cloudflare = makeCloudflareConnector();

/**
 * The Orb providers a person or workspace can connect their own account
 * for. A provider without a connector runs only on the deployment's
 * account.
 */
export const orbProviderConnectors: OrbProviderConnectors = Object.freeze({
  e2b: makeE2BConnector(),
  ...(cloudflare === undefined ? {} : { cloudflare }),
});
