import { Schema } from "effect";
import { findOrbProvider } from "../orb-providers/index.js";
import { FirstPartyPluginId } from "../plugins/plugin.js";
import { PluginTier } from "./plugin-trust.js";
import { RunnerAdapterKind, RunnerProfileId } from "./runner-profile.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_TRUSTED_PLUGIN_PROJECTS = 100;
export const MAX_TRUSTED_PLUGIN_SIGNERS = 50;

export const WorkspacePolicyRestrictions = Schema.Struct({
  allowedRunnerProfileIds: Schema.NullOr(Schema.Array(RunnerProfileId)),
  allowRemoteRunners: Schema.Boolean,
  allowPersonalProviderOverrides: Schema.Boolean,
  allowPersonalMcpOverrides: Schema.Boolean,
  allowPersonalSecretOverrides: Schema.Boolean,
  allowPersonalPluginOverrides: Schema.Boolean,
  /**
   * Members' own Orb (Execution) keys on workspace projects. Defaults to
   * false and applies only together with `allowPersonalPluginOverrides`:
   * a personal Orb key would clone workspace repositories into a member's
   * own provider account, so it needs the admin's explicit opt-in.
   */
  allowPersonalExecutionOverrides: Schema.Boolean,
  /**
   * "Allow personal plugin overrides" for installed plugins. Off by default:
   * a member's personal copy of a plugin this workspace installs is paused.
   * On: the member's own copy runs instead of the workspace's, for that
   * member only. The two copies never run in one Thread.
   */
  allowPersonalPluginInstallOverrides: Schema.Boolean,
  /**
   * Plugins a project's repository carries in `.agents/plugins` or
   * `.dx/plugins` load in its Threads. On by default: the repository is the
   * trust (owner, 2026-11-10); a workspace can turn them off.
   */
  allowRepositoryPlugins: Schema.Boolean,
  // Trust tiers. Optional so clients that predate them keep sending the
  // whole struct; an absent field keeps the stored value.
  /** The highest plugin trust tier the workspace allows; `verified` by default. */
  pluginTierCap: Schema.optional(PluginTier),
  /** Projects whose repository plugins run `workspace-trusted`. */
  trustedPluginProjectIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(MAX_TRUSTED_PLUGIN_PROJECTS),
    ),
  ),
  /** Signing key fingerprints (`SHA256:…`) whose workspace installs are `verified`. */
  trustedPluginSigners: Schema.optional(
    Schema.Array(
      Schema.String.check(Schema.isPattern(/^SHA256:[A-Za-z0-9+/]{43}$/)),
    ).check(Schema.isMaxLength(MAX_TRUSTED_PLUGIN_SIGNERS)),
  ),
});

export type WorkspacePolicyRestrictions =
  typeof WorkspacePolicyRestrictions.Type;

export const WorkspacePolicy = Schema.Struct({
  workspaceId: WorkspaceId,
  restrictions: WorkspacePolicyRestrictions,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.DateTimeUtc,
});

export type WorkspacePolicy = typeof WorkspacePolicy.Type;

export const WorkspacePolicyUpdate = Schema.Struct({
  restrictions: WorkspacePolicyRestrictions,
});

export type WorkspacePolicyUpdate = typeof WorkspacePolicyUpdate.Type;

export const defaultWorkspacePolicy = (
  workspaceId: WorkspaceId,
): WorkspacePolicy => ({
  workspaceId,
  restrictions: {
    allowedRunnerProfileIds: null,
    allowRemoteRunners: true,
    allowPersonalProviderOverrides: true,
    allowPersonalMcpOverrides: true,
    allowPersonalSecretOverrides: true,
    allowPersonalPluginOverrides: true,
    allowPersonalExecutionOverrides: false,
    allowPersonalPluginInstallOverrides: false,
    allowRepositoryPlugins: true,
    pluginTierCap: "verified",
    trustedPluginProjectIds: [],
    trustedPluginSigners: [],
  },
  revision: 0,
  updatedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
    "1970-01-01T00:00:00.000Z",
  ),
});

export const WorkspacePolicyAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project.create"),
    runnerProfileId: RunnerProfileId,
    runnerAdapter: RunnerAdapterKind,
  }),
  Schema.Struct({
    kind: Schema.Literal("execution.admit"),
    runnerProfileId: RunnerProfileId,
    runnerAdapter: RunnerAdapterKind,
  }),
  Schema.Struct({ kind: Schema.Literal("provider.use-personal-override") }),
  Schema.Struct({ kind: Schema.Literal("mcp.use-personal-override") }),
  Schema.Struct({ kind: Schema.Literal("secret.use-personal-override") }),
  Schema.Struct({
    kind: Schema.Literal("plugin.use-personal-override"),
    pluginId: FirstPartyPluginId,
  }),
]);

export type WorkspacePolicyAction = typeof WorkspacePolicyAction.Type;

export const WorkspacePolicyDenialReason = Schema.Literals([
  "runner-profile-restricted",
  "remote-runner-disabled",
  "personal-provider-overrides-disabled",
  "personal-mcp-overrides-disabled",
  "personal-secret-overrides-disabled",
  "personal-plugin-overrides-disabled",
]);

export type WorkspacePolicyDenialReason =
  typeof WorkspacePolicyDenialReason.Type;

export class WorkspacePolicyDenied extends Schema.TaggedError<WorkspacePolicyDenied>()(
  "WorkspacePolicyDenied",
  { reason: WorkspacePolicyDenialReason },
) {}

export const isRemoteRunnerAdapter = (adapter: RunnerAdapterKind): boolean =>
  adapter === "kubernetes" ||
  adapter === "remote" ||
  findOrbProvider(adapter)?.remote === true;
