import {
  CreateDictationEndpoint,
  type DictationJob,
  GetDictationEndpoint,
} from "@dx/api";
import { ApiError, dxClient } from "../../../shared/api/client.js";

/**
 * The dictation calls, loaded with the first recording's upload so the
 * Thread page's first load does not carry their endpoints.
 */

/**
 * The route's own message for an error it sends on purpose; any other
 * failure reads as dictation failing. A cancel or timeout stays as it is.
 */
const dictationStep = async (
  run: () => Promise<DictationJob>,
): Promise<DictationJob> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof DOMException) throw cause;
    throw new Error(
      cause instanceof ApiError
        ? cause.hasValidatedPayload
          ? cause.message
          : "Dictation could not be completed."
        : "Dictation returned an invalid response.",
    );
  }
};

/** Uploads the recording as WAV and starts transcribing it. */
export const createDictation = (id: string, audio: Blob, signal: AbortSignal) =>
  dictationStep(() =>
    dxClient.call(
      CreateDictationEndpoint,
      { params: { id }, body: audio },
      { signal, headers: { "content-type": "audio/wav" } },
    ),
  );

/** The job of a dictation still processing. */
export const readDictation = (id: string, signal: AbortSignal) =>
  dictationStep(() =>
    dxClient.call(GetDictationEndpoint, { params: { id } }, { signal }),
  );
