import { lowerTier, PluginTier } from "@dx/domain";
import { Schema } from "effect";
import { ownerWorkspaceIdSql } from "../../settings/workspace-policy/repository-d1.js";

export interface PluginTierInput {
  readonly scope: "personal" | "workspace" | "repository";
  /** Signed by a key in the workspace's trusted catalog keys. */
  readonly signedByTrustedKey: boolean;
  /** An admin marked the plugin's repository trusted. */
  readonly repositoryTrusted: boolean;
  /** The manifest's `tier`: a ceiling the author asks for. */
  readonly requested?: PluginTier;
  /** The highest tier the workspace's admin allows; `verified` by default. */
  readonly workspaceCap: PluginTier;
  /** Personal-dev powers apply only in Threads the install's owner owns. */
  readonly callerOwnsThread: boolean;
}

export type PluginTierReason =
  | "scope"
  | "cap"
  | "requested"
  | "not-owner"
  | "signature";

export interface PluginTierResolution {
  readonly tier: PluginTier;
  /** What set the tier: the install's scope, or the limit that lowered it. */
  readonly reason: PluginTierReason;
}

const granted = (
  input: PluginTierInput,
): { tier: PluginTier; reason: PluginTierReason } => {
  switch (input.scope) {
    case "repository":
      return {
        tier: input.repositoryTrusted ? "workspace-trusted" : "sandboxed",
        reason: "scope",
      };
    case "personal":
      return input.callerOwnsThread
        ? { tier: "personal-dev", reason: "scope" }
        : { tier: "sandboxed", reason: "not-owner" };
    case "workspace":
      return input.signedByTrustedKey
        ? { tier: "verified", reason: "signature" }
        : { tier: "workspace-trusted", reason: "scope" };
  }
};

/**
 * The tier dx grants a plugin: what its install scope earns, lowered by the
 * manifest's `tier` and then by the workspace's cap. Pure: callers pass rows
 * they already loaded with the Thread's plugin capabilities, so resolving a
 * tier never reads D1.
 */
export const resolvePluginTier = (
  input: PluginTierInput,
): PluginTierResolution => {
  const scope = granted(input);
  const requested = input.requested ?? scope.tier;
  const tier = lowerTier(lowerTier(scope.tier, requested), input.workspaceCap);
  if (tier === scope.tier) return scope;
  return { tier, reason: tier === input.workspaceCap ? "cap" : "requested" };
};

/**
 * The tier a pane or view of an install runs at for one viewer: it runs in
 * the viewer's browser, so a personal install's personal-dev powers apply
 * only when the viewer is the install's owner; anyone else (a contributor,
 * a view-only reader) gets sandboxed. Workspace and repository installs
 * keep their tier for every member. Only ever lowers `installTier`.
 */
export const viewerPaneTier = (
  installTier: PluginTier,
  scope: "personal" | "workspace" | "repository",
  /** `PluginInstallRecord.targetId`: the owner of a personal install. */
  installTargetId: string,
  viewerUserId: string | undefined,
): PluginTier =>
  scope === "personal" && viewerUserId !== installTargetId
    ? lowerTier(installTier, "sandboxed")
    : installTier;

/** What the workspace says about an install, read with the install's row. */
export interface InstallTrust {
  /** The workspace's cap; `verified` when no policy row says otherwise. */
  readonly workspaceCap: PluginTier;
  readonly signedByTrustedKey: boolean;
}

/**
 * The tier of a personal or workspace install, for a call that runs as its
 * owner: a Thread's submission (personal installs there are always the
 * Thread owner's) or a webhook delivery.
 */
export const installedPluginTier = (
  scope: "personal" | "workspace",
  requested: PluginTier | undefined,
  trust: InstallTrust,
): PluginTier => resolveInstallTier(scope, requested, trust).tier;

/** {@link installedPluginTier} with the reason, for the Plugins page. */
export const resolveInstallTier = (
  scope: "personal" | "workspace",
  requested: PluginTier | undefined,
  trust: InstallTrust,
): PluginTierResolution =>
  resolvePluginTier({
    scope,
    signedByTrustedKey: trust.signedByTrustedKey,
    repositoryTrusted: false,
    ...(requested === undefined ? {} : { requested }),
    workspaceCap: trust.workspaceCap,
    callerOwnsThread: true,
  });

/**
 * SQL columns for an install row (`alias` is its `trusted_plugin` alias):
 * `tier_cap`, the governing workspace's cap (the install's workspace, or a
 * personal install's owner's one workspace), and `trusted_signature`, 1 when
 * a workspace install's active version is signed by a key its workspace
 * trusts. Both ride in the query that loads the installs: no extra read.
 */
export const installTrustColumns = (alias: string) => `
  (SELECT trust_policy.plugin_tier_cap FROM workspace_policy trust_policy
    WHERE trust_policy.workspace_id = CASE ${alias}.scope
      WHEN 'workspace' THEN ${alias}.target_id
      ELSE ${ownerWorkspaceIdSql(`${alias}.target_id`)} END) AS tier_cap,
  EXISTS (SELECT 1 FROM plugin_version_signature trust_signature
     JOIN workspace_policy trust_signers
       ON trust_signers.workspace_id = ${alias}.target_id
     JOIN json_each(trust_signers.trusted_plugin_signers) trusted_key
       ON trusted_key.value = trust_signature.fingerprint
    WHERE ${alias}.scope = 'workspace'
      AND trust_signature.plugin_id = ${alias}.id
      AND trust_signature.version = ${alias}.active_version) AS trusted_signature`;

/** Reads the columns {@link installTrustColumns} adds. */
export const installTrustFromRow = (row: {
  readonly tier_cap: string | null;
  readonly trusted_signature: number | null;
}): InstallTrust => ({
  workspaceCap: Schema.is(PluginTier)(row.tier_cap) ? row.tier_cap : "verified",
  signedByTrustedKey: row.trusted_signature === 1,
});
