import type { DictationProviderData } from "@dx/api";
import type { PluginProviderId, SpeechProvider } from "@dx/domain";
import {
  type AdmittedConfiguration,
  admitUserPluginCall,
  type PluginHostContext,
} from "../host.js";
import { recordUserMeteredCallSafely } from "../metering.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import { resolveCapabilities } from "../resolution.js";
import { createFixtureSpeechProvider } from "./providers/fixture.js";
import { createSarvamSpeechProvider } from "./providers/sarvam.js";

/**
 * Speech is not a submission tool: composer dictation is a route, so it
 * resolves provider, credential, and credential scope per request here, with
 * installation, enablement, and workspace policy rechecked each time.
 */
export const admitSpeech = (context: PluginHostContext, userId: string) =>
  admitUserPluginCall(context, userId, "speech", "speech.transcribe");

/** The provider actually called: local runtime always uses the fixture. */
export const effectiveSpeechProviderId = (
  configuration: Pick<AdmittedConfiguration, "providerId">,
  bindings: PluginHostContext["bindings"],
): PluginProviderId =>
  isLocalRuntime(bindings) ? "fixture" : configuration.providerId;

const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

const unavailable: SpeechProvider = {
  startTranscription: () =>
    Promise.reject(new Error("Speech provider is unavailable")),
  readTranscription: () =>
    Promise.reject(new Error("Speech provider is unavailable")),
};

/**
 * Builds the provider implementation for an admitted configuration.
 * `onRequest` runs before every request that reaches the provider, so a
 * dispatch that failed before reaching it records no usage.
 */
export const speechProviderFor = (
  configuration: AdmittedConfiguration,
  bindings: PluginHostContext["bindings"],
  onRequest: () => void = () => undefined,
  transport: typeof fetch = runtimeFetch,
): SpeechProvider => {
  switch (effectiveSpeechProviderId(configuration, bindings)) {
    case "fixture": {
      const fixture = createFixtureSpeechProvider();
      return {
        startTranscription: (wav, checkpoints, signal) => {
          onRequest();
          return fixture.startTranscription(wav, checkpoints, signal);
        },
        readTranscription: fixture.readTranscription,
      };
    }
    case "sarvam":
      return configuration.credential === undefined
        ? unavailable
        : createSarvamSpeechProvider(
            configuration.credential,
            (input, init) => {
              onRequest();
              return transport(input, init);
            },
          );
    case "exa":
    case "quickjs":
    case "e2b":
    case "cloudflare":
    case "local":
      return unavailable;
  }
};

/** Seconds of canonical 16 kHz mono 16-bit audio, rounded up, at least 1. */
export const audioSeconds = (wav: Uint8Array) =>
  Math.max(1, Math.ceil(Math.max(0, wav.byteLength - 44) / 32_000));

/**
 * One row per transcription that reached the provider, recorded when the
 * dispatch settles: `success` once the provider accepted the job, `error`
 * when the dispatch failed after reaching it. Units are the audio seconds
 * sent; polling is not metered.
 */
export const recordTranscription = (
  context: PluginHostContext,
  userId: string,
  configuration: AdmittedConfiguration,
  call: {
    readonly units: number;
    readonly outcome: "success" | "error";
    readonly durationMs: number;
  },
) =>
  recordUserMeteredCallSafely(context.db, userId, {
    pluginId: "speech",
    providerId: effectiveSpeechProviderId(configuration, context.bindings),
    capability: "speech.transcribe",
    credentialScope: configuration.scope,
    unit: "audio_second",
    units: call.units,
    outcome: call.outcome,
    durationMs: Math.max(0, Math.round(call.durationMs)),
    submissionId: null,
  });

/**
 * Whether dictation works for this user right now, and through which
 * provider: Speech is installed, effectively enabled, and resolves a
 * provider. The composer shows its microphone only then.
 */
export const resolveDictation = async (
  context: PluginHostContext,
  userId: string,
): Promise<DictationProviderData | undefined> => {
  const resolved = await resolveCapabilities({ userId }, context);
  const state = resolved.plugins.find(({ plugin }) => plugin.id === "speech");
  const resolution = state?.resolution;
  if (
    resolution?.status !== "active" ||
    !resolution.capabilities.includes("speech.transcribe")
  )
    return undefined;
  const providerId = effectiveSpeechProviderId(
    resolution.provider,
    context.bindings,
  );
  const plugin = findPlugin("speech");
  return {
    providerId,
    displayName:
      providerId === "fixture"
        ? "Local fixture"
        : (plugin?.providers.find(({ id }) => id === providerId)?.displayName ??
          providerId),
    scope: resolution.provider.scope,
  };
};
