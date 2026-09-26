import {
  GetSettingsContextForbiddenResponseSchema,
  GetSettingsContextPersistenceUnavailableResponseSchema,
  GetSettingsContextResponseSchema,
} from "@dx/api";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { authorizationLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { personalAccountRoutes } from "./account/routes.js";
import { personalAgentInstructionsRoutes } from "./agent-instructions/routes.js";
import { workspaceApplicationRoutes } from "./applications/routes.js";
import {
  personalEnvironmentVariableRoutes,
  workspaceEnvironmentVariableRoutes,
} from "./environment-variables/routes.js";
import { personalExperimentalFeaturesRoutes } from "./experimental-features/routes.js";
import { personalIntegrationRoutes } from "./integrations/routes.js";
import { personalSigningKeyRoutes } from "./keys/routes.js";
import {
  personalMcpServerRoutes,
  workspaceMcpServerRoutes,
} from "./mcp-servers/routes.js";
import {
  personalModelRoutingRoutes,
  workspaceModelRoutingRoutes,
} from "./model-routing/routes.js";
import { personalModelSubscriptionRoutes } from "./model-subscriptions/routes.js";
import {
  personalPluginRoutes,
  workspacePluginRoutes,
} from "./plugins/routes.js";
import {
  personalProjectDefaultsRoutes,
  workspaceProjectDefaultsRoutes,
} from "./project-defaults/routes.js";
import { personalSecurityRoutes } from "./security/routes.js";
import { type SettingsAccessContext, SettingsService } from "./service.js";
import { personalSkillRoutes, workspaceSkillRoutes } from "./skills/routes.js";
import { personalPluginTriggerRoutes } from "./triggers/routes.js";
import { personalUsageRoutes } from "./usage/routes.js";
import { workspaceUsageRoutes } from "./usage/workspace-routes.js";
import { WorkspaceRepositoryD1 } from "./workspace/repository-d1.js";
import { workspaceProfileRoutes } from "./workspace/routes.js";
import { workspacePolicyRoutes } from "./workspace-policy/routes.js";

const responseData = (
  access: SettingsAccessContext,
  dictationAvailable: boolean,
) => ({
  activeScope: access.activeScope,
  dictationAvailable,
  workspace:
    access.workspace === undefined
      ? undefined
      : {
          id: access.workspace.workspace.id,
          displayName: access.workspace.workspace.displayName,
          shortName: access.workspace.workspace.shortName,
          lifecycleState: access.workspace.workspace.lifecycleState,
          revision: access.workspace.workspace.revision,
          role: access.workspace.role,
        },
});

const handlePersonalSettingsContext = async (context: Context<AppEnv>) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    const repositoryLayer = WorkspaceRepositoryD1(db).pipe(
      Layer.provide(D1Client.layer({ db })),
    );
    const access = yield* Effect.gen(function* () {
      const service = yield* SettingsService;
      return yield* service.personal(context.get("principal"));
    }).pipe(
      Effect.provide(
        SettingsService.layer.pipe(Layer.provide(repositoryLayer)),
      ),
    );
    return yield* Schema.encodeUnknownEffect(GetSettingsContextResponseSchema)({
      status: "success",
      data: responseData(
        access,
        context.env.DX_RUNTIME_MODE === "local" ||
          Boolean(context.env.SARVAM_API_KEY),
      ),
    });
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);

  return Match.value(result.failure).pipe(
    Match.tags({
      SettingsScopeForbidden: () => {
        authorizationLogger.warn("Settings scope authorization failed.", {
          event: "settings_authorization_failed",
          scope: "personal",
          requestId,
        });
        return context.json(
          Schema.encodeUnknownSync(GetSettingsContextForbiddenResponseSchema)({
            status: "error",
            data: {
              code: "SETTINGS_SCOPE_FORBIDDEN",
              message: "The settings scope is unavailable for this user.",
              requestId,
            },
          }),
          403,
        );
      },
      PersistenceUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            GetSettingsContextPersistenceUnavailableResponseSchema,
          )({
            status: "error",
            data: {
              code: "PERSISTENCE_UNAVAILABLE",
              message: "Settings are temporarily unavailable.",
              requestId,
            },
          }),
          503,
        ),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
};

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.route("/personal/account", personalAccountRoutes);
settingsRoutes.route(
  "/personal/agent-instructions",
  personalAgentInstructionsRoutes,
);
settingsRoutes.route(
  "/personal/environment-variables",
  personalEnvironmentVariableRoutes,
);
settingsRoutes.route("/personal/integrations", personalIntegrationRoutes);
settingsRoutes.route(
  "/personal/model-routing/subscriptions",
  personalModelSubscriptionRoutes,
);
settingsRoutes.route("/personal/model-routing", personalModelRoutingRoutes);
settingsRoutes.route("/personal/mcp-servers", personalMcpServerRoutes);
settingsRoutes.route("/personal/plugins", personalPluginRoutes);
settingsRoutes.route("/personal/skills", personalSkillRoutes);
settingsRoutes.route("/personal/usage", personalUsageRoutes);
settingsRoutes.route(
  "/personal/experimental-features",
  personalExperimentalFeaturesRoutes,
);
settingsRoutes.route("/personal/security", personalSecurityRoutes);
settingsRoutes.route("/personal/projects", personalProjectDefaultsRoutes);
settingsRoutes.route("/personal/keys", personalSigningKeyRoutes);
settingsRoutes.route("/personal/triggers", personalPluginTriggerRoutes);
settingsRoutes.route("/workspaces", workspaceProfileRoutes);
settingsRoutes.route("/workspaces", workspaceApplicationRoutes);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/environment-variables",
  workspaceEnvironmentVariableRoutes,
);

settingsRoutes.route("/workspaces/:workspaceSlug/usage", workspaceUsageRoutes);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/mcp-servers",
  workspaceMcpServerRoutes,
);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/plugins",
  workspacePluginRoutes,
);
settingsRoutes.route("/workspaces/:workspaceSlug/skills", workspaceSkillRoutes);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/projects",
  workspaceProjectDefaultsRoutes,
);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/policy",
  workspacePolicyRoutes,
);
settingsRoutes.route(
  "/workspaces/:workspaceSlug/model-routing",
  workspaceModelRoutingRoutes,
);
settingsRoutes.get("/personal", handlePersonalSettingsContext);
