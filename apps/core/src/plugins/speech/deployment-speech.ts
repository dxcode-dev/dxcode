/**
 * Speech a deployment provides from its own upstreams, as the Speech
 * plugin's `dx` provider, and the seam it registers to supply and charge for
 * it (deployment-speech-registration.ts). People see only "dx"; the
 * upstream behind it stays on the server. Public dx registers
 * `noDeploymentSpeech`, so `dx` never resolves and a `SARVAM_API_KEY`
 * deployment secret keeps working as before.
 */

/** The speech services `dx` can call; each maps to a provider client. */
export type DeploymentSpeechPreset = "sarvam";

/** The upstream serving dx speech now. */
export interface DeploymentSpeechUpstream {
  readonly id: string;
  readonly preset: DeploymentSpeechPreset;
  /** What a person pays, in USD micros per audio second. */
  readonly microsPerSecond: number;
}

export interface DeploymentSpeechSource {
  /**
   * The upstream serving dx speech, or undefined when none is enabled,
   * keyed and priced. Called on every plugin resolution, so it caches.
   */
  readonly load: (
    db: D1Database | undefined,
  ) => Promise<DeploymentSpeechUpstream | undefined>;
  /** Decrypts the upstream's key; called only to admit a call. */
  readonly key: (
    db: D1Database,
    bindings: unknown,
    upstreamId: string,
  ) => Promise<string | undefined>;
  /**
   * Whether `userId` may start a dictation on dx. A refusal's reason is
   * what the composer shows.
   */
  readonly admit: (
    db: D1Database,
    userId: string,
  ) => Promise<{ readonly admitted: true } | { readonly reason: string }>;
  /**
   * The statement that charges one transcription, once per `reference`,
   * batched with its usage row; undefined when there is nothing to charge.
   */
  readonly charge: (
    db: D1Database,
    charge: {
      readonly reference: string;
      readonly userId: string;
      readonly micros: number;
    },
  ) => D1PreparedStatement | undefined;
}

export const noDeploymentSpeech: DeploymentSpeechSource = {
  load: async () => undefined,
  key: async () => undefined,
  admit: async () => ({ admitted: true }),
  charge: () => undefined,
};
