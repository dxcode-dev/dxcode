export type DictationIntent = "insert" | "send";

type RetainedDictation = {
  readonly state: "retained";
  readonly audio: Blob;
  readonly intent: DictationIntent;
  readonly error?: string;
};

export type DictationRecoverySnapshot =
  | { readonly state: "empty" }
  | RetainedDictation;

const emptySnapshot: DictationRecoverySnapshot = { state: "empty" };

/** The latest dictation's audio and outcome, for Dictation Diagnostics. */
export interface DictationRecord {
  readonly audio: Blob;
  readonly transcript?: string;
  readonly outcome: "completed" | "failed";
  readonly error?: string;
  readonly mode: "live" | "upload";
  readonly jobId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Keeps captured voice in memory for the lifetime of its browser session. */
export class DictationRecoverySession {
  private snapshot: DictationRecoverySnapshot = emptySnapshot;
  private retained: RetainedDictation[] = [];
  private record: DictationRecord | undefined;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;
  readonly getServerSnapshot = () => emptySnapshot;

  retain(audio: Blob, intent: DictationIntent, error?: string) {
    const retained = { state: "retained" as const, audio, intent, error };
    const index = this.retained.findIndex((entry) => entry.audio === audio);
    if (index < 0) this.retained.push(retained);
    else this.retained[index] = retained;
    this.publishCurrent();
  }

  fail(audio: Blob, error: string) {
    const index = this.retained.findIndex((entry) => entry.audio === audio);
    if (index < 0) return;
    this.retained[index] = { ...this.retained[index], error };
    this.publishCurrent();
  }

  release(audio: Blob) {
    const index = this.retained.findIndex((entry) => entry.audio === audio);
    if (index < 0) return;
    this.retained.splice(index, 1);
    this.publishCurrent();
  }

  /** Keeps the latest dictation in memory, on this device only. */
  remember(record: DictationRecord) {
    this.record = record;
  }

  latest() {
    return this.record;
  }

  clear() {
    this.retained = [];
    this.record = undefined;
    this.publish(emptySnapshot);
  }

  private publishCurrent() {
    this.publish(this.retained.at(-1) ?? emptySnapshot);
  }

  private publish(snapshot: DictationRecoverySnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const downloadDictation = (audio: Blob) => {
  const url = URL.createObjectURL(audio);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dx-dictation-${new Date().toISOString().replaceAll(":", "-")}.wav`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
