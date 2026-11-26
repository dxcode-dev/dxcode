import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  OrbProviderCredentialsRejectedResponseSchema,
  OrbProviderForbiddenResponseSchema,
  OrbProviderInvalidRequestResponseSchema,
  OrbProviderListQuerySchema,
  OrbProviderListResponseSchema,
  OrbProviderParamsSchema,
  OrbProviderUnavailableResponseSchema,
  SetOrbProviderConnectionRequestSchema,
  SetOrbProviderPolicyRequestSchema,
  WorkspaceOrbProviderParamsSchema,
} from "./orb-providers.js";

/**
 * The endpoints over `orb-providers.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const orbProviderRefusals = [
  { status: 400, schema: OrbProviderInvalidRequestResponseSchema },
  { status: 400, schema: OrbProviderCredentialsRejectedResponseSchema },
  { status: 403, schema: OrbProviderForbiddenResponseSchema },
  { status: 503, schema: OrbProviderUnavailableResponseSchema },
];

const OrbProvidersPersonalPath = "/v1/settings/personal/orb-providers";
const OrbProvidersWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/orb-providers";

export const ListPersonalOrbProvidersEndpoint = defineEndpoint({
  id: "orbProviders.personal.list",
  method: "GET",
  path: `${OrbProvidersPersonalPath}`,
  query: OrbProviderListQuerySchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const ListWorkspaceOrbProvidersEndpoint = defineEndpoint({
  id: "orbProviders.workspace.list",
  method: "GET",
  path: `${OrbProvidersWorkspacePath}`,
  params: WorkspaceOrbProviderParamsSchema,
  query: OrbProviderListQuerySchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const SetPersonalOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.personal.setConnection",
  method: "PUT",
  path: `${OrbProvidersPersonalPath}/:providerId/connection`,
  params: OrbProviderParamsSchema,
  body: SetOrbProviderConnectionRequestSchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const SetWorkspaceOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.workspace.setConnection",
  method: "PUT",
  path: `${OrbProvidersWorkspacePath}/:providerId/connection`,
  params: Schema.Struct({
    ...WorkspaceOrbProviderParamsSchema.fields,
    ...OrbProviderParamsSchema.fields,
  }),
  body: SetOrbProviderConnectionRequestSchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const RetryPersonalOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.personal.retryConnection",
  method: "POST",
  path: `${OrbProvidersPersonalPath}/:providerId/connection/retry`,
  params: OrbProviderParamsSchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const RetryWorkspaceOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.workspace.retryConnection",
  method: "POST",
  path: `${OrbProvidersWorkspacePath}/:providerId/connection/retry`,
  params: Schema.Struct({
    ...WorkspaceOrbProviderParamsSchema.fields,
    ...OrbProviderParamsSchema.fields,
  }),
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const DeletePersonalOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.personal.deleteConnection",
  method: "DELETE",
  path: `${OrbProvidersPersonalPath}/:providerId/connection`,
  params: OrbProviderParamsSchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const DeleteWorkspaceOrbProviderConnectionEndpoint = defineEndpoint({
  id: "orbProviders.workspace.deleteConnection",
  method: "DELETE",
  path: `${OrbProvidersWorkspacePath}/:providerId/connection`,
  params: Schema.Struct({
    ...WorkspaceOrbProviderParamsSchema.fields,
    ...OrbProviderParamsSchema.fields,
  }),
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});

export const SetWorkspaceOrbProviderPolicyEndpoint = defineEndpoint({
  id: "orbProviders.workspace.setPolicy",
  method: "PUT",
  path: `${OrbProvidersWorkspacePath}/policy`,
  params: WorkspaceOrbProviderParamsSchema,
  body: SetOrbProviderPolicyRequestSchema,
  success: OrbProviderListResponseSchema,
  refusals: orbProviderRefusals,
});
