import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * A person's progress through new-account onboarding, shared by their
 * devices: when they finished or skipped setup, finished the thread tour,
 * and hid the home page's setup checklist. Null until it happens; accounts
 * that predate onboarding have all three set.
 */
export const OnboardingDataSchema = Schema.Struct({
  setupFinishedAt: Schema.NullOr(Schema.String),
  tourFinishedAt: Schema.NullOr(Schema.String),
  checklistHiddenAt: Schema.NullOr(Schema.String),
});

export type OnboardingData = typeof OnboardingDataSchema.Type;

/** What `PUT /v1/onboarding` marks done: setup, the tour, or the checklist. */
export const OnboardingMilestoneSchema = Schema.Literals([
  "setup",
  "tour",
  "checklist",
]);

export type OnboardingMilestone = typeof OnboardingMilestoneSchema.Type;

/** `PUT /v1/onboarding`: marks one milestone done; earlier marks stay. */
export const UpdateOnboardingRequestSchema = Schema.Struct({
  done: OnboardingMilestoneSchema,
});

/** `GET` and `PUT /v1/onboarding`: the signed-in person's progress. */
export const OnboardingResponseSchema = successResponse(OnboardingDataSchema);

export const OnboardingInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const OnboardingPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export const OnboardingErrorResponseSchema = Schema.Union([
  OnboardingInvalidRequestResponseSchema,
  OnboardingPersistenceUnavailableResponseSchema,
]);
