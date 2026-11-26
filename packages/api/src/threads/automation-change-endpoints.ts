import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import {
  ThreadAutomationsResponseSchema,
  UpdateAutomationRequestSchema,
} from "./automations.js";
import {
  AutomationsPersistenceUnavailableResponseSchema,
  AutomationsThreadNotFoundResponseSchema,
  automationsRefusals,
  ThreadAutomationsParamsSchema,
} from "./automations-endpoints.js";

/**
 * Pausing, resuming, and deleting automations, and every automation error
 * answer, apart from the endpoint the Thread page reads on first load.
 */

/** `PUT /v1/settings/personal/time-zone` named no IANA zone dx knows. */
export const UpdateTimeZoneInvalidResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Unknown time zone.",
);

/** A pause or resume without `enabled`. */
export const UpdateAutomationInvalidResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Send enabled.",
);
export const AutomationScheduleNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "Schedule not found.",
);
export const AutomationSubscriptionNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "Subscription not found.",
);

/** Every error answer the automation and time zone routes send. */
export const AutomationErrorResponseSchema = Schema.Union([
  AutomationsPersistenceUnavailableResponseSchema,
  AutomationsThreadNotFoundResponseSchema,
  UpdateAutomationInvalidResponseSchema,
  AutomationScheduleNotFoundResponseSchema,
  AutomationSubscriptionNotFoundResponseSchema,
  UpdateTimeZoneInvalidResponseSchema,
]);

export const ThreadGitHubSubscriptionParamsSchema = Schema.Struct({
  threadId: ThreadId,
  id: Schema.String,
});

export const UpdateThreadScheduleEndpoint = defineEndpoint({
  id: "threads.automations.updateSchedule",
  method: "PATCH",
  path: "/v1/threads/:threadId/automations/schedule",
  params: ThreadAutomationsParamsSchema,
  body: UpdateAutomationRequestSchema,
  success: ThreadAutomationsResponseSchema,
  refusals: [
    ...automationsRefusals,
    { status: 400, schema: UpdateAutomationInvalidResponseSchema },
    { status: 404, schema: AutomationScheduleNotFoundResponseSchema },
  ],
});

export const DeleteThreadScheduleEndpoint = defineEndpoint({
  id: "threads.automations.deleteSchedule",
  method: "DELETE",
  path: "/v1/threads/:threadId/automations/schedule",
  params: ThreadAutomationsParamsSchema,
  success: ThreadAutomationsResponseSchema,
  refusals: [
    ...automationsRefusals,
    { status: 404, schema: AutomationScheduleNotFoundResponseSchema },
  ],
});

export const UpdateThreadGitHubSubscriptionEndpoint = defineEndpoint({
  id: "threads.automations.updateGitHubSubscription",
  method: "PATCH",
  path: "/v1/threads/:threadId/automations/github/:id",
  params: ThreadGitHubSubscriptionParamsSchema,
  body: UpdateAutomationRequestSchema,
  success: ThreadAutomationsResponseSchema,
  refusals: [
    ...automationsRefusals,
    { status: 400, schema: UpdateAutomationInvalidResponseSchema },
    { status: 404, schema: AutomationSubscriptionNotFoundResponseSchema },
  ],
});

export const DeleteThreadGitHubSubscriptionEndpoint = defineEndpoint({
  id: "threads.automations.deleteGitHubSubscription",
  method: "DELETE",
  path: "/v1/threads/:threadId/automations/github/:id",
  params: ThreadGitHubSubscriptionParamsSchema,
  success: ThreadAutomationsResponseSchema,
  refusals: [
    ...automationsRefusals,
    { status: 404, schema: AutomationSubscriptionNotFoundResponseSchema },
  ],
});
