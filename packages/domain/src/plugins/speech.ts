import { Schema } from "effect";

/**
 * The Speech plugin's API (`speech.transcribe`). Composer dictation streams
 * canonical PCM (16 kHz, mono, 16-bit little-endian) through a live session
 * while the user speaks and reads the whole transcript when they stop. A
 * saved recording is transcribed in one call. Every speech provider
 * implements both, and accepts a dictation vocabulary for each, so swapping
 * the provider never changes the dictation routes or the composer.
 */
export class SpeechProviderError extends Schema.TaggedError<SpeechProviderError>()(
  "SpeechProviderError",
  { reason: Schema.String },
) {}

/**
 * Dictation vocabulary: names, technical terms, and other words dictation
 * should recognize. A person and their workspace each keep their own list;
 * a transcription is biased toward both, personal terms first. The limits
 * are what a provider accepts in one request (Sarvam: 50 terms of at most 64
 * characters).
 */
export const DICTATION_VOCABULARY_MAX_TERMS = 50;
export const DICTATION_VOCABULARY_MAX_TERM_LENGTH = 64;

export const DictationVocabularyTerm = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DICTATION_VOCABULARY_MAX_TERM_LENGTH),
);

export const DictationVocabulary = Schema.Array(DictationVocabularyTerm).check(
  Schema.isMaxLength(DICTATION_VOCABULARY_MAX_TERMS),
);
export type DictationVocabulary = typeof DictationVocabulary.Type;

/**
 * Terms as a person types them: one per line or separated by commas.
 * Whitespace inside a term collapses to one space, and a term repeated in
 * any letter case keeps its first spelling. Length limits are not applied.
 */
export const parseDictationVocabulary = (text: string): string[] => {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const term = part.replaceAll(/\s+/g, " ").trim();
    const key = term.toLocaleLowerCase();
    if (term === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
};

/**
 * Why a parsed list cannot be saved, or undefined when it can. The settings
 * route and the settings form both use it, so they never disagree.
 */
export const dictationVocabularyProblem = (
  terms: ReadonlyArray<string>,
): string | undefined => {
  const long = terms.find(
    (term) => term.length > DICTATION_VOCABULARY_MAX_TERM_LENGTH,
  );
  if (long !== undefined)
    return `Keep each term to ${DICTATION_VOCABULARY_MAX_TERM_LENGTH} characters. “${long.slice(0, 24)}…” is longer.`;
  if (terms.length > DICTATION_VOCABULARY_MAX_TERMS)
    return `Enter at most ${DICTATION_VOCABULARY_MAX_TERMS} terms. This list has ${terms.length}.`;
  return undefined;
};

/**
 * The vocabulary one transcription uses: personal terms, then the
 * workspace's terms not already listed, up to the per-request limit, so
 * personal terms win when both lists are full.
 */
export const mergeDictationVocabularies = (
  personal: ReadonlyArray<string>,
  workspace: ReadonlyArray<string>,
): string[] =>
  parseDictationVocabulary([...personal, ...workspace].join("\n")).slice(
    0,
    DICTATION_VOCABULARY_MAX_TERMS,
  );

/** Per-call options every speech provider accepts. */
export interface SpeechOptions {
  readonly signal?: AbortSignal;
  /** Terms to bias recognition toward; a hint, not a guarantee. */
  readonly vocabulary?: ReadonlyArray<string>;
}

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
    options?: SpeechOptions,
  ) => Promise<string>;
  /** Opens a live session. Audio sent before it connects is kept. */
  readonly openSession: (options?: SpeechOptions) => SpeechSession;
}
