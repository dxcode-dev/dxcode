import {
  MAX_MCP_SERVERS_PER_SCOPE,
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_ARCHIVE_ENTRIES,
  MAX_PLUGINS_PER_SCOPE,
  MAX_SKILLS_PER_SCOPE,
  McpServerRepository,
  type McpServerTarget,
  mcpModuleIdFor,
  PluginBundleRepository,
  type PluginBundleSource,
  PluginId,
  type PluginIntegrity,
  PluginIntegrityConflict,
  type PluginTarget,
  SkillRepository,
  StoredPluginBundle,
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
import { type ParsedBundle, readClaudeBundle } from "./claude-format.js";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";
import {
  fetchGitHubArchive,
  fetchGitHubPlugin,
  parseGitHubPluginUrl,
} from "./github.js";
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
    };

export interface PluginBundlePreview {
  readonly bundle: ParsedBundle;
  readonly source: PluginBundleSource;
  /** Reasons the bundle cannot be installed here; empty when it can. */
  readonly conflicts: ReadonlyArray<string>;
}

const limits = {
  maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
  maxEntries: MAX_PLUGIN_ARCHIVE_ENTRIES,
};

const commitPattern = /^[0-9a-f]{40}$/;

const load = Effect.fn("PluginBundleService.load")(function* (
  input: PluginBundleInput,
) {
  if (input.type === "zip") {
    const archive = yield* readZipArchive(input.bytes, limits);
    const label = input.label.trim().slice(0, 128) || "plugin.zip";
    const bundle = yield* readClaudeBundle(archive, {
      root: "",
      fallbackName: label.replace(/\.zip$/i, ""),
    });
    return { bundle, source: { type: "zip", label } } as const;
  }
  const location =
    input.type === "github-url"
      ? parseGitHubPluginUrl(input.url)
      : {
          repository: input.source.repository,
          treeSegments: [],
        };
  if (location === undefined) {
    return yield* new PluginBundleRejected({
      reason:
        "Use a GitHub URL such as https://github.com/owner/repo or https://github.com/owner/repo/tree/main/plugins/name.",
    });
  }
  const fetched =
    input.type === "github-url"
      ? yield* fetchGitHubPlugin(location)
      : yield* fetchGitHubArchive(
          input.source.repository,
          input.source.commit,
        ).pipe(
          Effect.flatMap((bytes) =>
            bytes === undefined
              ? Effect.fail(
                  new PluginBundleSourceUnavailable({
                    reason: "GitHub no longer has the commit you reviewed.",
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
  if (input.type === "github-commit" && commit !== input.source.commit) {
    return yield* new PluginIntegrityConflict();
  }
  const repositoryName = location.repository.split("/")[1] ?? "plugin";
  const bundle = yield* readClaudeBundle(archive, {
    root: fetched.path,
    fallbackName:
      fetched.path === ""
        ? repositoryName
        : fetched.path.slice(fetched.path.lastIndexOf("/") + 1),
  });
  return {
    bundle,
    source: {
      type: "github",
      repository: location.repository,
      ref: fetched.ref,
      path: fetched.path,
      commit,
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

      const conflictsFor = Effect.fn("PluginBundleService.conflictsFor")(
        function* (target: PluginTarget, bundle: ParsedBundle) {
          const conflicts: Array<string> = [];
          const names = yield* bundles.names(target);
          if (names.includes(bundle.manifest.name)) {
            conflicts.push(
              `A plugin named ${bundle.manifest.name} is already installed here.`,
            );
          } else if (names.length >= MAX_PLUGINS_PER_SCOPE) {
            conflicts.push(
              `This scope already has ${MAX_PLUGINS_PER_SCOPE} plugins.`,
            );
          }
          if (bundle.skills.length > 0) {
            const existing = yield* skillRepository.list(target);
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
            const existing = yield* mcpRepository.list(
              target as McpServerTarget,
            );
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
            if (
              existing.length + bundle.manifest.mcpServers.length >
              MAX_MCP_SERVERS_PER_SCOPE
            ) {
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
        const loaded = yield* load(input);
        const conflicts = yield* conflictsFor(target, loaded.bundle);
        return { ...loaded, conflicts } satisfies PluginBundlePreview;
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

      return PluginBundleService.of({
        preview,
        install: Effect.fn("PluginBundleService.install")(
          function* (target, input, reviewedIntegrity, auditContext) {
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
            yield* bundles.insert(stored);
            yield* Effect.gen(function* () {
              for (const skill of bundle.skills) {
                yield* skills.createFromPreview(target, skill, auditContext, {
                  enabled: true,
                  pluginId: id,
                });
              }
              for (const server of bundle.manifest.mcpServers) {
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
