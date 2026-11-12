/**
 * Plays everyone else's audio in a huddle. RealtimeKit's core SDK leaves
 * playback to the app (its UI kit has a component for it), so the call routes
 * each remote audio track into one Web Audio context.
 *
 * Browsers only let sound start from a click. `unlock()` runs inside the
 * click that joins, or any later call control, and starts the context; once
 * it runs, tracks that arrive seconds later still play in every browser.
 * Chrome also needs each remote WebRTC track attached to a media element
 * before Web Audio hears it, so each track gets a muted, detached <audio>.
 */

type Sink = {
  readonly track: MediaStreamTrack;
  readonly source: MediaStreamAudioSourceNode;
  readonly element: HTMLAudioElement;
};

export class HuddleAudio {
  private context: AudioContext | undefined;
  private readonly sinks = new Map<string, Sink>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** Call from a click: creates or resumes the context. */
  unlock() {
    if (typeof AudioContext === "undefined") return;
    if (this.context === undefined) {
      this.context = new AudioContext();
      this.context.addEventListener("statechange", this.onChange);
    }
    if (this.context.state !== "running")
      void this.context.resume().catch(() => undefined);
  }

  /** Whether sound is held back while someone could be heard. */
  get blocked() {
    return (
      this.sinks.size > 0 &&
      this.context !== undefined &&
      this.context.state !== "running"
    );
  }

  /** Plays exactly these tracks, keyed by who they belong to. */
  play(tracks: ReadonlyMap<string, MediaStreamTrack>) {
    for (const [key, sink] of this.sinks) {
      if (tracks.get(key) === sink.track) continue;
      this.remove(key, sink);
    }
    const context = this.context;
    if (context === undefined) return;
    for (const [key, track] of tracks) {
      if (this.sinks.has(key)) continue;
      const element = new Audio();
      element.muted = true;
      element.srcObject = new MediaStream([track]);
      void element.play().catch(() => undefined);
      const source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(context.destination);
      this.sinks.set(key, { track, source, element });
    }
  }

  private remove(key: string, sink: Sink) {
    sink.source.disconnect();
    sink.element.pause();
    sink.element.srcObject = null;
    this.sinks.delete(key);
  }

  stop() {
    for (const [key, sink] of this.sinks) this.remove(key, sink);
  }
}
