import {
  BeginGitHubCeremonyResponseSchema,
  BeginGitHubInstallationResponseSchema,
  GitHubControlPlaneForbiddenResponseSchema,
  GitHubControlPlaneInvalidResponseSchema,
  GitHubControlPlaneUnavailableResponseSchema,
  GitHubDisconnectResponseSchema,
  GitHubGrantResponseSchema,
  GitHubWebhookResponseSchema,
  IntegrationsPolicyDeniedResponseSchema,
  ListGitHubGrantsResponseSchema,
} from "@dx/api";
import {
  GitHubAppConfigurationInvalid,
  WorkspacePolicyDenied,
} from "@dx/domain";
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
import { loadConfigEncryptionKeyring } from "../../settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../settings/integrations/credential-vault.js";
import { SettingsService } from "../../settings/service.js";
import { WorkspaceRepositoryD1 } from "../../settings/workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../../settings/workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../../settings/workspace-policy/service.js";
import { loadGitHubAppConfiguration } from "./configuration.js";
import {
  createGitHubControlPlane,
  GitHubControlPlaneForbidden,
  GitHubControlPlaneInvalid,
  type GitHubOwner,
  listGitHubGrants,
  ownerForGitHubSetupState,
} from "./control-plane.js";
import { GitHubProviderError } from "./provider-http.js";
import {
  GITHUB_WEBHOOK_MAX_BYTES,
  GitHubWebhookInvalid,
  GitHubWebhookUnavailable,
  processGitHubWebhook,
} from "./webhooks.js";

const encode = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: unknown,
) => Schema.encodeUnknownSync(schema)(value);

const error = (
  context: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  status: 400 | 401 | 403 | 409 | 503,
  code: string,
  message: string,
) =>
  context.json(
    encode(schema, {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const failure = (context: Context<AppEnv>, cause: unknown) => {
  if (
    cause instanceof GitHubControlPlaneInvalid ||
    cause instanceof GitHubWebhookInvalid
  )
    return error(
      context,
      GitHubControlPlaneInvalidResponseSchema,
      400,
      "GITHUB_CONTROL_PLANE_INVALID",
      "The GitHub control-plane request is invalid or expired.",
    );
  if (
    cause instanceof GitHubControlPlaneForbidden ||
    cause instanceof BrowserSessionRequired
  )
    return error(
      context,
      GitHubControlPlaneForbiddenResponseSchema,
      403,
      "GITHUB_CONTROL_PLANE_FORBIDDEN",
      "GitHub control-plane access is forbidden.",
    );
  if (cause instanceof WorkspacePolicyDenied)
    return context.json(
      encode(IntegrationsPolicyDeniedResponseSchema, {
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message:
            "Workspace policy does not allow personal integration credentials.",
          requestId: context.get("requestId"),
          reason: cause.reason,
        },
      }),
      403,
    );
  if (
    cause instanceof GitHubProviderError ||
    cause instanceof GitHubWebhookUnavailable ||
    cause instanceof GitHubAppConfigurationInvalid ||
    Schema.isSchemaError(cause)
  ) {
    sourceControlLogger.error("GitHub control-plane operation unavailable.", {
      event: "github_control_plane_unavailable",
      requestId: context.get("requestId"),
      failureCategory:
        cause instanceof GitHubProviderError
          ? `provider:${cause.category}`
          : cause instanceof GitHubWebhookUnavailable
            ? "webhook"
            : cause instanceof GitHubAppConfigurationInvalid
              ? "configuration"
              : "schema",
      ...(cause instanceof GitHubProviderError
        ? {
            providerEndpoint: cause.endpoint ?? "unknown",
            providerFailureReason: cause.failureReason ?? "unknown",
            providerFailureCause: cause.failureCause ?? "unknown",
            providerFailureCauseDetail: cause.failureCauseDetail ?? "unknown",
          }
        : {}),
    });
    return error(
      context,
      GitHubControlPlaneUnavailableResponseSchema,
      503,
      "GITHUB_CONTROL_PLANE_UNAVAILABLE",
      "The GitHub control plane is temporarily unavailable.",
    );
  }
  throw cause;
};

const execute = async <A>(
  context: Context<AppEnv>,
  operation: () => Promise<A>,
  success: (value: A) => Response | Promise<Response>,
) => {
  try {
    return await success(await operation());
  } catch (cause) {
    return failure(context, cause);
  }
};

const dependencies = async (context: Context<AppEnv>) => {
  const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
  const config = await Effect.runPromise(
    loadGitHubAppConfiguration(context.env),
  );
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(context.env),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  return { db, config, keyring, vault };
};

const browser = async (context: Context<AppEnv>) => {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(context.env),
  );
  const auth = createAuth(context.env, requirements);
  return Effect.runPromise(requireBrowserSession(context, auth));
};

const personalIntegrationPolicy = async (
  context: Context<AppEnv>,
  db: D1Database,
) => {
  const workspace = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const policies = yield* WorkspacePolicyService;
      yield* policies.evaluateForUser(
        context.get("principal").userId as never,
        {
          kind: "secret.use-personal-override",
        },
      );
    }).pipe(Effect.provide(policy)),
  );
};

const personalOwner = (context: Context<AppEnv>): GitHubOwner => {
  if (!context.get("principal").credentialScopes?.includes("personal"))
    throw new GitHubControlPlaneForbidden();
  return { scope: "personal", id: context.get("principal").userId };
};

const boundedQuery = (
  context: Context<AppEnv>,
  name: string,
  maximum: number,
) => {
  const value = context.req.query(name);
  if (value === undefined || value.length < 1 || value.length > maximum)
    throw new GitHubControlPlaneInvalid();
  return value;
};

const optionalReturnTo = (context: Context<AppEnv>) => {
  const value = context.req.query("return_to");
  return value === undefined || value.length === 0 ? undefined : value;
};

const readBoundedBody = async (request: Request) => {
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^[0-9]+$/.test(length) || Number(length) > GITHUB_WEBHOOK_MAX_BYTES)
  )
    throw new GitHubWebhookInvalid();
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GITHUB_WEBHOOK_MAX_BYTES) {
      await reader.cancel();
      throw new GitHubWebhookInvalid();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const controlPlane = async (context: Context<AppEnv>) => {
  const deps = await dependencies(context);
  return { ...deps, service: createGitHubControlPlane(deps) };
};

const beginAuthorization = async (context: Context<AppEnv>) => {
  const deps = await controlPlane(context);
  const session = await browser(context);
  await personalIntegrationPolicy(context, deps.db);
  return deps.service.beginAuthorization(
    context.get("principal").userId,
    session.sessionId,
    optionalReturnTo(context),
  );
};

const beginInstall = async (context: Context<AppEnv>) => {
  const deps = await controlPlane(context);
  const session = await browser(context);
  await personalIntegrationPolicy(context, deps.db);
  const owner = personalOwner(context);
  return deps.service.beginInstallation(
    context.get("principal").userId,
    session.sessionId,
    owner,
    optionalReturnTo(context),
  );
};

const list = async (context: Context<AppEnv>) => {
  const configured =
    context.env.DX_INTEGRATION_GITHUB_APP !== undefined &&
    context.env.DX_INTEGRATION_GITHUB_APP !== "{}";
  const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
  if (configured)
    await Effect.runPromise(loadGitHubAppConfiguration(context.env));
  await browser(context);
  const owner = personalOwner(context);
  return {
    configured,
    grants: await listGitHubGrants(db, owner),
  };
};

const mutateGrant =
  (operation: "reconcile" | "disconnect") =>
  async (context: Context<AppEnv>) => {
    const deps = await controlPlane(context);
    await browser(context);
    const owner = personalOwner(context);
    const grantId = context.req.param("grantId");
    if (grantId === undefined || grantId.length < 1 || grantId.length > 512)
      throw new GitHubControlPlaneInvalid();
    if (operation === "reconcile")
      await Effect.runPromise(
        deps.service.reconcile(context.get("principal").userId, grantId, owner),
      );
    else
      await deps.service.disconnect(
        context.get("principal").userId,
        grantId,
        owner,
      );
    return { deps, owner, grantId };
  };

export const githubControlPlaneRoutes = new Hono<AppEnv>();

githubControlPlaneRoutes.post("/personal/authorize", (context) =>
  execute(
    context,
    () => beginAuthorization(context),
    (data) =>
      context.json(
        encode(BeginGitHubCeremonyResponseSchema, { status: "success", data }),
        201,
      ),
  ),
);

githubControlPlaneRoutes.get("/oauth/callback", (context) =>
  execute(
    context,
    async () => {
      const deps = await controlPlane(context);
      const session = await browser(context);
      await personalIntegrationPolicy(context, deps.db);
      const returnTo = await deps.service.completeAuthorization(
        context.get("principal").userId,
        session.sessionId,
        boundedQuery(context, "state", 128),
        boundedQuery(context, "code", 2_048),
      );
      const installation = await deps.service.beginInstallation(
        context.get("principal").userId,
        session.sessionId,
        personalOwner(context),
        returnTo,
      );
      return installation.installationUrl;
    },
    (destination) => context.redirect(destination, 303),
  ),
);

githubControlPlaneRoutes.get("/setup", (context) =>
  execute(
    context,
    async () => {
      const deps = await controlPlane(context);
      const session = await browser(context);
      const state = boundedQuery(context, "state", 128);
      const installationId = boundedQuery(context, "installation_id", 32);
      const owner = await ownerForGitHubSetupState(
        deps.db,
        state,
        context.get("principal").userId,
        session.sessionId,
      );
      if (
        owner.scope !== "personal" ||
        owner.id !== context.get("principal").userId
      ) {
        throw new GitHubControlPlaneForbidden();
      }
      const completion = await deps.service.completeInstallation(
        context.get("principal").userId,
        session.sessionId,
        state,
        installationId,
      );
      const destination = new URL(context.env.DX_AUTH_URL as string);
      destination.pathname = "/settings/integrations";
      destination.search = "github=installed";
      if (completion.returnTo !== undefined)
        destination.searchParams.set("return_to", completion.returnTo);
      return destination.toString();
    },
    (destination) => context.redirect(destination, 303),
  ),
);

for (const prefix of ["/personal"] as const) {
  githubControlPlaneRoutes.get(`${prefix}/grants`, (context) =>
    execute(
      context,
      () => list(context),
      (data) =>
        context.json(
          encode(ListGitHubGrantsResponseSchema, {
            status: "success",
            data,
          }),
        ),
    ),
  );
  githubControlPlaneRoutes.post(`${prefix}/install`, (context) =>
    execute(
      context,
      () => beginInstall(context),
      (data) =>
        context.json(
          encode(BeginGitHubInstallationResponseSchema, {
            status: "success",
            data,
          }),
          201,
        ),
    ),
  );
  githubControlPlaneRoutes.post(`${prefix}/refresh`, (context) =>
    execute(
      context,
      async () => {
        const deps = await controlPlane(context);
        await browser(context);
        personalOwner(context);
        await deps.service.refresh(context.get("principal").userId);
      },
      () => context.body(null, 204),
    ),
  );
  githubControlPlaneRoutes.post(
    `${prefix}/grants/:grantId/reconcile`,
    (context) =>
      execute(
        context,
        mutateGrant("reconcile").bind(null, context),
        async ({ deps, owner, grantId }) => {
          const grants = await listGitHubGrants(deps.db, owner);
          const grant = grants.find((item) => item.id === grantId);
          if (grant === undefined) throw new GitHubControlPlaneForbidden();
          return context.json(
            encode(GitHubGrantResponseSchema, {
              status: "success",
              data: grant,
            }),
          );
        },
      ),
  );
  githubControlPlaneRoutes.delete(`${prefix}/grants/:grantId`, (context) =>
    execute(
      context,
      mutateGrant("disconnect").bind(null, context),
      ({ grantId }) =>
        context.json(
          encode(GitHubDisconnectResponseSchema, {
            status: "success",
            data: {
              grantId,
              localAccessStopped: true,
              installationUninstalled: true,
            },
          }),
        ),
    ),
  );
}

githubControlPlaneRoutes.delete("/personal/authorization", (context) =>
  execute(
    context,
    async () => {
      const deps = await controlPlane(context);
      await browser(context);
      personalOwner(context);
      await deps.service.revokeAuthorization(context.get("principal").userId);
    },
    () => context.body(null, 204),
  ),
);

export const githubWebhookRoutes = new Hono<AppEnv>();

githubWebhookRoutes.post("/webhooks", (context) =>
  execute(
    context,
    async () => {
      const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
      const config = await Effect.runPromise(
        loadGitHubAppConfiguration(context.env),
      );
      const body = await readBoundedBody(context.req.raw);
      return Effect.runPromise(
        processGitHubWebhook({
          db,
          config,
          deliveryId: context.req.header("x-github-delivery") ?? "",
          event: context.req.header("x-github-event") ?? "",
          signature: context.req.header("x-hub-signature-256") ?? "",
          body,
        }),
      );
    },
    (data) =>
      context.json(
        encode(GitHubWebhookResponseSchema, { status: "success", data }),
      ),
  ),
);
