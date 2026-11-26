import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  DeploymentAdminPersonResponseSchema,
  MailErrorResponseSchema,
  SetMailSendingRequestSchema,
  SetMailSendingResponseSchema,
} from "../mail/mail.js";
import {
  DeploymentAdminUserNotFoundResponseSchema,
  ResetUsernameChangeResponseSchema,
} from "../settings/deployment-admin.js";
import { PersonalAccountPersistenceUnavailableResponseSchema } from "../settings/personal-account.js";
import { DeploymentAdminRefusals } from "./refusals.js";

/**
 * A deployment administrator's tools for one person, under
 * `/v1/deployment-admin/users` (settings/account/admin-routes.ts and
 * mail/routes.ts in Core): find them, give back their one username change,
 * or pause their Mail sending.
 */

export const DeploymentAdminUserParamsSchema = Schema.Struct({
  userId: Schema.String,
});

/** `?q=`: an exact sign-in email or username, at most 320 characters. */
export const DeploymentAdminUserLookupQuerySchema = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)),
});

export const LookupDeploymentAdminUserEndpoint = defineEndpoint({
  id: "deploymentAdmin.users.lookup",
  method: "GET",
  path: "/v1/deployment-admin/users/lookup",
  query: DeploymentAdminUserLookupQuerySchema,
  success: DeploymentAdminPersonResponseSchema,
  refusals: [
    ...DeploymentAdminRefusals,
    // MAIL_INVALID_REQUEST (400) or MAIL_NOT_FOUND (404), from
    // deploymentAdminMailRoutes in apps/core/src/mail/routes.ts.
    ...([400, 404] as const).map((status) => ({
      status,
      schema: MailErrorResponseSchema,
    })),
  ],
});

export const ResetUsernameChangeEndpoint = defineEndpoint({
  id: "deploymentAdmin.users.resetUsernameChange",
  method: "POST",
  path: "/v1/deployment-admin/users/:userId/username-change/reset",
  params: DeploymentAdminUserParamsSchema,
  success: ResetUsernameChangeResponseSchema,
  refusals: [
    ...DeploymentAdminRefusals,
    { status: 404, schema: DeploymentAdminUserNotFoundResponseSchema },
    {
      status: 503,
      schema: PersonalAccountPersistenceUnavailableResponseSchema,
    },
  ],
});

export const SetMailSendingEndpoint = defineEndpoint({
  id: "deploymentAdmin.users.setMailSending",
  method: "PUT",
  path: "/v1/deployment-admin/users/:userId/mail-sending",
  params: DeploymentAdminUserParamsSchema,
  body: SetMailSendingRequestSchema,
  success: SetMailSendingResponseSchema,
  refusals: [
    ...DeploymentAdminRefusals,
    // MAIL_INVALID_REQUEST (400) or MAIL_NOT_FOUND (404), from
    // deploymentAdminMailRoutes in apps/core/src/mail/routes.ts.
    ...([400, 404] as const).map((status) => ({
      status,
      schema: MailErrorResponseSchema,
    })),
  ],
});
