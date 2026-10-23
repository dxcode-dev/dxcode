import { writeFileSync } from "node:fs";
import * as Alchemist from "alchemy/Alchemist";
import { apply } from "alchemy/Apply";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Plan from "alchemy/Plan";
import { runMain } from "alchemy/Util/PlatformServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  applyValidatedAlchemyPlan,
  configureHostedDeploymentPolicy,
  deploymentPortals,
  deploymentSelection,
  emptyBranchPreviewBucket,
  parseOrbProviders,
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
const targetSelection = deploymentSelection({
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
});
const selection = {
  ...(target === "selfhost"
    ? {}
    : { authEmailFrom: required("DX_DEPLOYMENT_AUTH_EMAIL_FROM") }),
  ...targetSelection,
  portals: deploymentPortals({
    domain: process.env.DX_DEPLOYMENT_PORTAL_DOMAIN,
    zoneId: process.env.DX_DEPLOYMENT_PORTAL_ZONE_ID,
    appDomain: targetSelection.domain,
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
  workersDevSubdomain:
    process.env.DX_DEPLOYMENT_WORKERS_DEV_SUBDOMAIN?.trim() || undefined,
  orbProviders: parseOrbProviders(process.env.DX_DEPLOYMENT_ORB_PROVIDERS),
  attachmentSigning: (() => {
    const value = process.env.DX_DEPLOYMENT_ATTACHMENT_SIGNING ?? "token";
    if (value === "token" || (value === "operator" && target === "selfhost"))
      return value;
    throw new Error(
      "DX_DEPLOYMENT_ATTACHMENT_SIGNING must be token, or operator for self-host.",
    );
  })(),
  turnstileTestKeys: (() => {
    const value = process.env.DX_DEPLOYMENT_TURNSTILE_TEST_KEYS;
    if (value === undefined || value === "false") return false;
    if (value === "true" && target === "branch") return true;
    throw new Error(
      "DX_DEPLOYMENT_TURNSTILE_TEST_KEYS must be true (branch only) or false.",
    );
  })(),
  workerTraces: (() => {
    const value = process.env.DX_DEPLOYMENT_WORKER_TRACES;
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error("DX_DEPLOYMENT_WORKER_TRACES must be true or false.");
  })(),
};

// Returns the response's `result`, or undefined when the bucket is absent.
const cloudflareR2Request = async (method, path, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "GET" && response.status === 404) return undefined;
  const result = await response.json();
  if (!response.ok || result.success !== true)
    throw new Error(`Cloudflare R2 ${method} failed (${response.status}).`);
  return result.result;
};

const program = Effect.gen(function* () {
  // Alchemy's own session: the stack, its providers and state store, and the
  // stage, adopt and state-store settings below, without the CLI's prompts.
  const session = yield* Alchemist.open(
    { entrypoint: "alchemy.run.ts", stage },
    { adopt: false, dev: false, updateStateStore: target === "selfhost" },
  );
  yield* Effect.gen(function* () {
    const exactPlan =
      operation === "destroy"
        ? yield* Plan.destroy(session.stack)
        : yield* Plan.make(session.stack);
    const outputs = yield* applyValidatedAlchemyPlan({
      operation,
      plan: exactPlan,
      selection,
      apply: (validatedPlan) =>
        Effect.sync(() => writeFileSync(applyStartedFile, "validated\n")).pipe(
          Effect.andThen(
            Effect.tryPromise(() =>
              emptyBranchPreviewBucket({
                operation,
                target,
                accountId: required("CLOUDFLARE_ACCOUNT_ID"),
                bucketName: selection.bucketName,
                request: cloudflareR2Request,
              }),
            ),
          ),
          Effect.tap((deleted) =>
            deleted > 0
              ? Console.log(
                  `Emptied ${deleted} objects from ${selection.bucketName}.`,
                )
              : Effect.void,
          ),
          Effect.andThen(apply(validatedPlan)),
        ),
    });
    if (outputs !== undefined) yield* Console.log(outputs);
  }).pipe(Effect.provide(session.context));
});

program.pipe(
  Effect.provide(Layer.mergeAll(Alchemist.layer(), LoggingCli)),
  Effect.scoped,
  runMain,
);
