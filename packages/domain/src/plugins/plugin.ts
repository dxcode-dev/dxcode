import { Schema } from "effect";
import { EXECUTION_CAPABILITY_IDS } from "./execution.js";

/**
 * First-party plugin vocabulary. See wiki/plugin-platform-direction.md.
 * A plugin names a family of capabilities; providers implement capabilities
 * behind one credential; a configuration is a provider credentialed at one
 * scope. Imported bundles keep their own `PluginId` in settings/plugin.ts.
 */
export const FirstPartyPluginId = Schema.Literals([
  "search",
  "code",
  "speech",
  "execution",
]);

export type FirstPartyPluginId = typeof FirstPartyPluginId.Type;

export const PluginCapabilityId = Schema.Literals([
  "web.search",
  "web.read",
  "code.execute",
  "speech.transcribe",
  ...EXECUTION_CAPABILITY_IDS,
]);

export type PluginCapabilityId = typeof PluginCapabilityId.Type;

/**
 * `fixture` is the local-runtime substitute; it is never configurable.
 * `local` is Execution's development provider (the local workspace runtime).
 */
export const PluginProviderId = Schema.Literals([
  "exa",
  "fixture",
  "quickjs",
  "sarvam",
  "e2b",
  "cloudflare",
  "local",
]);

export type PluginProviderId = typeof PluginProviderId.Type;

export const PluginScope = Schema.Literals([
  "deployment",
  "workspace",
  "personal",
]);

export type PluginScope = typeof PluginScope.Type;

/** Stored per scope; absence means unset. */
export const PluginEnablement = Schema.Literals(["enabled", "disabled"]);

export type PluginEnablement = typeof PluginEnablement.Type;

/**
 * `request` counts provider requests (Search, Code). `audio_second` counts
 * seconds of audio sent for transcription, rounded up per job (Speech).
 */
export const PluginMeteringUnit = Schema.Literals(["request", "audio_second"]);

export type PluginMeteringUnit = typeof PluginMeteringUnit.Type;

export const MAX_PLUGIN_CREDENTIAL_LENGTH = 4_096;

export const PluginCredential = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PLUGIN_CREDENTIAL_LENGTH),
  Schema.isPattern(/^\S+$/),
);

/** The effective provider for one plugin, resolved for one user. */
export const ResolvedPluginProvider = Schema.Struct({
  providerId: PluginProviderId,
  scope: PluginScope,
});

export type ResolvedPluginProvider = typeof ResolvedPluginProvider.Type;

export const PluginResolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-installed") }),
  Schema.Struct({
    status: Schema.Literal("disabled"),
    by: PluginScope,
  }),
  Schema.Struct({ status: Schema.Literal("no-provider") }),
  Schema.Struct({
    status: Schema.Literal("active"),
    provider: ResolvedPluginProvider,
    capabilities: Schema.Array(PluginCapabilityId),
  }),
]);

export type PluginResolution = typeof PluginResolution.Type;

/**
 * The plugin tools one submission mounts: which plugins and capabilities.
 * Resolved once per submission (retries and recovery of that submission reuse
 * it) and recorded with it. It carries no provider or credential: every call
 * resolves the current effective configuration, so a provider or key change
 * applies to the next call. Only the execution workspace is fixed per Thread.
 */
export const PluginToolSet = Schema.Array(
  Schema.Struct({
    pluginId: FirstPartyPluginId,
    capabilities: Schema.Array(PluginCapabilityId).check(
      Schema.isMaxLength(16),
    ),
  }),
).check(Schema.isMaxLength(16));

export type PluginToolSet = typeof PluginToolSet.Type;

/** One provider call; credential scope is the billing dimension. */
export const MeteredPluginCall = Schema.Struct({
  pluginId: FirstPartyPluginId,
  providerId: PluginProviderId,
  capability: PluginCapabilityId,
  credentialScope: PluginScope,
  unit: PluginMeteringUnit,
  units: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.Literals(["success", "error"]),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The submission whose resolved tool set made this call. Null for calls
   * made outside a submission, such as composer dictation.
   */
  submissionId: Schema.NullOr(Schema.String),
});

export type MeteredPluginCall = typeof MeteredPluginCall.Type;
