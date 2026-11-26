import { defineEndpoint, NoContentSchema } from "../http/endpoint.js";
import {
  DictationAdmissionRefusals,
  DictationParamsSchema,
  DictationSessionRefusals,
} from "./dictation-stream-endpoints.js";
import {
  DictationFailedResponseSchema,
  DictationForbiddenResponseSchema,
  DictationInvalidAudioResponseSchema,
  DictationInvalidRequestResponseSchema,
  DictationNotFoundResponseSchema,
} from "./errors.js";
import { DictationJobSchema } from "./index.js";

/**
 * The dictation endpoints, apart from the schemas in `index.ts`, which the
 * composer loads with the Thread page.
 */

/**
 * Uploads a recording as canonical 16 kHz mono WAV (`audio/wav`) and
 * transcribes it: the job, `completed` at once or `processing` (202) for
 * a read that follows.
 */
export const CreateDictationEndpoint = defineEndpoint({
  id: "dictation.create",
  summary: "Transcribe a dictation recording",
  method: "POST",
  path: "/v1/dictation/:id",
  params: DictationParamsSchema,
  upload: "bytes",
  success: DictationJobSchema,
  refusals: [
    { status: 400, schema: DictationInvalidRequestResponseSchema },
    { status: 400, schema: DictationInvalidAudioResponseSchema },
    ...DictationAdmissionRefusals,
    ...DictationSessionRefusals,
  ],
});

/** A dictation's job, while it is processing. */
export const GetDictationEndpoint = defineEndpoint({
  id: "dictation.get",
  summary: "Read a dictation job's state",
  method: "GET",
  path: "/v1/dictation/:id",
  params: DictationParamsSchema,
  success: DictationJobSchema,
  refusals: [
    { status: 404, schema: DictationNotFoundResponseSchema },
    ...DictationSessionRefusals,
  ],
});

/** Cancels a dictation job; an unknown or finished one answers the same. */
export const CancelDictationEndpoint = defineEndpoint({
  id: "dictation.cancel",
  summary: "Cancel a dictation job",
  method: "DELETE",
  path: "/v1/dictation/:id",
  params: DictationParamsSchema,
  success: NoContentSchema,
  answer: "none",
  successStatus: 204,
  refusals: [
    { status: 403, schema: DictationForbiddenResponseSchema },
    { status: 500, schema: DictationFailedResponseSchema },
  ],
});
