import { Schema } from "effect";

/**
 * The Speech plugin's API (`speech.transcribe`). Composer dictation streams
 * canonical PCM (16 kHz, mono, 16-bit little-endian) through a live session
 * while the user speaks and reads the whole transcript when they stop. A
 * saved recording is transcribed in one call. Every speech provider
 * implements both, so swapping the provider never changes the dictation
 * routes or the composer.
 */
export class SpeechProviderError extends Schema.TaggedError<SpeechProviderError>()(
  "SpeechProviderError",
  { reason: Schema.String },
) {}

export interface SpeechSession {
  /** Queues the next PCM chunk; chunks reach the provider in order. */
  readonly send: (pcm: Uint8Array) => void;
  /**
   * Ends the audio and resolves the whole transcript, empty when nobody
   * spoke. Rejects with `SpeechProviderError` when the session broke.
   */
  readonly finish: () => Promise<string>;
  /** Abandons the session without a transcript. */
  readonly close: () => void;
}

export interface SpeechProvider {
  /** Transcribes one canonical WAV; empty when nobody spoke. */
  readonly transcribe: (
    wav: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Opens a live session. Audio sent before it connects is kept. */
  readonly openSession: (signal?: AbortSignal) => SpeechSession;
}
