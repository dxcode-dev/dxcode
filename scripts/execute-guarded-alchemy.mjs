import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as Alchemist from "alchemy/Alchemist";
import { apply } from "alchemy/Apply";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Plan from "alchemy/Plan";
import { runMain } from "alchemy/Util/PlatformServices";
import { AwsClient } from "aws4fetch";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  abortBranchPreviewUploads,
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
  // Staging only: text or secret bindings this one run may remove, by name.
  droppedBindings: (() => {
    const names = (process.env.DX_DEPLOYMENT_DROP_BINDINGS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length > 0 && target !== "staging")
      throw new Error("DX_DEPLOYMENT_DROP_BINDINGS applies only to staging.");
    return names;
  })(),
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

// R2's S3 API with the deploy token's derived credentials: its ID as the
// access key and the SHA-256 of its value as the secret.
let r2S3Client;
const r2S3Request = async (method, path) => {
  if (r2S3Client === undefined) {
    const token = required("CLOUDFLARE_API_TOKEN");
    const response = await fetch(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.json();
    if (!response.ok || typeof body.result?.id !== "string")
      throw new Error(`Cloudflare token lookup failed (${response.status}).`);
    r2S3Client = new AwsClient({
      accessKeyId: body.result.id,
      secretAccessKey: createHash("sha256").update(token).digest("hex"),
      service: "s3",
      region: "auto",
    });
  }
  return r2S3Client.fetch(
    `https://${required("CLOUDFLARE_ACCOUNT_ID")}.r2.cloudflarestorage.com${path}`,
    { method },
  );
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
              abortBranchPreviewUploads({
                operation,
                target,
                bucketName: selection.bucketName,
                s3: r2S3Request,
              }),
            ),
          ),
          Effect.tap((aborted) =>
            aborted > 0
              ? Console.log(
                  `Aborted ${aborted} unfinished uploads in ${selection.bucketName}.`,
                )
              : Effect.void,
          ),
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
