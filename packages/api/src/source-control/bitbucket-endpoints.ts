import { defineEndpoint } from "../http/endpoint.js";
import {
  BeginBitbucketAuthorizationResponseSchema,
  BitbucketConnectionResponseSchema,
  BitbucketDisconnectResponseSchema,
  BitbucketForbiddenResponseSchema,
  BitbucketInvalidResponseSchema,
  BitbucketRepositoriesResponseSchema,
  BitbucketUnavailableResponseSchema,
} from "./bitbucket.js";

/** Every error answer the Bitbucket routes send. */
const bitbucketRefusals = [
  { status: 403, schema: BitbucketForbiddenResponseSchema },
  { status: 400, schema: BitbucketInvalidResponseSchema },
  { status: 503, schema: BitbucketUnavailableResponseSchema },
];

export const GetBitbucketConnectionEndpoint = defineEndpoint({
  id: "integrations.bitbucket.connection",
  summary: "Read the Bitbucket connection",
  method: "GET",
  path: "/v1/integrations/bitbucket/personal/connection",
  success: BitbucketConnectionResponseSchema,
  refusals: bitbucketRefusals,
});

export const ListBitbucketRepositoriesEndpoint = defineEndpoint({
  id: "integrations.bitbucket.repositories",
  summary: "List Bitbucket repositories",
  method: "GET",
  path: "/v1/integrations/bitbucket/personal/repositories",
  success: BitbucketRepositoriesResponseSchema,
  refusals: bitbucketRefusals,
});

export const BeginBitbucketAuthorizationEndpoint = defineEndpoint({
  id: "integrations.bitbucket.authorize",
  summary: "Start connecting Bitbucket",
  method: "POST",
  path: "/v1/integrations/bitbucket/personal/authorize",
  success: BeginBitbucketAuthorizationResponseSchema,
  successStatus: 201,
  refusals: bitbucketRefusals,
});

export const RefreshBitbucketConnectionEndpoint = defineEndpoint({
  id: "integrations.bitbucket.refresh",
  summary: "Refresh the Bitbucket connection",
  method: "POST",
  path: "/v1/integrations/bitbucket/personal/refresh",
  success: BitbucketConnectionResponseSchema,
  refusals: bitbucketRefusals,
});

export const DisconnectBitbucketEndpoint = defineEndpoint({
  id: "integrations.bitbucket.disconnect",
  summary: "Disconnect Bitbucket",
  method: "DELETE",
  path: "/v1/integrations/bitbucket/personal/connection",
  success: BitbucketDisconnectResponseSchema,
  refusals: bitbucketRefusals,
});
