import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const BitbucketConnectionResponseSchema = successResponse(
  Schema.Struct({
    configured: Schema.Boolean,
    connection: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        accountName: Schema.String,
        status: Schema.Literals([
          "active",
          "reauthorization-required",
          "disconnected",
        ]),
      }),
    ),
  }),
);
export const BeginBitbucketAuthorizationResponseSchema = successResponse(
  Schema.Struct({ authorizationUrl: Schema.String }),
);
export const BitbucketDisconnectResponseSchema = successResponse(
  Schema.Struct({ localAccessStopped: Schema.Literal(true) }),
);
export const BitbucketRepositoriesResponseSchema = successResponse(
  Schema.Struct({
    connectionId: Schema.String,
    repositories: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        workspaceId: Schema.String,
        fullName: Schema.String,
        webUrl: Schema.String,
        cloneUrl: Schema.String,
        defaultBranch: Schema.String,
        visibility: Schema.Literals(["public", "private"]),
        archived: Schema.Boolean,
      }),
    ),
  }),
);
export const BitbucketUnavailableResponseSchema = errorResponse(
  "BITBUCKET_UNAVAILABLE",
  "Bitbucket is temporarily unavailable. Retry without disconnecting.",
);
export const BitbucketInvalidResponseSchema = errorResponse(
  "BITBUCKET_INVALID",
  "The Bitbucket request is invalid or expired. Start again.",
);
export const BitbucketForbiddenResponseSchema = errorResponse(
  "BITBUCKET_FORBIDDEN",
  "Bitbucket access is unavailable. Reconnect or check repository permissions.",
);
