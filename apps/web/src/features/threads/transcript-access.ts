import { EMPTY_TRANSCRIPT, type TranscriptViewModel } from "@dx/client";

/**
 * Reads the shown transcript on demand, for the title bar's export. The page
 * creates one, the agent panel provides its reader once mounted, and nothing
 * subscribes: the model is read only when an export runs.
 */
export interface TranscriptAccess {
  readonly current: () => TranscriptViewModel;
  readonly provide: (read: () => TranscriptViewModel) => void;
}

export const createTranscriptAccess = (): TranscriptAccess => {
  let read: () => TranscriptViewModel = () => EMPTY_TRANSCRIPT;
  return {
    current: () => read(),
    provide: (next) => {
      read = next;
    },
  };
};
