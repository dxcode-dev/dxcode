import { defineEndpoint } from "../http/endpoint.js";
import { DeploymentAdminStatusResponseSchema } from "../settings/deployment-admin.js";

/**
 * `GET /v1/deployment-admin`: whether the signed-in person administers this
 * deployment. The only route under it without the admin check.
 */
export const GetDeploymentAdminStatusEndpoint = defineEndpoint({
  id: "deploymentAdmin.status",
  method: "GET",
  path: "/v1/deployment-admin",
  success: DeploymentAdminStatusResponseSchema,
});
