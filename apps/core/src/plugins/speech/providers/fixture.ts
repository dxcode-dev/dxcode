import { type SpeechProvider, SpeechProviderError } from "@dx/domain";

export const FIXTURE_TRANSCRIPT = "This is a local dictation fixture.";

/**
 * Local-runtime substitute for every speech provider. It implements the same
 * API with a fixed transcript and never touches the network, so `pnpm dev`
 * exercises dictation without spending credits.
 */
export const createFixtureSpeechProvider = (): SpeechProvider => ({
  transcribe: async () => FIXTURE_TRANSCRIPT,
  openSession: () => {
    let closed = false;
    return {
      send: () => undefined,
      finish: async () => {
        if (closed)
          throw new SpeechProviderError({ reason: "Dictation was canceled" });
        closed = true;
        return FIXTURE_TRANSCRIPT;
      },
      close: () => {
        closed = true;
      },
    };
  },
});
