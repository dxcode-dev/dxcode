import {
  ApprovePluginProposalRequestSchema,
  CreatePluginShareLinkResponseSchema,
  DecidePluginProposalResponseSchema,
  InstallPluginBundleResponseSchema,
  ListPluginBundlesResponseSchema,
  ListPluginBundleUpdatesResponseSchema,
  type PluginBundleData,
  PluginBundleIntegrityConflictResponseSchema,
  PluginBundleNotFoundResponseSchema,
  PluginBundleParamsSchema,
  PluginBundleRejectedResponseSchema,
  PluginBundleSettingsResponseSchema,
  PluginBundleSourceUnavailableResponseSchema,
  PluginBundlesForbiddenResponseSchema,
  PluginBundlesUnavailableResponseSchema,
  PluginHostUsageResponseSchema,
  PluginJobActionRequestSchema,
  PluginJobParamsSchema,
  PluginJobsResponseSchema,
  PluginProposalDecidedResponseSchema,
  PluginProposalParamsSchema,
  PreviewPluginBundleResponseSchema,
  PreviewPluginBundleUpdateResponseSchema,
  RemovePluginBundleResponseSchema,
  RevokePluginShareLinksResponseSchema,
  SetPluginBundlePolicyRequestSchema,
  SetPluginDevRequestSchema,
  UpdatePluginBundleRequestSchema,
  UpdatePluginBundleResponseSchema,
  UpdatePluginBundleSettingsRequestSchema,
  UpdatePluginBundleSourceResponseSchema,
} from "@dx/api";
import {
  isStdioMcpServer,
  MAX_PLUGIN_ARCHIVE_BYTES,
  McpServerLimitExceeded,
  McpServerRepository,
  type McpServerTarget,
  PersistenceUnavailable,
  PluginBundleRepository,
  PluginBundleSource,
  type PluginId,
  PluginIntegrity,
  PluginIntegrityConflict,
  PluginNotFound,
  type PluginTarget,
  type Principal,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  SkillLimitExceeded,
  SkillRepository,
  type StoredPluginBundle,
  stdioCommandLine,
  WorkspacePolicyConflict,
  WorkspacePolicyRepository,
  WorkspaceSlug,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Effect, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../../http/request-decoding.js";
import type { AppEnv } from "../../../http/types.js";
import { authorizationLogger } from "../../../logging.js";
import { decodeD1Binding } from "../../../persistence/d1-binding.js";
import { coalescingD1 } from "../../../persistence/d1-coalesce.js";
import {
  pluginJobAction,
  pluginJobsView,
} from "../../../plugins/hosts/durable/jobs-route.js";
import {
  purgeDurableInstall,
  resumeDurableInstall,
} from "../../../plugins/hosts/durable/objects.js";
import { listPluginHostCostLines } from "../../../plugins/hosts/usage.js";
import { readPluginIcon as readStoredIcon } from "../../../plugins/icons/store.js";
import {
  type PluginDevLink,
  PluginTrustPolicies,
} from "../../../plugins/trust/policy.js";
import { pluginTrustData } from "../../../plugins/trust/view.js";

import { settleOwnerAsk } from "../../../thread-artifacts/owner-ask.js";
import { SettingsAudit } from "../../audit.js";
import { McpModuleIdTaken } from "../../mcp-servers/service.js";
import { SettingsService } from "../../service.js";
import { SkillImportRejected } from "../../skills/import.js";
import {
  InvalidWorkspacePolicy,
  WorkspacePolicyService,
} from "../../workspace-policy/service.js";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";
import {
  type ExportIconFile,
  exportIconHashes,
  exportPluginBundle,
} from "./export.js";
import { gitHubFolderChanged } from "./github.js";
import { pluginBundleLayers as layers } from "./layers.js";
import { personalOverlapState } from "./overlap.js";
import { iconDataUrl, type PluginIconFile } from "./plugin-icon.js";
import { pluginPackageKey, readPluginPackage } from "./plugin-package.js";
import {
  approvePluginProposal,
  PluginProposalDecided,
  PluginProposalNotFound,
  PluginProposalStale,
  pendingPluginProposals,
  pluginProposalData,
  rejectPluginProposal,
} from "./proposals.js";
import { type PluginBundleInput, PluginBundleService } from "./service.js";
import { readPluginSettings, writePluginSettings } from "./settings.js";
import { PluginShareLinks } from "./share-links.js";
import {
  describeSignature,
  managedPluginSigner,
  PluginSignatures,
  previewSignature,
} from "./signature.js";

const pluginTrustLogger = getLogger(["dx", "plugins", "trust"]);

export type RouteScope =
  | { readonly mode: "personal" }
  | { readonly mode: "workspace"; readonly workspaceSlug: string };

export interface BundleAccess {
  readonly target: PluginTarget;
  readonly canMutate: boolean;
}

export const authorizePluginBundles = Effect.fn("authorizePluginBundles")(
  function* (route: RouteScope, principal: Principal) {
    const settings = yield* SettingsService;
    if (route.mode === "personal") {
      yield* settings.personal(principal);
      return {
        target: { scope: "personal", id: principal.userId },
        canMutate: true,
      } satisfies BundleAccess;
    }
    const slug = Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug);
    if (Option.isNone(slug)) {
      return yield* new SettingsScopeForbidden({ scope: "workspace" });
    }
    const access = yield* settings.workspace(principal, slug.value);
    return {
      target: { scope: "workspace", id: access.workspace.workspace.id },
      canMutate: access.workspace.role !== "member",
    } satisfies BundleAccess;
  },
);

/**
 * What every bundle row needs beyond the bundle, read once and together for
 * all of a response's bundles: a list costs the same few reads whatever its
 * length.
 */
const bundleContext = Effect.fn("pluginBundleContext")(function* (
  target: PluginTarget,
  viewerUserId: string,
) {
  // Every read selects by the target, not by bundle IDs read first, so they
  // all go out together (one round trip on the coalescing binding).
  const repository = yield* PluginBundleRepository;
  const signatures = yield* PluginSignatures;
  const trustPolicies = yield* PluginTrustPolicies;
  const [copies, shared, signed, own, skills, servers, trust, dev] =
    yield* Effect.all(
      [
        target.scope === "personal"
          ? repository.workspaceCopies(target.id)
          : Effect.succeed(undefined),
        (yield* PluginShareLinks).sharedForTarget(target),
        signatures.forTarget(target),
        signatures.ownFingerprints(viewerUserId),
        (yield* SkillRepository).list(target),
        (yield* McpServerRepository).list(target as McpServerTarget),
        // The governing workspace's cap and trusted signers.
        trustPolicies.forTarget(target),
        target.scope === "personal"
          ? trustPolicies.devLinksForTarget(target)
          : Effect.succeed(new Map<string, PluginDevLink>()),
      ],
      { concurrency: "unbounded" },
    );
  return { copies, shared, signed, own, skills, servers, trust, dev };
});

type BundleContext = Effect.Success<ReturnType<typeof bundleContext>>;

/** The icon files an export writes, read from `plugin_icon` at once. */
const exportIconFiles = async (
  db: D1Database | undefined,
  manifest: StoredPluginBundle["manifest"],
) => {
  const files = new Map<string, ExportIconFile>();
  if (db === undefined) return files;
  await Promise.all(
    exportIconHashes(manifest).map(async (hash) => {
      const file = await readStoredIcon(db, hash);
      if (file !== undefined) files.set(hash, file);
    }),
  );
  return files;
};

/** The icon set's files as data URLs, for the install review. */
const previewIconFiles = (bundle: {
  readonly manifest: StoredPluginBundle["manifest"];
  readonly iconFiles?: ReadonlyArray<PluginIconFile>;
}) => {
  const set = bundle.manifest.iconSet;
  if (set === undefined) return {};
  const wanted = new Set([set.src, set.dark, set.monochrome]);
  const iconFiles: Record<string, string> = {};
  for (const file of bundle.iconFiles ?? [])
    if (wanted.has(file.hash))
      iconFiles[file.hash] = iconDataUrl({
        mediaType: file.mediaType,
        data: btoa(
          Array.from(file.bytes, (byte) => String.fromCharCode(byte)).join(""),
        ),
      });
  return Object.keys(iconFiles).length === 0 ? {} : { iconFiles };
};

/** One bundle with the skills and MCP servers it installed. */
const bundleData = (bundle: StoredPluginBundle, known: BundleContext) => {
  const shared = known.shared.has(bundle.id);
  const signature = known.signed.get(bundle.id);
  const overlap =
    bundle.target.scope === "personal" && known.copies !== undefined
      ? personalOverlapState(known.copies, bundle.name)
      : undefined;
  const installedSkills = known.skills.filter(
    ({ skill }) => skill.pluginId === bundle.id,
  );
  const installedServers = known.servers.filter(
    ({ server }) => server.pluginId === bundle.id,
  );
  return {
    id: bundle.id,
    scope: bundle.target.scope,
    name: bundle.name,
    displayName: bundle.manifest.displayName,
    description: bundle.manifest.description,
    ...(bundle.manifest.version === undefined
      ? {}
      : { version: bundle.manifest.version }),
    ...(bundle.manifest.icon === undefined
      ? {}
      : { icon: iconDataUrl(bundle.manifest.icon) }),
    ...(bundle.manifest.iconSet === undefined
      ? {}
      : { iconSet: bundle.manifest.iconSet }),
    enabled: bundle.enabled,
    source: bundle.source,
    integrity: bundle.integrity,
    skills: installedSkills.map(({ skill }) => ({
      id: skill.id,
      name: skill.name,
      enabled: skill.enabled,
    })),
    mcpServers: installedServers.map(({ server, tools }) => ({
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      reviewed: tools.some(
        (tool) =>
          tool.approvedSchemaHash !== undefined &&
          tool.approvedSchemaHash === tool.schemaHash,
      ),
    })),
    ...(bundle.manifest.code === undefined
      ? {}
      : { code: bundle.manifest.code }),
    localMcpServers: bundle.manifest.mcpServers
      .filter(isStdioMcpServer)
      .map((server) => ({
        name: server.name,
        command: stdioCommandLine(server),
      })),
    skipped: bundle.manifest.skipped,
    // A disabled personal copy replaces nothing: the workspace's runs.
    ...(overlap === undefined ||
    (overlap.kind === "replacing" && !bundle.enabled)
      ? {}
      : { overlap }),
    ...(shared ? { shared } : {}),
    ...(signature === undefined
      ? {}
      : { signature: describeSignature(signature, known.own) }),
    ...(bundle.manifest.code === undefined
      ? {}
      : {
          trust: pluginTrustData(
            bundle.target.scope,
            bundle.manifest.code,
            known.trust,
            signature?.fingerprint,
          ),
        }),
    ...(known.dev.get(bundle.id) === undefined
      ? {}
      : { dev: known.dev.get(bundle.id) }),
    installedAt: bundle.installedAt,
    updatedAt: bundle.updatedAt,
  } satisfies PluginBundleData;
};

/** Rows for bundles of one target, as the viewer sees them. */
const bundlesData = Effect.fn("pluginBundlesData")(function* (
  target: PluginTarget,
  bundles: ReadonlyArray<StoredPluginBundle>,
  viewerUserId: string,
) {
  const known = yield* bundleContext(target, viewerUserId);
  return bundles.map((bundle) => bundleData(bundle, known));
});

const rejected = (reason: string) => new PluginBundleRejected({ reason });

const readZipBody = (request: Request) =>
  Effect.tryPromise({
    try: async () => {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_PLUGIN_ARCHIVE_BYTES) {
        return "too-large" as const;
      }
      const reader = request.body?.getReader();
      if (reader === undefined) return new Uint8Array();
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PLUGIN_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return "too-large" as const;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.byteLength;
      }
      return bytes;
    },
    catch: () => rejected("The upload was interrupted. Try again."),
  }).pipe(
    Effect.flatMap((bytes) =>
      bytes === "too-large"
        ? Effect.fail(
            rejected(
              `The archive is larger than ${MAX_PLUGIN_ARCHIVE_BYTES.toLocaleString("en-US")} bytes.`,
            ),
          )
        : Effect.succeed(bytes),
    ),
  );

const isZip = (context: Context<AppEnv>) =>
  /^application\/(?:zip|x-zip-compressed|octet-stream)\b/i.test(
    context.req.header("content-type") ?? "",
  );

const PreviewGitHubRequest = Schema.Union([
  Schema.Struct({ url: Schema.String }),
  /** A share link's token. */
  Schema.Struct({ share: Schema.String }),
]);

const InstallShareRequest = Schema.Struct({
  share: Schema.String,
  reviewedIntegrity: PluginIntegrity,
});

const InstallGitHubRequest = Schema.Struct({
  source: PluginBundleSource,
  reviewedIntegrity: PluginIntegrity,
  /** An update only: the person accepted the wider grants it asks for. */
  acceptPermissions: Schema.optional(Schema.Boolean),
});

/**
 * A ZIP upload is the request body, named by `?name=`; a GitHub URL is JSON.
 * Installing a ZIP repeats the upload with `?integrity=`, and installing from
 * GitHub sends the previewed source, pinned to its commit.
 */
const previewInput = (context: Context<AppEnv>) =>
  isZip(context)
    ? readZipBody(context.req.raw).pipe(
        Effect.map(
          (bytes): PluginBundleInput => ({
            type: "zip",
            label: context.req.query("name") ?? "plugin.zip",
            bytes,
          }),
        ),
      )
    : decodeJsonBody(context.req, PreviewGitHubRequest, () =>
        rejected("Send a ZIP archive, a GitHub URL, or a share link."),
      ).pipe(
        Effect.map(
          (body): PluginBundleInput =>
            "share" in body
              ? { type: "share", token: body.share }
              : { type: "github-url", url: body.url },
        ),
      );

const installInput = (context: Context<AppEnv>, updating = false) =>
  isZip(context)
    ? Effect.gen(function* () {
        const integrity = yield* decodeRequestInput(
          PluginIntegrity,
          context.req.query("integrity"),
          () => rejected("Preview the archive before installing it."),
        );
        const input = yield* previewInput(context);
        return {
          input,
          integrity,
          acceptPermissions: context.req.query("acceptPermissions") === "1",
        };
      })
    : decodeJsonBody(
        context.req,
        Schema.Union([InstallShareRequest, InstallGitHubRequest]),
        () => rejected("Preview the plugin before installing it."),
      ).pipe(
        Effect.flatMap((body) => {
          if ("share" in body)
            return Effect.succeed({
              input: { type: "share", token: body.share } as PluginBundleInput,
              integrity: body.reviewedIntegrity,
              acceptPermissions: false,
            });
          const { source, reviewedIntegrity, acceptPermissions } = body;
          const accepted = acceptPermissions === true;
          if (source.type === "github")
            return Effect.succeed({
              input: { type: "github-commit", source } as PluginBundleInput,
              integrity: reviewedIntegrity,
              acceptPermissions: accepted,
            });
          // A copy's update reads its link again; a new install needs the
          // link's token, never only its ID.
          if (source.type === "share" && updating)
            return Effect.succeed({
              input: {
                type: "share-latest",
                linkId: source.linkId,
              } as PluginBundleInput,
              integrity: reviewedIntegrity,
              acceptPermissions: accepted,
            });
          return Effect.fail(
            rejected(
              source.type === "share"
                ? "Open the share link again to install it."
                : "Upload the ZIP archive again to install it.",
            ),
          );
        }),
      );

export const pluginBundleFailureResponse = (
  context: Context<AppEnv>,
  failure: unknown,
) => {
  const requestId = context.get("requestId");
  const fixed = (
    schema: Schema.ConstraintEncoder<unknown>,
    status: 403 | 404 | 409 | 503,
    code: string,
    message: string,
  ) =>
    context.json(
      Schema.encodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId },
      }),
      status,
    );
  if (failure instanceof PluginBundleRejected) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleRejectedResponseSchema)({
        status: "error",
        data: {
          code: "PLUGIN_BUNDLE_REJECTED",
          message: failure.reason,
          requestId,
        },
      }),
      400,
    );
  }
  if (failure instanceof PluginBundleSourceUnavailable) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleSourceUnavailableResponseSchema)({
        status: "error",
        data: {
          code: "PLUGIN_BUNDLE_SOURCE_UNAVAILABLE",
          message: failure.reason,
          requestId,
        },
      }),
      502,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Plugin bundle scope authorization failed.", {
      event: "plugin_bundle_scope_authorization_failed",
      requestId,
    });
    return fixed(
      PluginBundlesForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof PluginNotFound) {
    return fixed(
      PluginBundleNotFoundResponseSchema,
      404,
      "PLUGIN_NOT_FOUND",
      "Plugin not found.",
    );
  }
  if (failure instanceof PluginProposalNotFound) {
    return fixed(
      PluginBundleNotFoundResponseSchema,
      404,
      "PLUGIN_NOT_FOUND",
      "Plugin not found.",
    );
  }
  if (failure instanceof PluginProposalStale) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleRejectedResponseSchema)({
        status: "error",
        data: {
          code: "PLUGIN_BUNDLE_REJECTED",
          message:
            "The installed plugin changed since dx proposed this update. Reject it and ask dx to propose again.",
          requestId,
        },
      }),
      400,
    );
  }
  if (failure instanceof PluginProposalDecided) {
    return fixed(
      PluginProposalDecidedResponseSchema,
      409,
      "PLUGIN_PROPOSAL_DECIDED",
      "This proposal was already decided.",
    );
  }
  if (failure instanceof PluginIntegrityConflict) {
    return fixed(
      PluginBundleIntegrityConflictResponseSchema,
      409,
      "PLUGIN_INTEGRITY_CONFLICT",
      "The plugin changed since you reviewed it. Preview it again.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof WorkspacePolicyConflict ||
    failure instanceof SettingsMembershipInvariantViolation ||
    Schema.isSchemaError(failure)
  ) {
    return fixed(
      PluginBundlesUnavailableResponseSchema,
      503,
      "PLUGINS_UNAVAILABLE",
      "Plugins are temporarily unavailable.",
    );
  }
  // A skill or MCP server the bundle installs can be refused by its store.
  const refusal =
    failure instanceof InvalidWorkspacePolicy
      ? "The workspace policy has a runner profile selection that no longer exists. Fix it in the workspace policy first."
      : failure instanceof SkillImportRejected
        ? failure.reason
        : failure instanceof SkillLimitExceeded
          ? "Skills in this scope are at their limit."
          : failure instanceof McpServerLimitExceeded
            ? "MCP servers in this scope are at their limit."
            : failure instanceof McpModuleIdTaken
              ? "An MCP server with the same ID already exists."
              : undefined;
  if (refusal !== undefined) {
    return context.json(
      Schema.encodeUnknownSync(PluginBundleRejectedResponseSchema)({
        status: "error",
        data: { code: "PLUGIN_BUNDLE_REJECTED", message: refusal, requestId },
      }),
      400,
    );
  }
  throw failure;
};

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
  status: 200 | 201 = 200,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, status)
    : pluginBundleFailureResponse(context, result.failure);
};

const registerRoutes = (
  router: Hono<AppEnv>,
  routeFor: (context: Context<AppEnv>) => RouteScope,
) => {
  const operation = <A, E, R>(
    context: Context<AppEnv>,
    use: (access: BundleAccess, db: D1Database) => Effect.Effect<A, E, R>,
    options: {
      readonly mutate: boolean;
      /** Install and update: their writes go out as one atomic batch. */
      readonly deferWrites?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const binding = yield* decodeD1Binding(context.env.DB);
      // Reads (and writes) a request issues together go to D1 as one
      // batch, in the order issued; install and update also hold their
      // writes back for one atomic batch (layers.ts).
      const db = options.deferWrites === true ? binding : coalescingD1(binding);
      return yield* Effect.gen(function* () {
        const access = yield* authorizePluginBundles(
          routeFor(context),
          context.get("principal"),
        );
        if (options.mutate && !access.canMutate) {
          return yield* new SettingsScopeForbidden({ scope: "workspace" });
        }
        return yield* use(access, db);
      }).pipe(
        Effect.provide(
          layers(db, context.env.DX_STORAGE, {
            deferWrites: options.deferWrites === true,
          }),
        ),
      );
    });
  const audit = (context: Context<AppEnv>) => ({
    userId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });
  const workspaceSlugOf = (context: Context<AppEnv>) => {
    const route = routeFor(context);
    const slug =
      route.mode === "workspace"
        ? Schema.decodeOption(WorkspaceSlug)(route.workspaceSlug)
        : Option.none();
    return Option.isSome(slug)
      ? Effect.succeed(slug.value)
      : Effect.fail(new SettingsScopeForbidden({ scope: "workspace" }));
  };
  const policyView = (context: Context<AppEnv>) =>
    Effect.gen(function* () {
      const slug = yield* workspaceSlugOf(context);
      return yield* (yield* WorkspacePolicyService).get(
        context.get("principal"),
        slug,
      );
    });
  const parseId = (context: Context<AppEnv>) =>
    decodeRequestInput(
      PluginBundleParamsSchema,
      { pluginId: context.req.param("pluginId") },
      () => new PluginNotFound(),
    ).pipe(Effect.map(({ pluginId }) => pluginId));

  router.get("/", (context) =>
    run(
      context,
      operation(
        context,
        (access, db) =>
          Effect.gen(function* () {
            const repository = yield* PluginBundleRepository;
            // Every read runs together: on the coalescing binding they go
            // to D1 as one batch after the access check.
            const [bundles, policy, pending, known] = yield* Effect.all(
              [
                repository.list(access.target),
                access.target.scope === "workspace"
                  ? (yield* WorkspacePolicyRepository)
                      .get(access.target.id)
                      .pipe(Effect.map((view) => view.restrictions))
                  : Effect.succeed(undefined),
                // Only people who could approve a proposal see it.
                access.canMutate
                  ? pendingPluginProposals(db, access.target)
                  : Effect.succeed([]),
                bundleContext(access.target, context.get("principal").userId),
              ],
              { concurrency: "unbounded" },
            );
            const items = bundles.map((bundle) => bundleData(bundle, known));
            // A row that no longer decodes is left out rather than failing
            // the page.
            const proposals = (yield* Effect.forEach(pending, (row) =>
              pluginProposalData(row, context.get("principal").userId).pipe(
                Effect.option,
              ),
            )).flatMap(Option.toArray);
            return yield* Schema.encodeUnknownEffect(
              ListPluginBundlesResponseSchema,
            )({
              status: "success",
              data: {
                items,
                canMutate: access.canMutate,
                proposals,
                ...(policy === undefined
                  ? {}
                  : {
                      personalOverridesAllowed:
                        policy.allowPersonalPluginInstallOverrides,
                      repositoryPluginsAllowed: policy.allowRepositoryPlugins,
                    }),
                ...(policy === undefined || !access.canMutate
                  ? {}
                  : {
                      pluginTrust: {
                        tierCap: policy.pluginTierCap ?? "verified",
                        trustedProjectIds: policy.trustedPluginProjectIds ?? [],
                        trustedSigners: policy.trustedPluginSigners ?? [],
                      },
                    }),
              },
            });
          }),
        { mutate: false },
      ),
    ),
  );

  /**
   * The workspace's "allow personal plugin overrides" policy for installed
   * plugins, written through WorkspacePolicyService so revision, audit, and
   * the admin check stay in one owner.
   */
  router.put("/policy", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            if (access.target.scope !== "workspace") {
              return yield* new SettingsScopeForbidden({ scope: "workspace" });
            }
            const body = yield* decodeJsonBody(
              context.req,
              SetPluginBundlePolicyRequestSchema,
              () => rejected("The policy request is not valid."),
            );
            const policies = yield* WorkspacePolicyService;
            const slug = yield* workspaceSlugOf(context);
            const current = yield* policyView(context);
            const restrictions = {
              ...current.policy.restrictions,
              ...(body.allowPersonalOverrides === undefined
                ? {}
                : {
                    allowPersonalPluginInstallOverrides:
                      body.allowPersonalOverrides,
                  }),
              ...(body.allowRepositoryPlugins === undefined
                ? {}
                : { allowRepositoryPlugins: body.allowRepositoryPlugins }),
              ...(body.pluginTierCap === undefined
                ? {}
                : { pluginTierCap: body.pluginTierCap }),
              ...(body.trustedPluginProjectIds === undefined
                ? {}
                : {
                    trustedPluginProjectIds: [
                      ...new Set(body.trustedPluginProjectIds),
                    ],
                  }),
              ...(body.trustedPluginSigners === undefined
                ? {}
                : {
                    trustedPluginSigners: [
                      ...new Set(body.trustedPluginSigners),
                    ],
                  }),
            };
            const before = current.policy.restrictions;
            if (
              restrictions.allowPersonalPluginInstallOverrides !==
                before.allowPersonalPluginInstallOverrides ||
              restrictions.allowRepositoryPlugins !==
                before.allowRepositoryPlugins ||
              restrictions.pluginTierCap !== before.pluginTierCap ||
              JSON.stringify(restrictions.trustedPluginProjectIds) !==
                JSON.stringify(before.trustedPluginProjectIds) ||
              JSON.stringify(restrictions.trustedPluginSigners) !==
                JSON.stringify(before.trustedPluginSigners)
            ) {
              yield* policies.update(
                context.get("principal"),
                slug,
                { restrictions },
                current.policy.revision,
                [],
                context.get("requestId"),
              );
            }
            const bundles = yield* (yield* PluginBundleRepository).list(
              access.target,
            );
            const items = yield* bundlesData(
              access.target,
              bundles,
              context.get("principal").userId,
            );
            return yield* Schema.encodeUnknownEffect(
              ListPluginBundlesResponseSchema,
            )({
              status: "success",
              data: {
                items,
                canMutate: access.canMutate,
                personalOverridesAllowed:
                  restrictions.allowPersonalPluginInstallOverrides,
                repositoryPluginsAllowed: restrictions.allowRepositoryPlugins,
                pluginTrust: {
                  tierCap: restrictions.pluginTierCap ?? "verified",
                  trustedProjectIds: restrictions.trustedPluginProjectIds ?? [],
                  trustedSigners: restrictions.trustedPluginSigners ?? [],
                },
              },
            });
          }),
        { mutate: true },
      ),
    ),
  );

  /**
   * Which GitHub plugins changed at their source since install, for the
   * "Update available" notice. Plugins dx can't check are left out.
   */
  router.get("/updates", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const bundles = yield* (yield* PluginBundleRepository).list(
              access.target,
            );
            const items: Array<{
              readonly pluginId: PluginId;
              readonly available: boolean;
            }> = [];
            const checked = yield* Effect.promise(() =>
              Promise.all(
                bundles.map(async (bundle) => {
                  if (bundle.source.type !== "github") return undefined;
                  const available = await gitHubFolderChanged(bundle.source);
                  return available === undefined
                    ? undefined
                    : { pluginId: bundle.id, available };
                }),
              ),
            );
            for (const item of checked)
              if (item !== undefined) items.push(item);
            // A shared copy is out of date when the shared install's active
            // version differs from the one it read: one read for all copies.
            // A revoked link or a removed install names no update.
            const copies = bundles.flatMap((bundle) =>
              bundle.source.type === "share" ? [bundle.source] : [],
            );
            const service = yield* PluginBundleService;
            const versions = yield* (yield* PluginShareLinks).activeVersions(
              copies.map(({ linkId }) => linkId),
            );
            for (const bundle of bundles) {
              if (bundle.source.type !== "share") continue;
              const active = versions.get(bundle.source.linkId);
              if (active === undefined) continue;
              // A copy from before versions were recorded compares content.
              const available =
                bundle.source.sharedVersion !== undefined
                  ? active !== bundle.source.sharedVersion
                  : yield* service.previewUpdate(access.target, bundle.id).pipe(
                      Effect.map(({ upToDate }) => !upToDate),
                      Effect.orElseSucceed(() => false),
                    );
              items.push({ pluginId: bundle.id, available });
            }
            return yield* Schema.encodeUnknownEffect(
              ListPluginBundleUpdatesResponseSchema,
            )({
              status: "success",
              data: { items },
            });
          }),
        { mutate: false },
      ),
    ),
  );

  const parseProposalId = (context: Context<AppEnv>) =>
    decodeRequestInput(
      PluginProposalParamsSchema,
      { proposalId: context.req.param("proposalId") },
      () => new PluginProposalNotFound(),
    ).pipe(Effect.map(({ proposalId }) => proposalId));

  /**
   * Ticks the owner's review ask in the proposing Thread, which wakes it
   * with the outcome. Best effort: the decision already stands.
   */
  const settleAsk = (
    context: Context<AppEnv>,
    row: {
      readonly id: string;
      readonly thread_id: string;
      readonly ask_artifact_id: string | null;
    },
    outcome: string,
  ) =>
    row.ask_artifact_id === null
      ? Effect.void
      : Effect.promise(() =>
          settleOwnerAsk(context.env, {
            threadId: row.thread_id,
            artifactId: row.ask_artifact_id ?? "",
            marker: row.id,
            outcome,
            writer: { kind: "user", userId: context.get("principal").userId },
          }).catch(() => false),
        );

  router.post("/proposals/:proposalId/approve", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const proposalId = yield* parseProposalId(context);
            const body = yield* decodeJsonBody(
              context.req,
              ApprovePluginProposalRequestSchema,
              () => rejected("Send the reviewedIntegrity you approved."),
            );
            const db = yield* decodeD1Binding(context.env.DB);
            const approved = yield* approvePluginProposal(
              db,
              access.target,
              proposalId,
              body.reviewedIntegrity,
              audit(context),
            );
            yield* settleAsk(
              context,
              approved.row,
              approved.row.change === "new"
                ? `Approved: ${approved.plugin.manifest.displayName} is installed and loads in new Threads.`
                : `Approved: ${approved.plugin.manifest.displayName} is updated${approved.plugin.manifest.version === undefined ? "" : ` to ${approved.plugin.manifest.version}`}; new Threads load it.`,
            );
            return yield* Schema.encodeUnknownEffect(
              DecidePluginProposalResponseSchema,
            )({ status: "success", data: { proposalId, status: "approved" } });
          }),
        { mutate: true },
      ),
    ),
  );

  router.post("/proposals/:proposalId/reject", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const proposalId = yield* parseProposalId(context);
            const db = yield* decodeD1Binding(context.env.DB);
            const decided = yield* rejectPluginProposal(
              db,
              access.target,
              proposalId,
              audit(context),
            );
            yield* settleAsk(context, decided.row, "Rejected.");
            return yield* Schema.encodeUnknownEffect(
              DecidePluginProposalResponseSchema,
            )({ status: "success", data: { proposalId, status: "rejected" } });
          }),
        { mutate: true },
      ),
    ),
  );

  /**
   * Shares the install: anyone signed in who opens the link can review it
   * and install a copy that updates from this install. Taking the right to
   * change the plugin, as exporting the whole thing to others does.
   */
  router.post("/:pluginId/share", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const link = yield* (yield* PluginShareLinks).create(
              bundle.id,
              context.get("principal").userId,
            );
            yield* (yield* SettingsAudit).record({
              action: "plugin_bundle.share",
              scope: access.target.scope,
              outcome: "success",
              requestId: context.get("requestId"),
              userId: context.get("principal").userId,
              pluginId: bundle.id,
              resourceId: link.linkId,
            });
            let origin = "";
            try {
              origin =
                context.env.DX_AUTH_URL === undefined
                  ? new URL(context.req.url).origin
                  : new URL(context.env.DX_AUTH_URL).origin;
            } catch {}
            return yield* Schema.encodeUnknownEffect(
              CreatePluginShareLinkResponseSchema,
            )({
              status: "success",
              data: {
                linkId: link.linkId,
                token: link.token,
                url: `${origin}/settings/plugins?share=${link.token}`,
              },
            });
          }),
        { mutate: true },
      ),
      201,
    ),
  );

  router.delete("/:pluginId/share", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const revoked = yield* (yield* PluginShareLinks).revokeAll(
              bundle.id,
            );
            yield* (yield* SettingsAudit).record({
              action: "plugin_bundle.unshare",
              scope: access.target.scope,
              outcome: "success",
              requestId: context.get("requestId"),
              userId: context.get("principal").userId,
              pluginId: bundle.id,
            });
            return yield* Schema.encodeUnknownEffect(
              RevokePluginShareLinksResponseSchema,
            )({ status: "success", data: { revoked } });
          }),
        { mutate: true },
      ),
    ),
  );

  // Anyone who can list the plugin can export it, as with a skill.
  router.get("/:pluginId/export", async (context) => {
    const result = await Effect.runPromise(
      Effect.result(
        operation(
          context,
          (access) =>
            Effect.gen(function* () {
              const id = yield* parseId(context);
              const repository = yield* PluginBundleRepository;
              const bundle = yield* repository.find(access.target, id);
              const skills = (yield* (yield* SkillRepository).list(
                bundle.target,
              )).filter(({ skill }) => skill.pluginId === bundle.id);
              const servers = (yield* (yield* McpServerRepository).list(
                bundle.target as McpServerTarget,
              ))
                .filter(({ server }) => server.pluginId === bundle.id)
                .map(({ server }) => server);
              const codeModules =
                bundle.manifest.code === undefined
                  ? []
                  : yield* repository.codeModules(bundle.id, bundle.version);
              const pkg = bundle.manifest.package;
              const storage = context.env.DX_STORAGE;
              const packageFiles =
                pkg === undefined || storage === undefined
                  ? []
                  : yield* Effect.tryPromise({
                      try: async () => {
                        const object = await storage.get(
                          pluginPackageKey(pkg.sha256),
                        );
                        if (object === null) return [];
                        return readPluginPackage(
                          new Uint8Array(await object.arrayBuffer()),
                        );
                      },
                      catch: () =>
                        rejected("dx could not read the plugin's files."),
                    });
              // `?sign=1` adds plugin.sig, signed with the person's managed key.
              const signer =
                context.req.query("sign") === "1"
                  ? yield* managedPluginSigner(
                      context.env,
                      yield* decodeD1Binding(context.env.DB),
                      context.get("principal").userId,
                    )
                  : undefined;
              const iconFiles = yield* Effect.promise(() =>
                exportIconFiles(context.env.DB, bundle.manifest),
              );
              return yield* Effect.promise(() =>
                exportPluginBundle(
                  {
                    bundle,
                    skills,
                    mcpServers: servers,
                    codeModules,
                    packageFiles,
                    iconFiles,
                  },
                  signer === undefined
                    ? undefined
                    : (files) => Effect.runPromise(signer(files)),
                ),
              );
            }),
          { mutate: false },
        ),
      ),
    );
    if (Result.isFailure(result)) {
      return pluginBundleFailureResponse(context, result.failure);
    }
    const { filename, bytes } = result.success;
    return new Response(bytes.slice().buffer, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  router.post("/preview", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const input = yield* previewInput(context);
            const service = yield* PluginBundleService;
            const preview = yield* service.preview(access.target, input);
            return yield* Schema.encodeUnknownEffect(
              PreviewPluginBundleResponseSchema,
            )({
              status: "success",
              data: {
                manifest: preview.bundle.manifest,
                ...previewIconFiles(preview.bundle),
                source: preview.source,
                integrity: preview.bundle.integrity,
                conflicts: preview.conflicts,
                ...(yield* previewSignature(
                  preview.signature,
                  context.get("principal").userId,
                )),
              },
            });
          }),
        { mutate: true },
      ),
    ),
  );

  router.post("/", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const { input, integrity } = yield* installInput(context);
            const service = yield* PluginBundleService;
            const installed = yield* service.install(
              access.target,
              input,
              integrity,
              audit(context),
            );
            return yield* Schema.encodeUnknownEffect(
              InstallPluginBundleResponseSchema,
            )({
              status: "success",
              data: (yield* bundlesData(
                access.target,
                [installed],
                context.get("principal").userId,
              ))[0],
            });
          }),
        { mutate: true, deferWrites: true },
      ),
      201,
    ),
  );

  router.post("/:pluginId/update/preview", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const zip = isZip(context)
              ? yield* previewInput(context)
              : undefined;
            const service = yield* PluginBundleService;
            const preview = yield* service.previewUpdate(
              access.target,
              id,
              zip?.type === "zip" ? zip : undefined,
            );
            return yield* Schema.encodeUnknownEffect(
              PreviewPluginBundleUpdateResponseSchema,
            )({
              status: "success",
              data: {
                manifest: preview.bundle.manifest,
                ...previewIconFiles(preview.bundle),
                source: preview.source,
                integrity: preview.bundle.integrity,
                conflicts: preview.conflicts,
                ...(yield* previewSignature(
                  preview.signature,
                  context.get("principal").userId,
                )),
                upToDate: preview.upToDate,
                permissions: preview.permissions,
                skills: preview.skills,
                mcpServers: preview.mcpServers,
              },
            });
          }),
        { mutate: true },
      ),
    ),
  );

  router.post("/:pluginId/update", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const { input, integrity, acceptPermissions } = yield* installInput(
              context,
              true,
            );
            const service = yield* PluginBundleService;
            const updated = yield* service.update(
              access.target,
              id,
              input,
              integrity,
              audit(context),
              acceptPermissions,
            );
            return yield* Schema.encodeUnknownEffect(
              UpdatePluginBundleSourceResponseSchema,
            )({
              status: "success",
              data: (yield* bundlesData(
                access.target,
                [updated],
                context.get("principal").userId,
              ))[0],
            });
          }),
        { mutate: true, deferWrites: true },
      ),
    ),
  );

  router.patch("/:pluginId", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const body = yield* decodeJsonBody(
              context.req,
              UpdatePluginBundleRequestSchema,
              () => rejected("Send enabled: true or false."),
            );
            const service = yield* PluginBundleService;
            yield* service.setEnabled(
              access.target,
              id,
              body.enabled,
              audit(context),
            );
            // Rich plugins (P3): jobs held while it was off resume now.
            if (body.enabled)
              try {
                context.executionCtx.waitUntil(
                  resumeDurableInstall(
                    context.env,
                    id,
                    context.get("requestId"),
                  ),
                );
              } catch {}
            const repository = yield* PluginBundleRepository;
            const updated = yield* repository.find(access.target, id);
            return yield* Schema.encodeUnknownEffect(
              UpdatePluginBundleResponseSchema,
            )({
              status: "success",
              data: (yield* bundlesData(
                access.target,
                [updated],
                context.get("principal").userId,
              ))[0],
            });
          }),
        { mutate: true },
      ),
    ),
  );

  // Personal-dev hot reload, on or off, for the owner's own personal plugin
  // installed from a ZIP, bound to one of the person's own Threads: only that
  // Thread's Orb may reload it. Only this browser request turns it on;
  // `dxd plugin dev` can only use it.
  router.put("/:pluginId/dev", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            if (access.target.scope !== "personal")
              return yield* rejected(
                "Hot reload is for your own personal plugins.",
              );
            const id = yield* parseId(context);
            const body = yield* decodeJsonBody(
              context.req,
              SetPluginDevRequestSchema,
              () => rejected("Send enabled: true or false."),
            );
            if (body.enabled && body.threadId === undefined)
              return yield* rejected(
                "Turn hot reload on for one Thread: run dxd plugin dev in it, and open the link it prints.",
              );
            const repository = yield* PluginBundleRepository;
            const bundle = yield* repository.find(access.target, id);
            if (body.enabled && bundle.source.type !== "zip")
              return yield* rejected(
                "Hot reload works for plugins installed from a ZIP.",
              );
            if (body.enabled && bundle.manifest.code === undefined)
              return yield* rejected("This plugin has no code to reload.");
            const threadId = body.enabled ? body.threadId : undefined;
            if (threadId !== undefined) {
              // The person's own Thread, not archived: a Thread someone
              // shared with them is driven by its owner's Orb.
              const db = yield* decodeD1Binding(context.env.DB);
              const owned = yield* Effect.tryPromise({
                try: () =>
                  db
                    .prepare(
                      `SELECT 1 AS ok FROM threads
                        WHERE id = ?1 AND owner_user_id = ?2
                          AND lifecycle_state = 'active'`,
                    )
                    .bind(threadId, context.get("principal").userId)
                    .first(),
                catch: (cause) =>
                  PersistenceUnavailable.new(
                    { operation: "pluginDev.thread" },
                    cause,
                  ),
              });
              if (owned === null)
                return yield* rejected(
                  "Hot reload turns on only for an active Thread of your own.",
                );
            }
            yield* (yield* PluginTrustPolicies).setDev(id, threadId);
            pluginTrustLogger.info(
              `Plugin ${bundle.name} hot reload ${body.enabled ? "on" : "off"}.`,
              {
                event: "plugin_dev_toggle",
                requestId: context.get("requestId"),
                installId: id,
                enabled: body.enabled,
                threadId,
              },
            );
            return yield* Schema.encodeUnknownEffect(
              UpdatePluginBundleResponseSchema,
            )({
              status: "success",
              data: (yield* bundlesData(
                access.target,
                [bundle],
                context.get("principal").userId,
              ))[0],
            });
          }),
        { mutate: true },
      ),
    ),
  );

  // ─── Durable host ───
  // A plugin's background jobs: anyone who can list the plugin sees them;
  // stopping or starting one takes the right to change the plugin.
  router.get("/:pluginId/jobs", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const data = yield* Effect.tryPromise(() =>
              pluginJobsView({
                bindings: context.env,
                bundle,
                viewerUserId: context.get("principal").userId,
                canMutate: access.canMutate,
                requestId: context.get("requestId"),
              }),
            );
            return yield* Schema.encodeUnknownEffect(PluginJobsResponseSchema)({
              status: "success",
              data,
            });
          }),
        { mutate: false },
      ),
    ),
  );

  for (const action of ["stop", "start"] as const)
    router.post(`/:pluginId/jobs/:jobId/${action}`, (context) =>
      run(
        context,
        operation(
          context,
          (access) =>
            Effect.gen(function* () {
              const id = yield* parseId(context);
              const { jobId } = yield* decodeRequestInput(
                PluginJobParamsSchema,
                { jobId: context.req.param("jobId") },
                () => rejected("That is not a job id."),
              );
              const body = yield* decodeJsonBody(
                context.req,
                PluginJobActionRequestSchema,
                () => rejected("Send {} or { threadId }."),
              );
              const bundle = yield* (yield* PluginBundleRepository).find(
                access.target,
                id,
              );
              const done = yield* Effect.tryPromise(() =>
                pluginJobAction({
                  bindings: context.env,
                  bundle,
                  viewerUserId: context.get("principal").userId,
                  requestId: context.get("requestId"),
                  action,
                  jobId,
                  ...(body.threadId === undefined
                    ? {}
                    : { threadId: body.threadId }),
                }),
              );
              if (!done)
                return yield* rejected(
                  "This plugin's jobs do not run here: its tier does not allow the durable host.",
                );
              return yield* Schema.encodeUnknownEffect(
                PluginJobsResponseSchema,
              )({
                status: "success",
                data: yield* Effect.tryPromise(() =>
                  pluginJobsView({
                    bindings: context.env,
                    bundle,
                    viewerUserId: context.get("principal").userId,
                    canMutate: access.canMutate,
                    requestId: context.get("requestId"),
                  }),
                ),
              });
            }),
          { mutate: true },
        ),
      ),
    );

  // Install-time settings of the plugin's code. Anyone who can list the
  // plugin reads them; changing them takes the right to change the plugin.
  router.get("/:pluginId/settings", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const db = yield* decodeD1Binding(context.env.DB);
            const settings = yield* Effect.tryPromise({
              try: () => readPluginSettings(db, bundle),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "settings.pluginBundles.readSettings" },
                  cause,
                ),
            });
            return yield* Schema.encodeUnknownEffect(
              PluginBundleSettingsResponseSchema,
            )({ status: "success", data: { settings } });
          }),
        { mutate: false },
      ),
    ),
  );

  // ─── Host cost line ───
  // What the plugin's long-lived hosts cost this month, charged to the
  // installer's workspace (decision D4). Read when its details open, never
  // on a plugin call.
  router.get("/:pluginId/host-usage", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const db = yield* decodeD1Binding(context.env.DB);
            const now = Date.now();
            const lines = yield* Effect.tryPromise({
              try: () => listPluginHostCostLines(db, [bundle.id], now),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "settings.pluginBundles.hostUsage" },
                  cause,
                ),
            });
            return yield* Schema.encodeUnknownEffect(
              PluginHostUsageResponseSchema,
            )({
              status: "success",
              data: {
                month: new Date(now).toISOString().slice(0, 7),
                lines: lines.map(({ pluginId: _pluginId, ...line }) => line),
              },
            });
          }),
        { mutate: false },
      ),
    ),
  );

  router.put("/:pluginId/settings", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const body = yield* decodeJsonBody(
              context.req,
              UpdatePluginBundleSettingsRequestSchema,
              () => rejected("Send values: an object of setting values."),
            );
            const bundle = yield* (yield* PluginBundleRepository).find(
              access.target,
              id,
            );
            const db = yield* decodeD1Binding(context.env.DB);
            yield* Effect.tryPromise({
              try: () =>
                writePluginSettings(
                  db,
                  bundle,
                  body.values,
                  context.get("principal").userId,
                ),
              catch: (cause) =>
                cause instanceof PluginBundleRejected
                  ? cause
                  : PersistenceUnavailable.new(
                      { operation: "settings.pluginBundles.writeSettings" },
                      cause,
                    ),
            });
            const settings = yield* Effect.tryPromise({
              try: () => readPluginSettings(db, bundle),
              catch: (cause) =>
                PersistenceUnavailable.new(
                  { operation: "settings.pluginBundles.readSettings" },
                  cause,
                ),
            });
            return yield* Schema.encodeUnknownEffect(
              PluginBundleSettingsResponseSchema,
            )({ status: "success", data: { settings } });
          }),
        { mutate: true },
      ),
    ),
  );

  router.delete("/:pluginId", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const service = yield* PluginBundleService;
            yield* service.remove(access.target, id, audit(context));
            // Rich plugins (P3): its Durable Objects and blobs go too.
            try {
              context.executionCtx.waitUntil(
                purgeDurableInstall(context.env, id, context.get("requestId")),
              );
            } catch {}
            return yield* Schema.encodeUnknownEffect(
              RemovePluginBundleResponseSchema,
            )({ status: "success", data: { removedPluginId: id } });
          }),
        { mutate: true },
      ),
    ),
  );
};

export const personalPluginBundleRoutes = new Hono<AppEnv>();
registerRoutes(personalPluginBundleRoutes, () => ({ mode: "personal" }));

export const workspacePluginBundleRoutes = new Hono<AppEnv>();
registerRoutes(workspacePluginBundleRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
