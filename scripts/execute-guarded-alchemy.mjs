import { writeFileSync } from "node:fs";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext, AlchemyContextLive } from "alchemy/AlchemyContext";
import { apply } from "alchemy/Apply";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import { importStack } from "alchemy/Cli/commands/_shared";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Plan from "alchemy/Plan";
import { Stage } from "alchemy/Stage";
import { fileLogger } from "alchemy/Util/FileLogger";
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  applyValidatedAlchemyPlan,
  configureHostedDeploymentPolicy,
  deploymentSelection,
} from "./alchemy-deployment.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const operation = required("DX_ALCHEMY_OPERATION");
const target = required("DX_DEPLOYMENT_TARGET");
if (target !== "selfhost")
  configureHostedDeploymentPolicy(
    JSON.parse(required("DX_PRIVATE_DEPLOYMENT_POLICY")),
  );
const branch = process.env.DX_DEPLOYMENT_BRANCH ?? "";
const stage = required("DX_DEPLOYMENT_STAGE");
const applyStartedFile = required("DX_ALCHEMY_APPLY_STARTED_FILE");
const selection = {
  ...(target === "selfhost"
    ? {}
    : { authEmailFrom: required("DX_DEPLOYMENT_AUTH_EMAIL_FROM") }),
  ...deploymentSelection({
    branch,
    stage,
    target,
    selfhost:
      target === "selfhost"
        ? {
            name: required("DX_DEPLOYMENT_NAME"),
            accountId: required("CLOUDFLARE_ACCOUNT_ID"),
            domain: required("DX_DEPLOYMENT_DOMAIN"),
            zone: process.env.DX_DEPLOYMENT_ZONE?.trim() || undefined,
          }
        : undefined,
  }),
  ...(target === "selfhost"
    ? {
        adminEmail: required("DX_ADMIN_EMAIL"),
        integrations: (process.env.DX_DEPLOYMENT_INTEGRATIONS ?? "")
          .split(",")
          .filter(Boolean),
      }
    : {}),
  databaseId: process.env.DX_DEPLOYMENT_DATABASE_ID?.trim() || undefined,
  deploymentLabel: required("DX_DEPLOYMENT_LABEL"),
  dxdChecksum: required("DX_DEPLOYMENT_DXD_CHECKSUM"),
  dxdReleaseUrl: required("DX_DEPLOYMENT_DXD_RELEASE_URL"),
  e2bTemplateBuildId: required("DX_DEPLOYMENT_E2B_TEMPLATE_BUILD_ID"),
  environment: required("DX_DEPLOYMENT_ENVIRONMENT"),
  origin: required("DX_DEPLOYMENT_ORIGIN"),
  packageDirectory: required("DX_DEPLOYMENT_PACKAGE_DIR"),
  revision: required("DX_DEPLOYMENT_REVISION"),
};

const program = Effect.gen(function* () {
  const stackEffect = yield* importStack("alchemy.run.ts");
  const runServices = Layer.mergeAll(
    Layer.effect(
      AlchemyContext,
      AlchemyContext.pipe(
        Effect.map((context) => ({
          ...context,
          adopt: false,
          dev: false,
          updateStateStore: target === "selfhost",
        })),
      ),
    ),
    Layer.succeed(AdoptPolicy, false),
    Layer.succeed(ArtifactStore, createArtifactStore()),
    Layer.succeed(
      AuthProviders,
      yield* Effect.serviceOption(AuthProviders).pipe(
        Effect.map(Option.getOrElse(() => ({}))),
      ),
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv()),
    Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
    Layer.succeed(Stage, stage),
  );

  yield* Effect.gen(function* () {
    const stack = yield* stackEffect;
    yield* Effect.gen(function* () {
      const exactPlan =
        operation === "destroy"
          ? yield* Plan.destroy(stack)
          : yield* Plan.make(stack);
      const outputs = yield* applyValidatedAlchemyPlan({
        operation,
        plan: exactPlan,
        selection,
        apply: (validatedPlan) =>
          Effect.sync(() =>
            writeFileSync(applyStartedFile, "validated\n"),
          ).pipe(Effect.andThen(apply(validatedPlan))),
      });
      if (outputs !== undefined) yield* Console.log(outputs);
    }).pipe(Effect.provide(stack.services));
  }).pipe(Effect.provide(runServices));
});

const baseServices = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  Layer.succeed(ArtifactStore, createArtifactStore()),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  LoggingCli,
);

program.pipe(Effect.provide(baseServices), Effect.scoped, runMain);
