import { defineEndpoint } from "../http/endpoint.js";
import {
  DictationAdmissionRefusals,
  DictationParamsSchema,
  DictationSessionRefusals,
} from "./dictation-stream-endpoints.js";
import {
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
