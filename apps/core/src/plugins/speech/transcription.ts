import type { DictationProviderData } from "@dx/api";
import type { PluginProviderId, SpeechProvider } from "@dx/domain";
import { settingsPersistenceLogger } from "../../logging.js";
import {
  type AdmittedConfiguration,
  admitUserPluginCall,
  type PluginHostContext,
} from "../host.js";
import { userMeteredCallStatement } from "../metering.js";
import { findPlugin, isLocalRuntime } from "../registry.js";
import { resolveCapabilities } from "../resolution.js";
import { registeredDeploymentSpeech } from "./deployment-speech-registration.js";
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
  transcribe: () => Promise.reject(new Error("Speech provider is unavailable")),
  openSession: () => {
    throw new Error("Speech provider is unavailable");
  },
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
        transcribe: (wav, options) => {
          onRequest();
          return fixture.transcribe(wav, options);
        },
        openSession: (options) => {
          onRequest();
          return fixture.openSession(options);
        },
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
    // dx speech: the upstream the deployment serves it from.
    case "dx":
      return configuration.credential === undefined ||
        configuration.upstream?.preset !== "sarvam"
        ? unavailable
        : createSarvamSpeechProvider(
            configuration.credential,
            (input, init) => {
              onRequest();
              return transport(input, init);
            },
          );
    // Search, Code, and every Orb provider transcribe nothing.
    default:
      return unavailable;
  }
};

/** Seconds of canonical 16 kHz mono 16-bit PCM, rounded up, at least 1. */
export const audioSeconds = (pcmBytes: number) =>
  Math.max(1, Math.ceil(Math.max(0, pcmBytes) / 32_000));

/**
 * One row per transcription that reached the provider, recorded when it
 * settles: `success` with a transcript, `error` when it failed after
 * reaching the provider. Units are the audio seconds sent. A successful
 * dx transcription is charged in the same batch, at the serving upstream's
 * price, once per row (`speech:<row id>`). Recording never fails the
 * dictation; failures are logged.
 */
export const recordTranscription = async (
  context: PluginHostContext,
  userId: string,
  configuration: AdmittedConfiguration,
  call: {
    readonly units: number;
    readonly outcome: "success" | "error";
    readonly durationMs: number;
  },
): Promise<void> => {
  const providerId = effectiveSpeechProviderId(configuration, context.bindings);
  const id = `pue_${crypto.randomUUID()}`;
  const usage = userMeteredCallStatement(
    context.db,
    userId,
    {
      pluginId: "speech",
      providerId,
      capability: "speech.transcribe",
      credentialScope: configuration.scope,
      unit: "audio_second",
      units: call.units,
      outcome: call.outcome,
      durationMs: Math.max(0, Math.round(call.durationMs)),
      submissionId: null,
    },
    new Date().toISOString(),
    id,
  );
  const charge =
    providerId === "dx" &&
    call.outcome === "success" &&
    configuration.upstream !== undefined
      ? registeredDeploymentSpeech.charge(context.db, {
          reference: `speech:${id}`,
          userId,
          micros: call.units * configuration.upstream.microsPerSecond,
        })
      : undefined;
  await context.db
    .batch(charge === undefined ? [usage] : [usage, charge])
    .catch(() => {
      settingsPersistenceLogger.error("Plugin usage could not be recorded.", {
        event: "plugin_usage_record_failed",
        pluginId: "speech",
        providerId,
        capability: "speech.transcribe",
        credentialScope: configuration.scope,
        charged: charge !== undefined,
      });
    });
};

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
