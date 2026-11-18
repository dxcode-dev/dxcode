import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** Whether the signed-in person administers this deployment. */
export const DeploymentAdminStatusResponseSchema = successResponse(
  Schema.Struct({ admin: Schema.Boolean }),
);

export type DeploymentAdminStatusResponse =
  typeof DeploymentAdminStatusResponseSchema.Type;

export const DeploymentAdminForbiddenResponseSchema = errorResponse(
  "DEPLOYMENT_ADMIN_REQUIRED",
  "Only deployment administrators can do this.",
);

/**
 * `POST /v1/deployment-admin/users/:userId/username-change/reset`: gives a
 * person their one username change back, for support cases.
 */
export const ResetUsernameChangeResponseSchema = successResponse(
  Schema.Struct({
    userId: Schema.String,
    username: Schema.String,
    usernameChangeAvailable: Schema.Boolean,
  }),
);

export const DeploymentAdminUserNotFoundResponseSchema = errorResponse(
  "USER_NOT_FOUND",
  "No account has that user ID.",
);
