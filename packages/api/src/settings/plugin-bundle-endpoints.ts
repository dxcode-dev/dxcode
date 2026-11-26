import {
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleRejectedResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PluginProposalDecidedResponseSchema,
} from "./plugin-bundles.js";

/**
 * Plugin bundle endpoints. Apart from `plugin-bundles.ts`, whose schemas the
 * Thread page loads on first load, so these definitions stay off it.
 */

/** What every plugin bundle and catalog route refuses, with Core's status. */
export const pluginBundleRefusals = [
  { status: 400, schema: PluginBundleRejectedResponseSchema },
  { status: 502, schema: PluginBundleSourceUnavailableResponseSchema },
  { status: 403, schema: PluginBundlesForbiddenResponseSchema },
  { status: 404, schema: PluginBundleNotFoundResponseSchema },
  { status: 409, schema: PluginProposalDecidedResponseSchema },
  { status: 409, schema: PluginBundleIntegrityConflictResponseSchema },
  { status: 503, schema: PluginBundlesUnavailableResponseSchema },
];
