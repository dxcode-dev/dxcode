import { Schema } from "effect";
import { errorResponse } from "../http/response.js";

/**
 * 409: speech is not installed, is disabled for this user, or resolves no
 * provider. Dictation fails closed; the composer hides its microphone.
 */
export const DictationUnavailableResponseSchema = errorResponse(
  "DICTATION_UNAVAILABLE",
  "Dictation is not available.",
);
/** 402: the deployment's billing refuses the call; the message says why. */
export const DictationBalanceExhaustedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("DICTATION_BALANCE_EXHAUSTED"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});
/** 429: another dictation of this person's is running. */
export const DictationBusyResponseSchema = errorResponse(
  "DICTATION_BUSY",
  "Dictation is temporarily unavailable.",
);
/** 400: the dictation ID is not a UUID. */
export const DictationInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Invalid request.",
);
/** 400: the recording is not canonical 16 kHz mono 16-bit WAV. */
export const DictationInvalidAudioResponseSchema = errorResponse(
  "DICTATION_INVALID_AUDIO",
  "Invalid WAV audio.",
);
/** 404: no such job, or not a socket upgrade on the stream route. */
export const DictationNotFoundResponseSchema = errorResponse(
  "NOT_FOUND",
  "Not found.",
);
/** 403: dictation needs a browser session. */
export const DictationBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "Dictation could not be completed.",
);
/** 403: cancel needs a browser session. */
export const DictationForbiddenResponseSchema = errorResponse(
  "FORBIDDEN",
  "Forbidden.",
);
/** 500: dictation failed inside dx or at the provider. */
export const DictationFailedResponseSchema = errorResponse(
  "DICTATION_FAILED",
  "Dictation could not be completed.",
);

/** Every error answer of `/v1/dictation/:id` and its stream. */
export const DictationErrorResponseSchema = Schema.Union([
  DictationUnavailableResponseSchema,
  DictationBalanceExhaustedResponseSchema,
  DictationBusyResponseSchema,
  DictationInvalidRequestResponseSchema,
  DictationInvalidAudioResponseSchema,
  DictationNotFoundResponseSchema,
  DictationBrowserSessionRequiredResponseSchema,
  DictationForbiddenResponseSchema,
  DictationFailedResponseSchema,
]);
export type DictationErrorResponse = typeof DictationErrorResponseSchema.Type;
