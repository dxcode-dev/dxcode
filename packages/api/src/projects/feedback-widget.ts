import {
  FeedbackWidgetClientId,
  FeedbackWidgetComment,
  FeedbackWidgetOrigin,
  MAX_FEEDBACK_WIDGET_COMMENTS,
  ProjectId,
  ThreadId,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * A Project's Feedback Widget as Project Settings shows it. `scriptUrl` is
 * the tag's address on this deployment, so each host (local, a preview,
 * staging, production, or a self-hosted dx) gives its own.
 */
export const FeedbackWidgetDataSchema = Schema.Struct({
  enabled: Schema.Boolean,
  clientId: Schema.optional(FeedbackWidgetClientId),
  scriptUrl: Schema.optional(Schema.String),
  allowedOrigins: Schema.Array(FeedbackWidgetOrigin),
});

export const FeedbackWidgetParamsSchema = Schema.Struct({
  projectId: ProjectId,
});

/** An address as typed; dx keeps only its origin. */
export const FeedbackWidgetOriginRequestSchema = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(2000)),
});

export const GetFeedbackWidgetResponseSchema = successResponse(
  FeedbackWidgetDataSchema,
);

export const FeedbackWidgetInvalidRequestResponseSchema = errorResponse(
  "INVALID_REQUEST",
  "Request validation failed.",
);

export const FeedbackWidgetInvalidOriginResponseSchema = errorResponse(
  "INVALID_ORIGIN",
  "Enter an https address, or http on localhost, 127.0.0.1, or [::1].",
);

export const FeedbackWidgetTooManyOriginsResponseSchema = errorResponse(
  "TOO_MANY_ORIGINS",
  "A Project can allow at most 20 origins.",
);

export const FeedbackWidgetNotFoundResponseSchema = errorResponse(
  "PROJECT_NOT_FOUND",
  "Project not found.",
);

export const FeedbackWidgetForbiddenResponseSchema = errorResponse(
  "PROJECT_MANAGE_REQUIRED",
  "Only the project's creator or a workspace admin can change its Feedback Widget.",
);

export const FeedbackWidgetDisabledResponseSchema = errorResponse(
  "FEEDBACK_WIDGET_FEATURE_DISABLED",
  "Turn on Feedback Widget in Experimental Features.",
);

export const FeedbackWidgetPersistenceUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Persistence is temporarily unavailable.",
);

/** What the widget panel sends when someone chooses Start in Orb. */
export const FeedbackWidgetSendRequestSchema = Schema.Struct({
  comments: Schema.Array(FeedbackWidgetComment).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FEEDBACK_WIDGET_COMMENTS),
  ),
});

export const FeedbackWidgetSendDataSchema = Schema.Struct({
  threadId: ThreadId,
  threadUrl: Schema.String,
});

export type FeedbackWidgetData = typeof FeedbackWidgetDataSchema.Type;
export type GetFeedbackWidgetResponse =
  typeof GetFeedbackWidgetResponseSchema.Encoded;
export type FeedbackWidgetSendRequest =
  typeof FeedbackWidgetSendRequestSchema.Encoded;

/** A Project on this dx whose widget the person can show on dx. */
export const FeedbackWidgetProjectOptionSchema = Schema.Struct({
  projectId: ProjectId,
  projectLabel: Schema.String,
  scriptUrl: Schema.String,
});

/**
 * Personal Settings: the widget this dx app loads for the person, from this
 * dx or another dx host, and the Projects on this dx they can choose.
 */
export const PersonalFeedbackWidgetEmbedDataSchema = Schema.Struct({
  scriptUrl: Schema.optional(Schema.String),
  projects: Schema.Array(FeedbackWidgetProjectOptionSchema),
});

/** A script tag or address; null stops loading the widget. */
export const UpdatePersonalFeedbackWidgetEmbedRequestSchema = Schema.Struct({
  scriptUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
});

export const GetPersonalFeedbackWidgetEmbedResponseSchema = successResponse(
  PersonalFeedbackWidgetEmbedDataSchema,
);

export const FeedbackWidgetInvalidScriptResponseSchema = errorResponse(
  "INVALID_SCRIPT",
  "Paste the Feedback Widget script tag from a project's settings on a dx host.",
);

export type PersonalFeedbackWidgetEmbedData =
  typeof PersonalFeedbackWidgetEmbedDataSchema.Type;
