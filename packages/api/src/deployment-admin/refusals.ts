import { InternalServerErrorResponseSchema } from "../http/internal-server-error-response.js";
import { DeploymentAdminForbiddenResponseSchema } from "../settings/deployment-admin.js";

/**
 * What every `/v1/deployment-admin/*` route but `GET /` can refuse with
 * besides its own errors: the admin check's 403 for anyone who is not a
 * deployment administrator (auth/deployment-admin.ts), and Core's answer to
 * a failure the route did not expect, whose message the Admin page shows.
 */
export const DeploymentAdminRefusals = [
  { status: 403, schema: DeploymentAdminForbiddenResponseSchema },
  { status: 500, schema: InternalServerErrorResponseSchema },
] as const;
