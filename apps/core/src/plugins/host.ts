import type {
  FirstPartyPluginId,
  PluginCapabilityId,
  PluginProviderId,
  PluginScope,
  PluginToolSet,
} from "@dx/domain";
import { Effect, Redacted } from "effect";
import type { Bindings } from "../http/types.js";
import { loadConfigEncryptionKeyring } from "../settings/config-encryption.js";
import { recordMeteredCallSafely } from "./metering.js";
import { findProvider, isLocalRuntime } from "./registry.js";
import { resolveCapabilities } from "./resolution.js";
import { decryptPluginCredential } from "./settings-store-d1.js";

export type ThreadPlugin = PluginToolSet[number];

/** The submission a plugin tool call belongs to. */
export interface PluginSubmission {
  readonly threadId: string;
  /** Null only outside a prompt submission. */
  readonly submissionId: string | null;
}

export interface AdmittedConfiguration {
  readonly providerId: PluginProviderId;
  readonly scope: PluginScope;
  /** Undefined for fixture and built-in providers. */
  readonly credential: Redacted.Redacted<string> | undefined;
}

export type PluginCallAdmission =
  | { readonly admitted: true; readonly configuration: AdmittedConfiguration }
  | {
      readonly admitted: false;
      readonly reason:
        | "thread-unavailable"
        | "not-installed"
        | "disabled"
        | "no-provider"
        | "capability-unavailable"
        | "credential-unavailable";
    };

export interface PluginHostContext {
  readonly db: D1Database;
  readonly bindings: Bindings;
}

/**
 * Call-time admission. The Thread snapshot only says which tools exist; the
 * provider, credential, and credential scope are the user's current effective
 * configuration, resolved here on every call with installation, enablement,
 * and workspace policy rechecked. Switching provider or key therefore applies
 * to the next call in existing Threads. A call uses exactly the configuration
 * resolved here: if that provider fails, the host never retries the call on
 * another scope or provider.
 */
export const admitPluginCall = async (
  context: PluginHostContext,
  threadId: string,
  threadPlugin: ThreadPlugin,
  capability: PluginCapabilityId,
): Promise<PluginCallAdmission> => {
  const thread = await context.db
    .prepare(
      "SELECT owner_user_id, lifecycle_state FROM threads WHERE id = ? LIMIT 1",
    )
    .bind(threadId)
    .first<{ owner_user_id: string; lifecycle_state: string }>();
  if (thread === null || thread.lifecycle_state !== "active")
    return { admitted: false, reason: "thread-unavailable" };
  const admission = await admitUserPluginCall(
    context,
    thread.owner_user_id,
    threadPlugin.pluginId,
    capability,
  );
  return admission.admitted && !threadPlugin.capabilities.includes(capability)
    ? { admitted: false, reason: "capability-unavailable" }
    : admission;
};

/**
 * Call-time admission for one user outside a Thread, such as composer
 * dictation: the same per-call resolution of provider, credential, and scope.
 */
export const admitUserPluginCall = async (
  context: PluginHostContext,
  userId: string,
  pluginId: FirstPartyPluginId,
  capability: PluginCapabilityId,
): Promise<PluginCallAdmission> => {
  const resolved = await resolveCapabilities({ userId }, context);
  const state = resolved.plugins.find(({ plugin }) => plugin.id === pluginId);
  if (state === undefined) return { admitted: false, reason: "not-installed" };
  const resolution = state.resolution;
  if (resolution.status === "disabled")
    return { admitted: false, reason: "disabled" };
  if (resolution.status !== "active")
    return { admitted: false, reason: "no-provider" };
  if (!resolution.capabilities.includes(capability))
    return { admitted: false, reason: "capability-unavailable" };
  const { providerId, scope } = resolution.provider;
  if (scope === "deployment") {
    if (providerId === "fixture" || providerId === "quickjs")
      return {
        admitted: true,
        configuration: { providerId, scope, credential: undefined },
      };
    const provider = findProvider(state.plugin, providerId);
    const secret =
      provider?.deploymentSecret !== undefined
        ? (context.bindings[provider.deploymentSecret] ?? "").trim()
        : "";
    return secret === ""
      ? { admitted: false, reason: "credential-unavailable" }
      : {
          admitted: true,
          configuration: {
            providerId,
            scope,
            credential: Redacted.make(secret),
          },
        };
  }
  const setting =
    scope === "personal" ? state.personalSetting : state.workspaceSetting;
  const configuration = setting?.configuration;
  if (setting === undefined || configuration == null)
    return { admitted: false, reason: "credential-unavailable" };
  try {
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(context.bindings),
    );
    const credential = await decryptPluginCredential(keyring, {
      ...setting,
      configuration,
    });
    return {
      admitted: true,
      configuration: {
        providerId,
        scope,
        credential: Redacted.make(credential),
      },
    };
  } catch {
    return { admitted: false, reason: "credential-unavailable" };
  }
};

/** Counts provider requests for one call; providers report into it. */
export interface PluginCallMeter {
  readonly add: (units: number) => void;
}

/**
 * Runs one provider call for an admitted configuration and records a
 * metered row when the provider was actually reached (units > 0), whether
 * the call succeeded or failed.
 */
export const meterPluginCall = async <T>(
  context: PluginHostContext,
  threadId: string,
  submissionId: string | null,
  threadPlugin: ThreadPlugin,
  capability: PluginCapabilityId,
  configuration: AdmittedConfiguration,
  run: (meter: PluginCallMeter) => Promise<T>,
): Promise<T> => {
  let units = 0;
  const startedAt = Date.now();
  // Local runtime substitutes fixtures for external providers only.
  const providerId =
    isLocalRuntime(context.bindings) && configuration.providerId !== "quickjs"
      ? "fixture"
      : configuration.providerId;
  const record = (outcome: "success" | "error") =>
    units === 0
      ? Promise.resolve()
      : recordMeteredCallSafely(context.db, threadId, {
          pluginId: threadPlugin.pluginId,
          providerId,
          capability,
          credentialScope: configuration.scope,
          unit: "request",
          units,
          outcome,
          durationMs: Math.max(0, Date.now() - startedAt),
          submissionId,
        });
  try {
    const value = await run({
      add: (count) => {
        units += count;
      },
    });
    await record("success");
    return value;
  } catch (error) {
    await record("error");
    throw error;
  }
};
