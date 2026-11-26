import {
  type AttachmentPartResponse,
  CompleteAttachmentEndpoint,
  CreateAttachmentEndpoint,
} from "@dx/api";
import { ApiError, dxClient } from "../../shared/api/client.js";

/**
 * The attachment calls, loaded with the first upload so the Thread page's
 * first load does not carry their endpoints.
 */

const FAILED = "The file could not be uploaded.";

/**
 * The route's own message for an error it sends on purpose; any other
 * failure reads as the upload failing. A cancel stays an AbortError.
 */
const uploadStep = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new Error(
      cause instanceof ApiError && cause.hasValidatedPayload
        ? cause.message
        : FAILED,
    );
  }
};

export const createAttachment = (file: File, signal: AbortSignal) =>
  uploadStep(() =>
    dxClient.call(
      CreateAttachmentEndpoint,
      {
        body: {
          filename: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        },
      },
      { signal },
    ),
  );

export const completeAttachment = (
  id: string,
  parts: ReadonlyArray<AttachmentPartResponse>,
  signal: AbortSignal,
) =>
  uploadStep(() =>
    dxClient.call(
      CompleteAttachmentEndpoint,
      { params: { id }, body: { parts } },
      { signal },
    ),
  );
