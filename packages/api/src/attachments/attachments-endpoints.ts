import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  AttachmentInvalidRequestResponseSchema,
  AttachmentNotFoundResponseSchema,
  AttachmentPartsIncompleteResponseSchema,
  AttachmentRequestFailedResponseSchema,
  AttachmentSizeMismatchResponseSchema,
  AttachmentsUnavailableResponseSchema,
} from "./errors.js";
import {
  AttachmentDataSchema,
  AttachmentIdSchema,
  CompleteAttachmentRequestSchema,
  CreateAttachmentRequestSchema,
  CreateAttachmentResponseSchema,
} from "./index.js";

/**
 * The attachment endpoints, apart from the schemas in `index.ts`, which the
 * composer loads with the Thread page.
 */

/** Storage is missing or failed: every attachment route can answer these. */
const storageRefusals = [
  { status: 503, schema: AttachmentsUnavailableResponseSchema },
  { status: 503, schema: AttachmentRequestFailedResponseSchema },
] as const;

export const AttachmentParamsSchema = Schema.Struct({ id: AttachmentIdSchema });

/** Starts an upload: where to send each part. Core answers 201. */
export const CreateAttachmentEndpoint = defineEndpoint({
  id: "attachments.create",
  summary: "Start an attachment upload",
  method: "POST",
  path: "/v1/attachments",
  body: CreateAttachmentRequestSchema,
  success: CreateAttachmentResponseSchema,
  successStatus: 201,
  refusals: [
    { status: 400, schema: AttachmentInvalidRequestResponseSchema },
    ...storageRefusals,
  ],
});

/** Finishes an upload with its parts' ETags: the stored attachment. */
export const CompleteAttachmentEndpoint = defineEndpoint({
  id: "attachments.complete",
  summary: "Finish an attachment upload",
  method: "POST",
  path: "/v1/attachments/:id/complete",
  params: AttachmentParamsSchema,
  body: CompleteAttachmentRequestSchema,
  success: AttachmentDataSchema,
  refusals: [
    { status: 400, schema: AttachmentInvalidRequestResponseSchema },
    { status: 404, schema: AttachmentNotFoundResponseSchema },
    { status: 400, schema: AttachmentPartsIncompleteResponseSchema },
    { status: 400, schema: AttachmentSizeMismatchResponseSchema },
    ...storageRefusals,
  ],
});

/** `?download=1` asks for the file as a download rather than inline. */
export const AttachmentFileQuerySchema = Schema.Struct({
  download: Schema.optional(Schema.Literal("1")),
});

/**
 * An attachment's bytes: a redirect to a short-lived storage URL, for an
 * `<img src>` or a download link built with `endpointPath`.
 */
export const GetAttachmentFileEndpoint = defineEndpoint({
  id: "attachments.file",
  summary: "Download an attachment",
  method: "GET",
  path: "/v1/attachments/:id",
  params: AttachmentParamsSchema,
  query: AttachmentFileQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    { status: 404, schema: AttachmentNotFoundResponseSchema },
    ...storageRefusals,
  ],
});

/** The same bytes under the file's name, as `attachmentPath` links to it. */
export const GetNamedAttachmentFileEndpoint = defineEndpoint({
  id: "attachments.namedFile",
  summary: "Download an attachment under its file name",
  method: "GET",
  path: "/v1/attachments/:id/:filename",
  params: Schema.Struct({ id: AttachmentIdSchema, filename: Schema.String }),
  query: AttachmentFileQuerySchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    { status: 404, schema: AttachmentNotFoundResponseSchema },
    ...storageRefusals,
  ],
});
