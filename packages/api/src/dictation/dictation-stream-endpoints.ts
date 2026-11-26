import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  DictationBalanceExhaustedResponseSchema,
  DictationBrowserSessionRequiredResponseSchema,
  DictationBusyResponseSchema,
  DictationFailedResponseSchema,
  DictationInvalidRequestResponseSchema,
  DictationNotFoundResponseSchema,
  DictationUnavailableResponseSchema,
} from "./errors.js";

/**
 * The live dictation socket, apart from the other dictation endpoints: the
 * composer opens it on the Thread page's first load.
 */

/** The browser's ID for one dictation, a UUID. */
export const DictationIdSchema = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ),
);

export const DictationParamsSchema = Schema.Struct({ id: DictationIdSchema });

/** Speech refused this person before any work: off, or out of credit. */
export const DictationAdmissionRefusals = [
  { status: 409, schema: DictationUnavailableResponseSchema },
  { status: 402, schema: DictationBalanceExhaustedResponseSchema },
  { status: 429, schema: DictationBusyResponseSchema },
] as const;

export const DictationSessionRefusals = [
  { status: 403, schema: DictationBrowserSessionRequiredResponseSchema },
  { status: 500, schema: DictationFailedResponseSchema },
] as const;

/**
 * The live dictation socket (`DICTATION_STREAM_SUBPROTOCOL`): a WebSocket
 * upgrade, so a client opens `endpointPath` of it and never `call`s it.
 */
export const DictationStreamEndpoint = defineEndpoint({
  id: "dictation.stream",
  summary: "Stream dictation audio and receive its transcript (WebSocket)",
  method: "GET",
  path: "/v1/dictation/:id/stream",
  params: DictationParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    { status: 404, schema: DictationNotFoundResponseSchema },
    { status: 400, schema: DictationInvalidRequestResponseSchema },
    ...DictationAdmissionRefusals,
    ...DictationSessionRefusals,
  ],
});
