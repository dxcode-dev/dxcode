import { type SpeechProvider, SpeechProviderError } from "@dx/domain";

export const FIXTURE_SPEECH_JOB_ID = "local-fixture";
export const FIXTURE_TRANSCRIPT = "This is a local dictation fixture.";

/**
 * Local-runtime substitute for every speech provider. It implements the same
 * API with a fixed transcript and never touches the network, so `pnpm dev`
 * exercises dictation without spending credits.
 */
export const createFixtureSpeechProvider = (): SpeechProvider => ({
  async startTranscription(_wav, checkpoints) {
    if (!(await checkpoints.created(FIXTURE_SPEECH_JOB_ID)))
      throw new SpeechProviderError({ reason: "Dictation was canceled" });
    return FIXTURE_SPEECH_JOB_ID;
  },
  async readTranscription() {
    return { text: FIXTURE_TRANSCRIPT };
  },
});
