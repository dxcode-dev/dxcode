import {
  BeginBitbucketAuthorizationResponseSchema,
  BitbucketConnectionResponseSchema,
  BitbucketDisconnectResponseSchema,
  BitbucketForbiddenResponseSchema,
  BitbucketInvalidResponseSchema,
  BitbucketRepositoriesResponseSchema,
  BitbucketUnavailableResponseSchema,
} from "@dx/api";
import { SourceControlAccessDenied, WorkspacePolicyDenied } from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../../auth/browser-session.js";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
import type { AppEnv } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../../settings/audit.js";
import { SettingsService } from "../../settings/service.js";
import { WorkspaceRepositoryD1 } from "../../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../../settings/workspace-policy/service.js";
import {
  BitbucketInvalid,
  bitbucketControlPlaneFor,
  disconnectBitbucket,
  readBitbucketConnection,
} from "./control-plane.js";

const encode = (schema: Schema.ConstraintEncoder<unknown>, data: unknown) =>
  Schema.encodeUnknownSync(schema)({ status: "success", data });
const browser = async (context: Context<AppEnv>) => {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(context.env),
  );
  if (!context.get("principal").credentialScopes?.includes("personal"))
    throw new BrowserSessionRequired();
  return Effect.runPromise(
    requireBrowserSession(context, createAuth(context.env, requirements)),
  );
};
const allowPersonal = async (context: Context<AppEnv>, db: D1Database) => {
  const workspace = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const layer = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        SettingsService.layer.pipe(Layer.provide(workspace)),
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* WorkspacePolicyService).evaluateForUser(
        context.get("principal").userId,
        { kind: "secret.use-personal-override" },
      );
    }).pipe(Effect.provide(layer)),
  );
};

export const bitbucketControlPlaneRoutes = new Hono<AppEnv>();
bitbucketControlPlaneRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("Referrer-Policy", "no-referrer");
  await browser(context);
  if (context.req.method !== "GET") {
    const origin = context.req.header("origin");
    if (!origin || origin !== new URL(context.env.DX_AUTH_URL as string).origin)
      throw new BrowserSessionRequired();
  }
  await next();
});
bitbucketControlPlaneRoutes.onError((cause, context) => {
  const invalid = cause instanceof BitbucketInvalid;
  const forbidden =
    cause instanceof BrowserSessionRequired ||
    cause instanceof WorkspacePolicyDenied ||
    cause instanceof SourceControlAccessDenied;
  const schema = invalid
    ? BitbucketInvalidResponseSchema
    : forbidden
      ? BitbucketForbiddenResponseSchema
      : BitbucketUnavailableResponseSchema;
  const code = invalid
    ? "BITBUCKET_INVALID"
    : forbidden
      ? "BITBUCKET_FORBIDDEN"
      : "BITBUCKET_UNAVAILABLE";
  const message = invalid
    ? "The Bitbucket request is invalid or expired. Start again."
    : forbidden
      ? "Bitbucket access is unavailable. Reconnect or check repository permissions."
      : "Bitbucket is temporarily unavailable. Retry without disconnecting.";
  sourceControlLogger.info("Bitbucket request did not complete.", {
    event: "bitbucket_request_failed",
    category: code,
    requestId: context.get("requestId"),
  });
  return context.json(
    Schema.encodeUnknownSync(schema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    invalid ? 400 : forbidden ? 403 : 503,
  );
});
const dbFor = (context: Context<AppEnv>) =>
  Effect.runPromise(decodeD1Binding(context.env.DB));
const status = async (context: Context<AppEnv>) => {
  const db = await dbFor(context);
  const userId = context.get("principal").userId;
  if (
    !context.env.DX_INTEGRATION_BITBUCKET_OAUTH ||
    context.env.DX_INTEGRATION_BITBUCKET_OAUTH === "{}" ||
    context.env.DX_RUNTIME_MODE === "local"
  ) {
    const row = await readBitbucketConnection(db, userId);
    return {
      configured: false,
      connection:
        row === null
          ? null
          : { id: row.id, accountName: row.account_name, status: row.status },
    };
  }
  return (await bitbucketControlPlaneFor(db, context.env)).status(userId);
};
bitbucketControlPlaneRoutes.get("/personal/connection", async (context) =>
  context.json(
    encode(BitbucketConnectionResponseSchema, await status(context)),
  ),
);
bitbucketControlPlaneRoutes.post("/personal/refresh", async (context) => {
  const db = await dbFor(context);
  await allowPersonal(context, db);
  return context.json(
    encode(BitbucketConnectionResponseSchema, await status(context)),
  );
});
bitbucketControlPlaneRoutes.post("/personal/authorize", async (context) => {
  const db = await dbFor(context);
  await allowPersonal(context, db);
  const session = await browser(context);
  const service = await bitbucketControlPlaneFor(db, context.env);
  return context.json(
    encode(
      BeginBitbucketAuthorizationResponseSchema,
      await service.beginAuthorization(
        context.get("principal").userId,
        session.sessionId,
      ),
    ),
    201,
  );
});
bitbucketControlPlaneRoutes.get("/oauth/callback", async (context) => {
  const db = await dbFor(context);
  await allowPersonal(context, db);
  const session = await browser(context);
  const service = await bitbucketControlPlaneFor(db, context.env);
  await service.completeAuthorization(
    context.get("principal").userId,
    session.sessionId,
    context.req.query("state") ?? "",
    context.req.query("error") ? undefined : context.req.query("code"),
  );
  return context.redirect(
    new URL("/settings/integrations", context.env.DX_AUTH_URL).href,
    303,
  );
});
bitbucketControlPlaneRoutes.get("/personal/repositories", async (context) => {
  const db = await dbFor(context);
  await allowPersonal(context, db);
  return context.json(
    encode(
      BitbucketRepositoriesResponseSchema,
      await (await bitbucketControlPlaneFor(db, context.env)).repositories(
        context.get("principal").userId,
      ),
    ),
  );
});
bitbucketControlPlaneRoutes.delete("/personal/connection", async (context) => {
  await disconnectBitbucket(
    await dbFor(context),
    context.get("principal").userId,
  );
  return context.json(
    encode(BitbucketDisconnectResponseSchema, { localAccessStopped: true }),
  );
});
