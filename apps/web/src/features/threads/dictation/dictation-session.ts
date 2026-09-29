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

/** Keeps captured voice in memory for the lifetime of its browser session. */
export class DictationRecoverySession {
  private snapshot: DictationRecoverySnapshot = emptySnapshot;
  private retained: RetainedDictation[] = [];
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

  clear() {
    this.retained = [];
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
