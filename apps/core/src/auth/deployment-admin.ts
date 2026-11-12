import {
  DeploymentAdminForbiddenResponseSchema,
  DeploymentAdminStatusResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";

/**
 * Deployment administrators: signed-in people whose verified primary email
 * is in `DX_DEPLOYMENT_ADMIN_EMAILS` (comma-separated). Without the binding
 * a deployment has none. The binding is read on every request and nothing
 * is cached in the session, so removing an email takes effect at once.
 */

const normalized = (email: string) => email.trim().toLowerCase();

/** The deployment's administrator emails, normalized. */
export const deploymentAdminEmails = (bindings: Bindings) =>
  new Set(
    (bindings.DX_DEPLOYMENT_ADMIN_EMAILS ?? "")
      .split(",")
      .map(normalized)
      .filter((email) => email !== ""),
  );

export const isDeploymentAdmin = async (
  bindings: Bindings,
  userId: string,
): Promise<boolean> => {
  const emails = deploymentAdminEmails(bindings);
  if (emails.size === 0 || bindings.DB === undefined) return false;
  const user = await bindings.DB.prepare(
    'SELECT email, emailVerified FROM "user" WHERE id = ? LIMIT 1',
  )
    .bind(userId)
    .first<{ email: string | null; emailVerified: number | null }>();
  return (
    user !== null &&
    user.emailVerified === 1 &&
    typeof user.email === "string" &&
    emails.has(normalized(user.email))
  );
};

/** Refuses everyone but a deployment administrator with 403. */
export const requireDeploymentAdmin: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const principal = context.get("principal");
  if (
    principal === undefined ||
    !(await isDeploymentAdmin(context.env, principal.userId))
  )
    return context.json(
      Schema.encodeUnknownSync(DeploymentAdminForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "DEPLOYMENT_ADMIN_REQUIRED",
          message: "Only deployment administrators can do this.",
          requestId: context.get("requestId") ?? "",
        },
      }),
      403,
    );
  await next();
};

/**
 * `GET /` says whether the signed-in person is an administrator; every other
 * route is the deployment's own (`registered`), behind the admin check.
 */
export const makeDeploymentAdminRoutes = (registered: Hono<AppEnv>) => {
  const router = new Hono<AppEnv>();
  router.get("/", async (context) => {
    const principal = context.get("principal");
    return context.json(
      Schema.encodeUnknownSync(DeploymentAdminStatusResponseSchema)({
        status: "success",
        data: {
          admin:
            principal !== undefined &&
            (await isDeploymentAdmin(context.env, principal.userId)),
        },
      }),
    );
  });
  router.use("/*", requireDeploymentAdmin);
  router.route("/", registered);
  return router;
};
