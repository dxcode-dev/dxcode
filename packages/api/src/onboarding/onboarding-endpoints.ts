import { defineEndpoint } from "../http/endpoint.js";
import {
  OnboardingInvalidRequestResponseSchema,
  OnboardingPersistenceUnavailableResponseSchema,
  OnboardingResponseSchema,
  UpdateOnboardingRequestSchema,
} from "./onboarding.js";

/**
 * The onboarding endpoints, apart from their schemas: a module that defines
 * endpoints ships whole with whatever imports it (wiki/headless-client.md).
 */

export const GetOnboardingEndpoint = defineEndpoint({
  id: "onboarding.get",
  method: "GET",
  path: "/v1/onboarding",
  success: OnboardingResponseSchema,
  refusals: [
    { status: 503, schema: OnboardingPersistenceUnavailableResponseSchema },
  ],
});

export const UpdateOnboardingEndpoint = defineEndpoint({
  id: "onboarding.update",
  method: "PUT",
  path: "/v1/onboarding",
  body: UpdateOnboardingRequestSchema,
  success: OnboardingResponseSchema,
  refusals: [
    { status: 400, schema: OnboardingInvalidRequestResponseSchema },
    { status: 503, schema: OnboardingPersistenceUnavailableResponseSchema },
  ],
});
