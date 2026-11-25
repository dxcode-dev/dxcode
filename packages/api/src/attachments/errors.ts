import { Schema } from "effect";
import { errorResponse } from "../http/response.js";

/** The error answers of `/v1/attachments*`, in dx's envelope. */

/** 400: the create request does not decode. */
export const AttachmentInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "The attachment request is invalid.",
);
/** 404: no such attachment the caller may use. */
export const AttachmentNotFoundResponseSchema = errorResponse(
  "ATTACHMENT_NOT_FOUND",
  "Attachment not found.",
);
/** 400: complete names a different set of parts than the upload has. */
export const AttachmentPartsIncompleteResponseSchema = errorResponse(
  "ATTACHMENT_PARTS_INCOMPLETE",
  "The uploaded parts are incomplete.",
);
/** 400: the stored file's size is not the declared one; it was removed. */
export const AttachmentSizeMismatchResponseSchema = errorResponse(
  "ATTACHMENT_SIZE_MISMATCH",
  "The uploaded file has the wrong size.",
);
/** 409: a sent message keeps its files. */
export const AttachmentAlreadySentResponseSchema = errorResponse(
  "ATTACHMENT_ALREADY_SENT",
  "The attachment was already sent.",
);
/** 503: the deployment has no attachment storage. */
export const AttachmentsUnavailableResponseSchema = errorResponse(
  "ATTACHMENTS_UNAVAILABLE",
  "Attachments are unavailable.",
);
/** 503: storage failed while handling the request. */
export const AttachmentRequestFailedResponseSchema = errorResponse(
  "ATTACHMENT_REQUEST_FAILED",
  "The attachment request failed.",
);

/** Every error answer of `/v1/attachments`. */
export const AttachmentErrorResponseSchema = Schema.Union([
  AttachmentInvalidRequestResponseSchema,
  AttachmentNotFoundResponseSchema,
  AttachmentPartsIncompleteResponseSchema,
  AttachmentSizeMismatchResponseSchema,
  AttachmentAlreadySentResponseSchema,
  AttachmentsUnavailableResponseSchema,
  AttachmentRequestFailedResponseSchema,
]);
export type AttachmentErrorResponse = typeof AttachmentErrorResponseSchema.Type;
