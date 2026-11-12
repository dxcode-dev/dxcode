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
