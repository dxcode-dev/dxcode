import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { IntegrationsPolicyDeniedResponseSchema } from "../settings/integrations.js";
import {
  BeginGitHubCeremonyResponseSchema,
  BeginGitHubInstallationResponseSchema,
  GitHubCeremonyQuerySchema,
  GitHubControlPlaneForbiddenResponseSchema,
  GitHubControlPlaneInvalidResponseSchema,
  GitHubControlPlaneUnavailableResponseSchema,
  GitHubDisconnectResponseSchema,
  ListGitHubGrantsResponseSchema,
} from "./github.js";

/** Every error answer the GitHub control-plane routes send. */
const gitHubControlPlaneRefusals = [
  { status: 403, schema: GitHubControlPlaneForbiddenResponseSchema },
  { status: 400, schema: GitHubControlPlaneInvalidResponseSchema },
  { status: 503, schema: GitHubControlPlaneUnavailableResponseSchema },
  { status: 403, schema: IntegrationsPolicyDeniedResponseSchema },
];

export const ListGitHubGrantsEndpoint = defineEndpoint({
  id: "integrations.github.listGrants",
  summary: "List GitHub grants",
  method: "GET",
  path: "/v1/integrations/github/personal/grants",
  success: ListGitHubGrantsResponseSchema,
  refusals: gitHubControlPlaneRefusals,
});

export const BeginGitHubAuthorizationEndpoint = defineEndpoint({
  id: "integrations.github.authorize",
  summary: "Start connecting GitHub",
  method: "POST",
  path: "/v1/integrations/github/personal/authorize",
  query: GitHubCeremonyQuerySchema,
  success: BeginGitHubCeremonyResponseSchema,
  successStatus: 201,
  refusals: gitHubControlPlaneRefusals,
});

export const BeginGitHubInstallationEndpoint = defineEndpoint({
  id: "integrations.github.install",
  summary: "Start installing the GitHub App",
  method: "POST",
  path: "/v1/integrations/github/personal/install",
  query: GitHubCeremonyQuerySchema,
  success: BeginGitHubInstallationResponseSchema,
  successStatus: 201,
  refusals: gitHubControlPlaneRefusals,
});

export const DisconnectGitHubEndpoint = defineEndpoint({
  id: "integrations.github.disconnect",
  summary: "Remove a GitHub grant",
  method: "DELETE",
  path: "/v1/integrations/github/personal/grants/:grantId",
  params: Schema.Struct({ grantId: Schema.String }),
  success: GitHubDisconnectResponseSchema,
  refusals: gitHubControlPlaneRefusals,
});
