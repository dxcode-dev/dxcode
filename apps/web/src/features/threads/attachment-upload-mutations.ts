import { attachmentRequests } from "@dx/client";
import { dxClient } from "../../shared/api/client.js";

/**
 * The attachment calls through the web's client, loaded with the first
 * upload so the Thread page's first load does not carry their endpoints.
 */
export const attachmentUploadRequests = attachmentRequests(dxClient);
