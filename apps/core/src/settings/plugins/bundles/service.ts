import {
  isReservedPluginName,
  isStdioMcpServer,
  MAX_MCP_SERVERS_PER_SCOPE,
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARCHIVE_ENTRIES,
  MAX_PLUGINS_PER_SCOPE,
  MAX_SKILLS_PER_SCOPE,
  McpServerRepository,
  type McpServerTarget,
  mcpModuleIdFor,
  type PluginBundleManifest,
  type PluginBundleRemoteMcpServer,
  PluginBundleRepository,
  type PluginBundleSource,
  type PluginCatalogId,
  type PluginCatalogReference,
  PluginCatalogRepository,
  PluginId,
  type PluginIntegrity,
  PluginIntegrityConflict,
  PluginNotFound,
  type PluginTarget,
  pluginPublisherDomain,
  SkillRepository,
  type StoredMcpServer,
  StoredPluginBundle,
  type StoredPluginCatalog,
  stdioCommandLine,
  type UserId,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../../audit.js";
import {
  effectiveMcpModuleId,
  McpServerService,
} from "../../mcp-servers/service.js";
import { SkillService } from "../../skills/service.js";
import { WorkspacePolicyService } from "../../workspace-policy/service.js";
import { proveDomain } from "../catalogs/proof.js";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";
import { exportPluginBundle } from "./export.js";
import {
  fetchGitHubArchive,
  fetchGitHubPlugin,
  parseGitHubPluginUrl,
} from "./github.js";
import { personalOverlapState } from "./overlap.js";
import {
  type PluginPermissionDiff,
  pluginPermissionDiff,
} from "./permission-diff.js";
import { PluginPackageStore } from "./plugin-package.js";
import { type ParsedBundle, readPluginBundle } from "./read-bundle.js";
import { PluginShareLinks } from "./share-links.js";
import {
  INVALID_SIGNATURE_CONFLICT,
  type PluginSignature,
  type PluginSignatureCheck,
  PluginSignatures,
  verifyPluginSignature,
  withPublisher,
} from "./signature.js";
import { readZipArchive } from "./zip.js";

interface AuditContext {
  readonly userId: UserId;
  readonly requestId: string;
}

/** Where a bundle comes from, as the person gave it. */
export type PluginBundleInput =
  | {
      readonly type: "zip";
      readonly label: string;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "github-url"; readonly url: string }
  | {
      readonly type: "github-commit";
      readonly source: Extract<PluginBundleSource, { type: "github" }>;
    }
  | {
      /** The latest commit of an installed bundle's ref and folder. */
      readonly type: "github-latest";
      readonly source: Extract<PluginBundleSource, { type: "github" }>;
    }
  | {
      /** A catalog entry's folder in a repository, at its ref or pin. */
      readonly type: "github-location";
      readonly repository: string;
      readonly ref: string;
      readonly path: string;
      readonly pin?: string;
      readonly catalog?: PluginCatalogReference;
      /** The commit the person reviewed; another commit is a conflict. */
      readonly expectCommit?: string;
    }
  /** The install a share link shares, by the link's secret token. */
  | { readonly type: "share"; readonly token: string }
  /** An installed copy's share link, for its updates. */
  | { readonly type: "share-latest"; readonly linkId: string };

export interface PluginBundlePreview {
  readonly bundle: ParsedBundle;
  readonly source: PluginBundleSource;
  /** `plugin.sig`, checked against the files; invalid ones are a conflict. */
  readonly signature: PluginSignatureCheck;
  /** Reasons the bundle cannot be installed here; empty when it can. */
  readonly conflicts: ReadonlyArray<string>;
}

export type PluginBundleChange = "added" | "changed" | "removed" | "unchanged";

/** What updating an installed bundle to a new preview would change. */
export interface PluginBundleUpdatePreview extends PluginBundlePreview {
  readonly upToDate: boolean;
  /** What the new version adds to or drops from the reviewed grants. */
  readonly permissions: PluginPermissionDiff;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly change: PluginBundleChange;
  }>;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    /** A remote server's URL. */
    readonly endpoint?: string;
    /** A local server's command line, as it runs in the Orb. */
    readonly command?: string;
    readonly change: PluginBundleChange;
    /** The update moves the server to another origin and drops its secrets. */
    readonly credentialsCleared: boolean;
  }>;
}

/** The bundle's remote servers: the ones the MCP server store holds. */
const remoteServers = (manifest: PluginBundleManifest) =>
  manifest.mcpServers.filter(
    (server): server is PluginBundleRemoteMcpServer =>
      !isStdioMcpServer(server),
  );

const localServers = (manifest: PluginBundleManifest) =>
  manifest.mcpServers.filter(isStdioMcpServer);

/** Whether two endpoints share scheme, host, and port. */
const sameOrigin = (left: string, right: string) =>
  new URL(left).origin === new URL(right).origin;

/** Whether anything authenticates to the server that a move would expose. */
const holdsCredentials = (server: StoredMcpServer) =>
  server.headers.some(({ secret }) => secret) ||
  server.hasStoredCredential === true ||
  server.authReference !== undefined ||
  server.hasOAuthClientSecret === true ||
  server.authType === "oauth";

/**
 * Whether a server's plain headers match the bundle's. Secret headers are
 * ones a person added in MCP settings; an update keeps them.
 */
const sameHeaders = (
  installed: ReadonlyArray<{
    readonly name: string;
    readonly secret: boolean;
    readonly value?: string;
  }>,
  bundled: ReadonlyArray<{ readonly name: string; readonly value?: string }>,
) => {
  const left = installed.filter(({ secret }) => !secret);
  const right = bundled;
  const key = (
    headers: ReadonlyArray<{ readonly name: string; readonly value?: string }>,
  ) =>
    JSON.stringify(
      [...headers]
        .map(({ name, value }) => [name.toLowerCase(), value ?? ""])
        .sort(),
    );
  return key(left) === key(right);
};

const limits = {
  maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
  maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
};

const commitPattern = /^[0-9a-f]{40}$/;

const load = Effect.fn("PluginBundleService.load")(function* (
  input: Exclude<PluginBundleInput, { type: "share" | "share-latest" }>,
) {
  if (input.type === "zip") {
    const archive = yield* readZipArchive(input.bytes, limits);
    const label = input.label.trim().slice(0, 128) || "plugin.zip";
    const bundle = yield* readPluginBundle(archive, {
      root: "",
      fallbackName: label.replace(/\.zip$/i, ""),
    });
    const signature = yield* verifyPluginSignature(archive, "");
    return { bundle, source: { type: "zip", label }, signature } as const;
  }
  const location =
    input.type === "github-url"
      ? parseGitHubPluginUrl(input.url)
      : {
          repository:
            input.type === "github-location"
              ? input.repository
              : input.source.repository,
          treeSegments: [],
        };
  const catalog =
    input.type === "github-location"
      ? input.catalog
      : input.type === "github-url"
        ? undefined
        : input.source.catalog;
  if (location === undefined) {
    return yield* new PluginBundleRejected({
      reason:
        "Use a GitHub URL such as https://github.com/owner/repo or https://github.com/owner/repo/tree/main/plugins/name.",
    });
  }
  const fetched =
    input.type === "github-url"
      ? yield* fetchGitHubPlugin(location)
      : input.type === "github-location"
        ? yield* fetchGitHubArchive(
            input.repository,
            input.pin ?? input.ref,
          ).pipe(
            Effect.flatMap((bytes) =>
              bytes === undefined
                ? Effect.fail(
                    new PluginBundleSourceUnavailable({
                      reason: `GitHub has no public repository ${input.repository} at ${input.pin ?? input.ref}.`,
                    }),
                  )
                : Effect.succeed({
                    bytes,
                    ref: input.ref,
                    path: input.path,
                  }),
            ),
          )
        : yield* fetchGitHubArchive(
            input.source.repository,
            input.type === "github-latest"
              ? input.source.ref
              : input.source.commit,
          ).pipe(
            Effect.flatMap((bytes) =>
              bytes === undefined
                ? Effect.fail(
                    new PluginBundleSourceUnavailable({
                      reason:
                        input.type === "github-latest"
                          ? `GitHub no longer has ${input.source.repository} at ${input.source.ref}.`
                          : "GitHub no longer has the commit you reviewed.",
                    }),
                  )
                : Effect.succeed({
                    bytes,
                    ref: input.source.ref,
                    path: input.source.path,
                  }),
            ),
          );
  const archive = yield* readZipArchive(fetched.bytes, limits);
  const commit = archive.comment.trim();
  if (!commitPattern.test(commit)) {
    return yield* new PluginBundleSourceUnavailable({
      reason: "GitHub did not say which commit it sent. Try again.",
    });
  }
  if (
    (input.type === "github-commit" && commit !== input.source.commit) ||
    (input.type === "github-location" &&
      input.expectCommit !== undefined &&
      commit !== input.expectCommit)
  ) {
    return yield* new PluginIntegrityConflict();
  }
  const repositoryName = location.repository.split("/")[1] ?? "plugin";
  const bundle = yield* readPluginBundle(archive, {
    root: fetched.path,
    fallbackName:
      fetched.path === ""
        ? repositoryName
        : fetched.path.slice(fetched.path.lastIndexOf("/") + 1),
  });
  const signature = yield* verifyPluginSignature(archive, fetched.path);
  return {
    bundle,
    signature,
    source: {
      type: "github",
      repository: location.repository,
      ref: fetched.ref,
      path: fetched.path,
      commit,
      ...(catalog === undefined ? {} : { catalog }),
    },
  } as const;
});

interface PluginBundleServiceShape {
  readonly preview: (
    target: PluginTarget,
    input: PluginBundleInput,
  ) => Effect.Effect<PluginBundlePreview, unknown>;
  readonly install: (
    target: PluginTarget,
    input: PluginBundleInput,
    reviewedIntegrity: PluginIntegrity,
    audit: AuditContext,
  ) => Effect.Effect<StoredPluginBundle, unknown>;
  /**
   * Reads an installed bundle's source again (the latest commit of its
   * GitHub ref, or a new ZIP) and lists what an update would change.
   */
  readonly previewUpdate: (
    target: PluginTarget,
    id: PluginId,
    /** A new ZIP, or a pinned commit; the source's latest when absent. */
    input?: PluginBundleInput,
  ) => Effect.Effect<PluginBundleUpdatePreview, unknown>;
  /**
   * Replaces the bundle's skills and MCP servers with the reviewed content.
   * Unchanged items keep their state, such as approved MCP tools.
   */
  readonly update: (
    target: PluginTarget,
    id: PluginId,
    input: PluginBundleInput,
    reviewedIntegrity: PluginIntegrity,
    audit: AuditContext,
    /** The person accepted the wider grants the preview listed. */
    acceptPermissions?: boolean,
  ) => Effect.Effect<StoredPluginBundle, unknown>;
  readonly setEnabled: (
    target: PluginTarget,
    id: PluginId,
    enabled: boolean,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
  readonly remove: (
    target: PluginTarget,
    id: PluginId,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
}

export class PluginBundleService extends Context.Service<
  PluginBundleService,
  PluginBundleServiceShape
>()("@dx/core/settings/plugins/PluginBundleService") {
  static readonly layer = Layer.effect(
    PluginBundleService,
    Effect.gen(function* () {
      const bundles = yield* PluginBundleRepository;
      const skillRepository = yield* SkillRepository;
      const skills = yield* SkillService;
      const mcpRepository = yield* McpServerRepository;
      const mcpServers = yield* McpServerService;
      const settingsAudit = yield* SettingsAudit;
      const policies = yield* WorkspacePolicyService;
      const catalogs = yield* PluginCatalogRepository;
      // The service lives for one request, so an install that claims a
      // catalog identity reads the catalog row once, not twice.
      const foundCatalogs = new Map<string, StoredPluginCatalog | undefined>();
      const findCatalog = (target: PluginTarget, id: PluginCatalogId) => {
        const key = `${target.scope}:${target.id}:${id}`;
        return foundCatalogs.has(key)
          ? Effect.succeed(foundCatalogs.get(key))
          : catalogs.find(target, id).pipe(
              Effect.catchTag("PluginCatalogNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.tap((found) =>
                Effect.sync(() => foundCatalogs.set(key, found)),
              ),
            );
      };

      /**
       * The naming rule: `dev.dxcode.<name>` belongs to dx's own plugins, and
       * a plugin keeps a catalog identity only while that catalog still
       * lists it and its publisher has proven the name's domain. Plain names
       * are fine outside a catalog.
       */
      const namingConflicts = Effect.fn("PluginBundleService.namingConflicts")(
        function* (
          target: PluginTarget,
          name: string,
          source: PluginBundleSource,
        ) {
          const catalog = source.type === "github" ? source.catalog : undefined;
          if (catalog === undefined || source.type !== "github") {
            return isReservedPluginName(name)
              ? [
                  "Names starting with dev.dxcode. are reserved for dx's own plugins.",
                ]
              : [];
          }
          const stored = yield* findCatalog(target, catalog.id);
          if (stored === undefined) {
            return [`The catalog ${catalog.name} isn't added here anymore.`];
          }
          const entry = stored.entries.find(
            (item) =>
              item.name === name &&
              item.source.type === "github" &&
              item.source.repository.toLowerCase() ===
                source.repository.toLowerCase() &&
              item.source.path === source.path,
          );
          if (entry === undefined) {
            return [
              `${stored.name} doesn't list a plugin named ${name} at this location.`,
            ];
          }
          const domain = pluginPublisherDomain(name);
          if (domain === undefined) {
            return [
              `Catalog plugins need a publisher prefix, such as com.example.${name}.`,
            ];
          }
          const proof = yield* proveDomain(domain, stored.source.repository);
          return proof === "none"
            ? [`${stored.name} hasn't proven that it publishes for ${domain}.`]
            : [];
        },
      );

      const packages = yield* PluginPackageStore;
      const shares = yield* PluginShareLinks;
      const signatures = yield* PluginSignatures;

      /**
       * A shared install's active version, exported and read back exactly
       * as an uploaded ZIP is, so the same rules and review apply.
       */
      const loadShared = Effect.fn("PluginBundleService.loadShared")(function* (
        input: Extract<PluginBundleInput, { type: "share" | "share-latest" }>,
      ) {
        const link = yield* shares.resolve(
          input.type === "share"
            ? { token: input.token }
            : { linkId: input.linkId },
        );
        if (link === undefined) {
          return yield* input.type === "share"
            ? Effect.fail(new PluginNotFound())
            : Effect.fail(
                new PluginBundleSourceUnavailable({
                  reason:
                    "This plugin is no longer shared. Ask its owner for a new link.",
                }),
              );
        }
        const shared = yield* bundles.find(link.target, link.pluginId);
        const sharedSkills = (yield* skillRepository.list(
          shared.target,
        )).filter(({ skill }) => skill.pluginId === shared.id);
        const sharedServers = (yield* mcpRepository.list(
          shared.target as McpServerTarget,
        ))
          .filter(({ server }) => server.pluginId === shared.id)
          .map(({ server }) => server);
        const codeModules =
          shared.manifest.code === undefined
            ? []
            : yield* bundles.codeModules(shared.id, shared.version);
        const pkg = shared.manifest.package;
        const packageFiles =
          pkg === undefined ? [] : yield* packages.files(pkg.sha256);
        const { bytes } = yield* Effect.promise(() =>
          exportPluginBundle({
            bundle: shared,
            skills: sharedSkills,
            mcpServers: sharedServers,
            codeModules,
            packageFiles,
          }),
        );
        const archive = yield* readZipArchive(bytes, limits);
        const bundle = yield* readPluginBundle(archive, {
          root: "",
          fallbackName: shared.name,
        });
        // The export carries no plugin.sig: the copy keeps the signature
        // dx verified when the shared version was installed.
        // Only while the copy reads exactly the signed version: skills edited
        // after install change the content, and the signature no longer
        // speaks for it.
        const kept =
          bundle.integrity === shared.integrity
            ? (yield* signatures.forPlugins([shared])).get(shared.id)
            : undefined;
        return {
          bundle,
          signature: (kept === undefined
            ? { status: "unsigned" }
            : { status: "signed", ...kept }) satisfies PluginSignatureCheck,
          source: {
            type: "share",
            linkId: link.linkId,
            label: `Shared by ${link.sharerName}`.slice(0, 128),
            sharedVersion: shared.version,
          },
        } as const;
      });

      const loadAny = (input: PluginBundleInput) =>
        input.type === "share" || input.type === "share-latest"
          ? loadShared(input)
          : load(input).pipe(
              Effect.flatMap((loaded) =>
                withPublisher(
                  loaded.bundle.manifest.name,
                  loaded.signature,
                ).pipe(Effect.map((signature) => ({ ...loaded, signature }))),
              ),
            );

      /** A signature that doesn't match its files blocks the install. */
      const signatureConflicts = (signature: PluginSignatureCheck) =>
        signature.status === "invalid" ? [INVALID_SIGNATURE_CONFLICT] : [];

      const recordSignature = (
        pluginId: PluginId,
        version: string,
        signature: PluginSignatureCheck,
      ) =>
        signature.status === "signed"
          ? signatures.record(pluginId, version, {
              fingerprint: signature.fingerprint,
              publicKey: signature.publicKey,
              ...(signature.publisher === undefined
                ? {}
                : { publisher: signature.publisher }),
            } satisfies PluginSignature)
          : Effect.void;

      /** Keeps the plugin's files for the Orb before anything points at them. */
      const storePackage = (bundle: ParsedBundle) => {
        const summary = bundle.manifest.package;
        return summary === undefined || bundle.packageBytes === undefined
          ? Effect.void
          : packages.put(summary.sha256, bundle.packageBytes);
      };

      const audit = (
        action: string,
        target: PluginTarget,
        context: AuditContext,
        pluginId: PluginId,
        pluginVersion?: string,
      ) =>
        settingsAudit.record({
          action,
          scope: target.scope,
          outcome: "success",
          requestId: context.requestId,
          userId: context.userId,
          pluginId,
          ...(pluginVersion === undefined ? {} : { pluginVersion }),
        });

      /**
       * A source that claims a catalog identity is read where the catalog
       * says, never where the client says: the entry's pin, or the head of
       * the entry's ref. So a fork's commit or another ref can't borrow the
       * identity.
       */
      const throughCatalog = Effect.fn("PluginBundleService.throughCatalog")(
        function* (target: PluginTarget, input: PluginBundleInput) {
          if (
            input.type !== "github-commit" &&
            input.type !== "github-latest"
          ) {
            return input;
          }
          const { source } = input;
          if (source.catalog === undefined) return input;
          const stored = yield* findCatalog(target, source.catalog.id);
          if (stored === undefined) {
            return yield* new PluginBundleRejected({
              reason: `The catalog ${source.catalog.name} isn't added here anymore.`,
            });
          }
          const entry = stored.entries.find(
            ({ source: listed }) =>
              listed.type === "github" &&
              listed.repository.toLowerCase() ===
                source.repository.toLowerCase() &&
              listed.path === source.path,
          );
          if (entry === undefined || entry.source.type !== "github") {
            return yield* new PluginBundleRejected({
              reason: `${stored.name} doesn't list this plugin anymore.`,
            });
          }
          return {
            type: "github-location",
            repository: entry.source.repository,
            ref: entry.source.ref,
            path: entry.source.path,
            ...(entry.source.pin === undefined
              ? {}
              : { pin: entry.source.pin }),
            catalog: source.catalog,
            ...(input.type === "github-commit"
              ? { expectCommit: source.commit }
              : {}),
          } satisfies PluginBundleInput;
        },
      );

      const conflictsFor = Effect.fn("PluginBundleService.conflictsFor")(
        function* (
          target: PluginTarget,
          bundle: ParsedBundle,
          source: PluginBundleSource,
          /** The installed bundle an update replaces, whose items don't conflict. */
          updating?: StoredPluginBundle,
        ) {
          const conflicts: Array<string> = [];
          const names = yield* bundles.names(target);
          // An update keeps the installed name; an identity is proven again.
          if (
            updating === undefined ||
            (source.type === "github" && source.catalog !== undefined)
          ) {
            conflicts.push(
              ...(yield* namingConflicts(target, bundle.manifest.name, source)),
            );
          }
          const own = (pluginId: PluginId | undefined) =>
            updating !== undefined && pluginId === updating.id;
          if (updating !== undefined) {
            if (bundle.manifest.name !== updating.name) {
              conflicts.push(
                `The source now holds a plugin named ${bundle.manifest.name}, not ${updating.name}.`,
              );
            }
          } else if (names.includes(bundle.manifest.name)) {
            conflicts.push(
              `A plugin named ${bundle.manifest.name} is already installed here.`,
            );
          } else if (names.length >= MAX_PLUGINS_PER_SCOPE) {
            conflicts.push(
              `This scope already has ${MAX_PLUGINS_PER_SCOPE} plugins.`,
            );
          }
          if (updating === undefined && target.scope === "personal") {
            // The same plugin never runs from both a workspace and a personal
            // install (overlap.ts); without the workspace's opt-in the
            // personal copy would only ever be paused.
            const overlap = personalOverlapState(
              yield* bundles.workspaceCopies(target.id),
              bundle.manifest.name,
            );
            if (overlap?.kind === "paused") {
              conflicts.push(
                `Your workspace already provides ${bundle.manifest.displayName}.`,
              );
            }
          }
          if (bundle.skills.length > 0) {
            const existing = (yield* skillRepository.list(target)).filter(
              ({ skill }) => !own(skill.pluginId),
            );
            for (const { manifest } of bundle.skills) {
              if (existing.some(({ skill }) => skill.name === manifest.name)) {
                conflicts.push(
                  `A skill named ${manifest.name} already exists in Skills.`,
                );
              }
            }
            if (existing.length + bundle.skills.length > MAX_SKILLS_PER_SCOPE) {
              conflicts.push(
                `Skills hold at most ${MAX_SKILLS_PER_SCOPE} skills per scope.`,
              );
            }
          }
          if (
            bundle.manifest.mcpServers.length > 0 &&
            target.scope === "personal"
          ) {
            const allowed = yield* policies
              .evaluateForUser(target.id, { kind: "mcp.use-personal-override" })
              .pipe(
                Effect.as(true),
                Effect.catchTag("WorkspacePolicyDenied", () =>
                  Effect.succeed(false),
                ),
              );
            if (!allowed) {
              conflicts.push(
                "Your workspace does not allow personal MCP servers.",
              );
            }
          }
          if (bundle.manifest.mcpServers.length > 0) {
            const remote = remoteServers(bundle.manifest);
            const existing = (yield* mcpRepository.list(
              target as McpServerTarget,
            )).filter(({ server }) => !own(server.pluginId));
            const taken = new Set(
              existing.map(({ server }) => effectiveMcpModuleId(server)),
            );
            for (const server of bundle.manifest.mcpServers) {
              const moduleId = mcpModuleIdFor(server.name);
              if (taken.has(moduleId)) {
                conflicts.push(
                  `An MCP server with the ID ${moduleId} already exists.`,
                );
              }
              taken.add(moduleId);
            }
            if (existing.length + remote.length > MAX_MCP_SERVERS_PER_SCOPE) {
              conflicts.push(
                `MCP servers are limited to ${MAX_MCP_SERVERS_PER_SCOPE} per scope.`,
              );
            }
          }
          return conflicts;
        },
      );

      const preview = Effect.fn("PluginBundleService.preview")(function* (
        target: PluginTarget,
        input: PluginBundleInput,
      ) {
        const loaded = yield* loadAny(yield* throughCatalog(target, input));
        const conflicts = yield* conflictsFor(
          target,
          loaded.bundle,
          loaded.source,
        );
        return {
          ...loaded,
          conflicts: [...signatureConflicts(loaded.signature), ...conflicts],
        } satisfies PluginBundlePreview;
      });

      /** Removes everything a bundle installed, then the bundle row. */
      const removeInstalled = Effect.fn("PluginBundleService.removeInstalled")(
        function* (
          target: PluginTarget,
          id: PluginId,
          auditContext: AuditContext,
        ) {
          const installedSkills = (yield* skillRepository.list(target)).filter(
            ({ skill }) => skill.pluginId === id,
          );
          for (const { skill } of installedSkills) {
            yield* skills.remove(target, skill.id, auditContext);
          }
          const installedServers = (yield* mcpRepository.list(
            target as McpServerTarget,
          )).filter(({ server }) => server.pluginId === id);
          for (const { server } of installedServers) {
            yield* mcpServers.remove(
              target as McpServerTarget,
              server.id,
              auditContext,
            );
          }
          const removedAt = yield* DateTime.now;
          yield* bundles
            .remove(target, id, removedAt)
            .pipe(Effect.catchTag("PluginNotFound", () => Effect.void));
        },
      );

      const installedItems = Effect.fn("PluginBundleService.installedItems")(
        function* (target: PluginTarget, id: PluginId) {
          const installedSkills = (yield* skillRepository.list(target)).filter(
            ({ skill }) => skill.pluginId === id,
          );
          const installedServers = (yield* mcpRepository.list(
            target as McpServerTarget,
          )).filter(({ server }) => server.pluginId === id);
          return { installedSkills, installedServers };
        },
      );

      const previewUpdate = Effect.fn("PluginBundleService.previewUpdate")(
        function* (
          target: PluginTarget,
          id: PluginId,
          input: PluginBundleInput | undefined,
        ) {
          const current = yield* bundles.find(target, id);
          const source = current.source;
          const loadInput: PluginBundleInput | undefined =
            input ??
            (source.type === "github"
              ? { type: "github-latest", source }
              : source.type === "share"
                ? { type: "share-latest", linkId: source.linkId }
                : undefined);
          if (loadInput === undefined) {
            return yield* new PluginBundleRejected({
              reason: "Upload the plugin's new ZIP to update it.",
            });
          }
          // A copy updates only through the link it was installed from.
          if (
            loadInput.type === "share-latest" &&
            (source.type !== "share" || source.linkId !== loadInput.linkId)
          ) {
            return yield* new PluginIntegrityConflict();
          }
          // The identity is the installed one, whatever the client sent.
          const installedCatalog =
            source.type === "github" ? source.catalog : undefined;
          const withIdentity: PluginBundleInput =
            loadInput.type === "github-commit"
              ? {
                  type: "github-commit",
                  source: {
                    type: "github",
                    repository: loadInput.source.repository,
                    ref: loadInput.source.ref,
                    path: loadInput.source.path,
                    commit: loadInput.source.commit,
                    ...(installedCatalog === undefined
                      ? {}
                      : { catalog: installedCatalog }),
                  },
                }
              : loadInput;
          const loaded = yield* loadAny(
            yield* throughCatalog(target, withIdentity),
          );
          const conflicts = [
            ...signatureConflicts(loaded.signature),
            ...(yield* conflictsFor(
              target,
              loaded.bundle,
              loaded.source,
              current,
            )),
          ];
          const { installedSkills, installedServers } = yield* installedItems(
            target,
            id,
          );
          const next = new Map(
            loaded.bundle.skills.map((skill) => [skill.manifest.name, skill]),
          );
          const skills = [
            ...loaded.bundle.skills.map(({ manifest, integrity }) => {
              const installed = installedSkills.find(
                ({ skill }) => skill.name === manifest.name,
              );
              return {
                name: manifest.name as string,
                change: (installed === undefined
                  ? "added"
                  : installed.active.integrity === integrity
                    ? "unchanged"
                    : "changed") as PluginBundleChange,
              };
            }),
            ...installedSkills
              .filter(({ skill }) => !next.has(skill.name))
              .map(({ skill }) => ({
                name: skill.name as string,
                change: "removed" as PluginBundleChange,
              })),
          ];
          const nextServers = remoteServers(loaded.bundle.manifest);
          const nextLocal = localServers(loaded.bundle.manifest);
          const currentLocal = localServers(current.manifest);
          const mcpServers = [
            ...nextLocal.map((server) => {
              const installed = currentLocal.find(
                ({ name }) => name === server.name,
              );
              return {
                name: server.name as string,
                command: stdioCommandLine(server),
                credentialsCleared: false,
                change: (installed === undefined
                  ? "added"
                  : JSON.stringify(installed) === JSON.stringify(server) &&
                      current.manifest.package?.sha256 ===
                        loaded.bundle.manifest.package?.sha256
                    ? "unchanged"
                    : "changed") as PluginBundleChange,
              };
            }),
            ...currentLocal
              .filter(
                ({ name }) => !nextLocal.some((next) => next.name === name),
              )
              .map((server) => ({
                name: server.name as string,
                command: stdioCommandLine(server),
                credentialsCleared: false,
                change: "removed" as PluginBundleChange,
              })),
            ...nextServers.map((server) => {
              const installed = installedServers.find(
                ({ server: existing }) => existing.name === server.name,
              );
              return {
                name: server.name as string,
                endpoint: server.endpoint as string,
                credentialsCleared:
                  installed !== undefined &&
                  !sameOrigin(installed.server.endpoint, server.endpoint) &&
                  holdsCredentials(installed.server),
                change: (installed === undefined
                  ? "added"
                  : installed.server.endpoint === server.endpoint &&
                      installed.server.authType === server.authType &&
                      sameHeaders(installed.server.headers, server.headers)
                    ? "unchanged"
                    : "changed") as PluginBundleChange,
              };
            }),
            ...installedServers
              .filter(
                ({ server }) =>
                  !nextServers.some(({ name }) => name === server.name),
              )
              .map(({ server }) => ({
                name: server.name as string,
                endpoint: server.endpoint as string,
                credentialsCleared: false,
                change: "removed" as PluginBundleChange,
              })),
          ];
          return {
            ...loaded,
            conflicts,
            upToDate: loaded.bundle.integrity === current.integrity,
            permissions: pluginPermissionDiff(
              current.manifest,
              loaded.bundle.manifest,
            ),
            skills,
            mcpServers,
          } satisfies PluginBundleUpdatePreview;
        },
      );

      return PluginBundleService.of({
        previewUpdate: (target, id, input) => previewUpdate(target, id, input),
        update: Effect.fn("PluginBundleService.update")(function* (
          target,
          id,
          input,
          reviewedIntegrity,
          auditContext,
          acceptPermissions = false,
        ) {
          const current = yield* bundles.find(target, id);
          const reviewed = yield* previewUpdate(target, id, input);
          if (reviewed.bundle.integrity !== reviewedIntegrity) {
            return yield* new PluginIntegrityConflict();
          }
          if (reviewed.upToDate) {
            return yield* new PluginBundleRejected({
              reason: "The plugin is already up to date.",
            });
          }
          const [conflict] = reviewed.conflicts;
          if (conflict !== undefined) {
            return yield* new PluginBundleRejected({ reason: conflict });
          }
          // Wider grants are a new review (plan §7); same or fewer update
          // with one click.
          if (reviewed.permissions.widens && !acceptPermissions) {
            return yield* new PluginBundleRejected({
              reason:
                "This version asks for more permissions. Review them and accept to update.",
            });
          }
          const { bundle } = reviewed;
          const { installedSkills, installedServers } = yield* installedItems(
            target,
            id,
          );
          // The plugin's files are stored before anything changes, so a
          // storage failure leaves the installed version as it was.
          yield* storePackage(bundle);
          // Removals first, so an added item may reuse a removed one's name.
          for (const { skill } of installedSkills) {
            if (
              !bundle.skills.some(
                ({ manifest }) => manifest.name === skill.name,
              )
            ) {
              yield* skills.remove(target, skill.id, auditContext);
            }
          }
          for (const { server } of installedServers) {
            if (
              !remoteServers(bundle.manifest).some(
                ({ name }) => name === server.name,
              )
            ) {
              yield* mcpServers.remove(
                target as McpServerTarget,
                server.id,
                auditContext,
              );
            }
          }
          for (const preview of bundle.skills) {
            const installed = installedSkills.find(
              ({ skill }) => skill.name === preview.manifest.name,
            );
            if (installed === undefined) {
              yield* skills.createFromPreview(target, preview, auditContext, {
                enabled: true,
                pluginId: id,
              });
            } else if (installed.active.integrity !== preview.integrity) {
              // A skill someone pinned keeps its pinned version active.
              yield* skills.publishFromPreview(
                target,
                installed.skill.id,
                preview,
                !installed.skill.pinned,
                auditContext,
              );
            }
          }
          for (const server of remoteServers(bundle.manifest)) {
            const installed = installedServers.find(
              ({ server: existing }) => existing.name === server.name,
            );
            // Secrets a person entered belong to the server's origin: they
            // stay for a new path on the same host, never follow a move.
            const moved =
              installed !== undefined &&
              !sameOrigin(installed.server.endpoint, server.endpoint);
            const headers = [
              ...server.headers.map(({ name, value }) => ({
                name,
                secret: false,
                value,
              })),
              ...(moved
                ? []
                : (installed?.server.headers.filter(({ secret }) => secret) ??
                  [])),
            ];
            if (installed === undefined) {
              yield* mcpServers.create(
                target as McpServerTarget,
                {
                  name: server.name,
                  endpoint: server.endpoint,
                  authType: server.authType,
                  timeoutMs: 10_000 as never,
                  headers,
                  projectIds: [],
                  roles: ["owner", "admin", "member"],
                  pluginId: id,
                },
                auditContext,
              );
            } else if (
              installed.server.endpoint !== server.endpoint ||
              installed.server.authType !== server.authType ||
              !sameHeaders(installed.server.headers, server.headers)
            ) {
              // Clear credentials before the endpoint moves, so a failure
              // between the two never leaves secrets on the new host.
              if (moved) {
                yield* mcpRepository.clearCredentials(
                  target as McpServerTarget,
                  installed.server.id,
                );
              }
              // A new endpoint or auth clears discovered tools, so they are
              // reviewed again before any of them runs.
              yield* mcpServers.update(
                target as McpServerTarget,
                installed.server.id,
                {
                  endpoint: server.endpoint,
                  authType: server.authType,
                  headers,
                  authModeChanged:
                    moved || installed.server.authType !== server.authType,
                  ...(moved
                    ? { clearAuthReference: true, oauthClientId: null }
                    : {}),
                },
                auditContext,
              );
            }
          }
          const now = yield* DateTime.now;
          const stored = yield* Schema.decodeUnknownEffect(
            Schema.toType(StoredPluginBundle),
          )({
            ...current,
            version: bundle.version,
            manifest: bundle.manifest,
            source: reviewed.source,
            integrity: bundle.integrity,
            installedAt: now,
            installedByUserId: auditContext.userId,
            updatedAt: now,
          });
          yield* bundles.insertVersion(stored, bundle.codeModules);
          yield* recordSignature(id, bundle.version, reviewed.signature);
          yield* audit(
            "plugin_bundle.update",
            target,
            auditContext,
            id,
            bundle.version,
          );
          return yield* bundles.find(target, id);
        }),
        preview,
        install: Effect.fn("PluginBundleService.install")(
          function* (target, input, reviewedIntegrity, auditContext) {
            // A new install from a link needs its token; a link's ID only
            // serves the copy installed from it.
            if (input.type === "share-latest") {
              return yield* new PluginBundleRejected({
                reason: "Open the share link again to install it.",
              });
            }
            const reviewed = yield* preview(target, input);
            if (reviewed.bundle.integrity !== reviewedIntegrity) {
              return yield* new PluginIntegrityConflict();
            }
            const [conflict] = reviewed.conflicts;
            if (conflict !== undefined) {
              return yield* new PluginBundleRejected({ reason: conflict });
            }
            const { bundle } = reviewed;
            const id = yield* Schema.decodeEffect(PluginId)(
              `plg_${crypto.randomUUID()}`,
            );
            const now = yield* DateTime.now;
            const stored = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredPluginBundle),
            )({
              id,
              target,
              name: bundle.manifest.name,
              enabled: true,
              version: bundle.version,
              manifest: bundle.manifest,
              source: reviewed.source,
              integrity: bundle.integrity,
              installedAt: now,
              installedByUserId: auditContext.userId,
              updatedAt: now,
            });
            yield* storePackage(bundle);
            yield* bundles.insert(stored, bundle.codeModules);
            yield* recordSignature(id, bundle.version, reviewed.signature);
            yield* Effect.gen(function* () {
              for (const skill of bundle.skills) {
                yield* skills.createFromPreview(target, skill, auditContext, {
                  enabled: true,
                  pluginId: id,
                });
              }
              for (const server of remoteServers(bundle.manifest)) {
                yield* mcpServers.create(
                  target as McpServerTarget,
                  {
                    name: server.name,
                    endpoint: server.endpoint,
                    authType: server.authType,
                    timeoutMs: 10_000 as never,
                    headers: server.headers.map(({ name, value }) => ({
                      name,
                      secret: false,
                      value,
                    })),
                    // No grants: the server is available in every project.
                    projectIds: [],
                    roles: ["owner", "admin", "member"],
                    pluginId: id,
                  },
                  auditContext,
                );
              }
            }).pipe(
              Effect.tapError(() =>
                removeInstalled(target, id, auditContext).pipe(Effect.ignore),
              ),
            );
            yield* audit(
              "plugin_bundle.install",
              target,
              auditContext,
              id,
              bundle.version,
            );
            return yield* bundles.find(target, id);
          },
        ),
        setEnabled: Effect.fn("PluginBundleService.setEnabled")(
          function* (target, id, enabled, auditContext) {
            const updatedAt = yield* DateTime.now;
            yield* bundles.setEnabled(target, id, enabled, updatedAt);
            yield* audit(
              enabled ? "plugin_bundle.enable" : "plugin_bundle.disable",
              target,
              auditContext,
              id,
            );
          },
        ),
        remove: Effect.fn("PluginBundleService.remove")(
          function* (target, id, auditContext) {
            yield* bundles.find(target, id);
            yield* removeInstalled(target, id, auditContext);
            yield* audit("plugin_bundle.remove", target, auditContext, id);
          },
        ),
      });
    }),
  );
}
