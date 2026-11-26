import { defineEndpoint } from "../http/endpoint.js";
import {
  BeginPersonalModelSubscriptionAuthorizationRequestSchema,
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  DisconnectPersonalModelSubscriptionRequestSchema,
  DisconnectPersonalModelSubscriptionResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
  PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  PersonalModelSubscriptionInUseResponseSchema,
  PersonalModelSubscriptionNotFoundResponseSchema,
  PersonalModelSubscriptionUnavailableResponseSchema,
  PollPersonalModelSubscriptionAuthorizationRequestSchema,
  PollPersonalModelSubscriptionAuthorizationResponseSchema,
  RefreshPersonalModelSubscriptionRequestSchema,
  RefreshPersonalModelSubscriptionResponseSchema,
} from "./model-subscriptions.js";

/**
 * The endpoints over `model-subscriptions.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const personalModelSubscriptionRefusals = [
  { status: 404, schema: PersonalModelSubscriptionNotFoundResponseSchema },
  {
    status: 403,
    schema: PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  },
  { status: 409, schema: PersonalModelSubscriptionInUseResponseSchema },
  { status: 503, schema: PersonalModelSubscriptionUnavailableResponseSchema },
];

const PersonalModelSubscriptionsPath =
  "/v1/settings/personal/model-routing/subscriptions";

export const ListPersonalModelSubscriptionsEndpoint = defineEndpoint({
  id: "modelSubscriptions.list",
  method: "GET",
  path: PersonalModelSubscriptionsPath,
  success: ListPersonalModelSubscriptionsResponseSchema,
  refusals: personalModelSubscriptionRefusals,
});

/** Starts a provider's device sign-in, such as `github-copilot`. */
export const BeginPersonalModelSubscriptionAuthorizationEndpoint =
  defineEndpoint({
    id: "modelSubscriptions.authorize",
    method: "POST",
    path: `${PersonalModelSubscriptionsPath}/:provider/authorize`,
    params: BeginPersonalModelSubscriptionAuthorizationRequestSchema,
    success: BeginPersonalModelSubscriptionAuthorizationResponseSchema,
    refusals: personalModelSubscriptionRefusals,
  });

export const PollPersonalModelSubscriptionAuthorizationEndpoint =
  defineEndpoint({
    id: "modelSubscriptions.pollAuthorization",
    method: "POST",
    path: `${PersonalModelSubscriptionsPath}/authorization/:authorizationId/poll`,
    params: PollPersonalModelSubscriptionAuthorizationRequestSchema,
    success: PollPersonalModelSubscriptionAuthorizationResponseSchema,
    refusals: personalModelSubscriptionRefusals,
  });

export const RefreshPersonalModelSubscriptionEndpoint = defineEndpoint({
  id: "modelSubscriptions.refresh",
  method: "POST",
  path: `${PersonalModelSubscriptionsPath}/connections/:connectionId/refresh`,
  params: RefreshPersonalModelSubscriptionRequestSchema,
  success: RefreshPersonalModelSubscriptionResponseSchema,
  refusals: personalModelSubscriptionRefusals,
});

export const DisconnectPersonalModelSubscriptionEndpoint = defineEndpoint({
  id: "modelSubscriptions.disconnect",
  method: "DELETE",
  path: `${PersonalModelSubscriptionsPath}/connections/:connectionId`,
  params: DisconnectPersonalModelSubscriptionRequestSchema,
  success: DisconnectPersonalModelSubscriptionResponseSchema,
  refusals: personalModelSubscriptionRefusals,
});
