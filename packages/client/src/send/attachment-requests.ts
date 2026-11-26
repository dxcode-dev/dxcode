import {
  CompleteAttachmentEndpoint,
  CreateAttachmentEndpoint,
  DeleteAttachmentEndpoint,
} from "@dx/api";
import { ApiError } from "../api-error.js";
import type { DxClient } from "../dx-client.js";
import type { AttachmentRequests } from "./attachment-upload.js";

/**
 * Core's attachment calls through a `DxClient`. A UI loads this with its
 * first upload, so a page's first load does not carry the endpoints.
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

export const attachmentRequests = (client: DxClient): AttachmentRequests => ({
  create: (file, signal) =>
    uploadStep(() =>
      client.call(
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
    ),
  complete: (id, parts, signal) =>
    uploadStep(() =>
      client.call(
        CompleteAttachmentEndpoint,
        { params: { id }, body: { parts } },
        { signal },
      ),
    ),
  remove: async (id) => {
    await client.call(DeleteAttachmentEndpoint, { params: { id } });
  },
});
