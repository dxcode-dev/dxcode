import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import { errorResponse } from "../http/response.js";
import { ThreadAutomationsResponseSchema } from "./automations.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/**
 * Reading a Thread's automations, which the Thread page does on first load,
 * apart from `automations.ts`'s schemas. Changing them is in
 * `automation-change-endpoints.ts`.
 */

/** The deployment's database could not be read or written. */
export const AutomationsPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);
/** Only the Thread's owner sees its automations; anyone else learns nothing. */
export const AutomationsThreadNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "Thread not found.",
);

export const ThreadAutomationsParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

export const automationsRefusals = [
  ...ThreadAccessRefusals,
  { status: 503, schema: AutomationsPersistenceUnavailableResponseSchema },
  { status: 404, schema: AutomationsThreadNotFoundResponseSchema },
] as const;

export const GetThreadAutomationsEndpoint = defineEndpoint({
  id: "threads.automations.get",
  method: "GET",
  path: "/v1/threads/:threadId/automations",
  params: ThreadAutomationsParamsSchema,
  success: ThreadAutomationsResponseSchema,
  refusals: automationsRefusals,
});
