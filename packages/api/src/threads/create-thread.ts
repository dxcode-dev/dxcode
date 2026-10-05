import {
  ProjectId,
  RunnerProfileId,
  ThreadId,
  ThreadModelSelection,
  ThreadTitle,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse } from "../http/response.js";
import { ThreadDetailDataSchema } from "./thread-data.js";

// Mirrors Flue's public DeliveredAttachment contract. Flue applies this
// per-image base64 limit on every delivery surface. dx also limits a message
// to ten images, without a combined-size, text, or request-size cap.
export const FLUE_MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 10;

const base64Character = (code: number) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;

const base64Whitespace = (code: number) =>
  code === 9 || code === 10 || code === 12 || code === 13 || code === 32;

const validBase64ImageData = (data: string) => {
  let characters = 0;
  let padding = 0;
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (base64Whitespace(code)) continue;
    if (code === 61) {
      padding++;
      continue;
    }
    if (padding > 0 || !base64Character(code)) return false;
    characters++;
  }
  if (padding === 0) return characters % 4 !== 1;
  return (
    padding <= 2 &&
    (characters + padding) % 4 === 0 &&
    characters % 4 === 4 - padding
  );
};

const InitialThreadImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String.check(
    Schema.isMaxLength(FLUE_MAX_IMAGE_DATA_LENGTH),
    Schema.makeFilter((data) =>
      validBase64ImageData(data)
        ? undefined
        : "Image data must be base64 encoded.",
    ),
  ),
  mimeType: Schema.String,
  filename: Schema.optional(Schema.String),
});

export const InitialThreadMessageSchema = Schema.Struct({
  body: Schema.String,
  attachments: Schema.Array(InitialThreadImageSchema).check(
    Schema.isMaxLength(MAX_IMAGES_PER_MESSAGE),
  ),
}).check(
  Schema.makeFilter((message) => {
    if (!message.body.trim() && message.attachments.length === 0)
      return {
        path: ["body"],
        issue: "Initial messages need text or an attachment.",
      };
    return undefined;
  }),
);

export const CreateThreadRequestSchema = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  runnerProfileId: Schema.optional(RunnerProfileId),
  title: Schema.optional(ThreadTitle),
  selection: Schema.optional(ThreadModelSelection),
  threadId: Schema.optional(ThreadId),
  initialMessage: Schema.optional(InitialThreadMessageSchema),
}).check(
  Schema.makeFilter((request) =>
    request.initialMessage === undefined && request.threadId === undefined
      ? undefined
      : request.initialMessage !== undefined && request.threadId !== undefined
        ? undefined
        : {
            path:
              request.initialMessage === undefined
                ? ["initialMessage"]
                : ["threadId"],
            issue:
              "Initial message admission requires a stable Thread identifier.",
          },
  ),
);

export const CreateThreadResponseSchema = Schema.Struct({
  status: Schema.Literal("success"),
  data: ThreadDetailDataSchema,
  initialSubmission: Schema.optional(
    Schema.Struct({
      submissionId: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
});

export const CreateThreadInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const CreateThreadProjectNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);

export const CreateThreadProjectlessForbiddenResponseSchema = errorResponse(
  "PROJECT_CREATION_FORBIDDEN",
  "Workspace policy does not allow this project.",
);

export const CreateThreadRunnerUnavailableResponseSchema = errorResponse(
  "RUNNER_PROFILE_UNAVAILABLE",
  "The selected runner profile is unavailable.",
);

/**
 * The Orb runs on the person's or workspace's own key, whose template is
 * still building (or failed) in its account. Never retried on another key.
 */
export const CreateThreadOrbUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("ORB_UNAVAILABLE"),
    message: Schema.Literal("The selected Orb is not available."),
    requestId: Schema.String,
    reason: Schema.Literals(["template-building", "template-failed"]),
  }),
});

export const CreateThreadPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

export const CreateThreadModelRouteUnavailableResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("MODEL_NOT_SERVED"),
    message: Schema.Literal("The selected model is not currently served."),
    requestId: Schema.String,
    model: Schema.String,
    reason: Schema.Literals(["no-connection", "disabled", "unknown-model"]),
  }),
});

export const CreateThreadInitialAdmissionUnavailableResponseSchema =
  errorResponse(
    "INITIAL_ADMISSION_UNAVAILABLE",
    "The initial prompt could not be accepted. Please retry.",
  );

export const CreateThreadPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal("Workspace policy does not allow this Thread."),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export type CreateThreadResponse = typeof CreateThreadResponseSchema.Encoded;
export type CreateThreadInvalidRequestResponse =
  typeof CreateThreadInvalidRequestResponseSchema.Type;
export type CreateThreadProjectNotFoundResponse =
  typeof CreateThreadProjectNotFoundResponseSchema.Type;
export type CreateThreadPersistenceUnavailableResponse =
  typeof CreateThreadPersistenceUnavailableResponseSchema.Type;
export type InitialThreadMessage = typeof InitialThreadMessageSchema.Type;
