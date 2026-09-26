import { DICTATION_MAX_SAMPLES, DICTATION_SAMPLE_RATE } from "@dx/api";
import pcmCaptureWorkletUrl from "./pcm-capture-worklet.mjs?url&no-inline";

export type CaptureSnapshot =
  | { readonly state: "idle"; readonly waveform: ReadonlyArray<number> }
  | { readonly state: "permission"; readonly waveform: ReadonlyArray<number> }
  | { readonly state: "recording"; readonly waveform: ReadonlyArray<number> }
  | {
      readonly state: "error";
      readonly waveform: ReadonlyArray<number>;
      readonly error: string;
    };

const emptyWaveform = () => Array<number>(96).fill(0);

const wav = (chunks: ReadonlyArray<Int16Array>, samples: number) => {
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((character, index) => {
      view.setUint8(offset + index, character.charCodeAt(0));
    });
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  return new Blob([buffer], { type: "audio/wav" });
};

export class DictationCapture {
  private snapshot: CaptureSnapshot = {
    state: "idle",
    waveform: emptyWaveform(),
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private fallbackNode?: ScriptProcessorNode;
  private flushFallback?: () => void;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private finishLimit?: () => void;
  private wallTimer?: number;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;
  readonly getServerSnapshot = (): CaptureSnapshot => ({
    state: "idle",
    waveform: [],
  });
  private publish(snapshot: CaptureSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => {
      listener();
    });
  }

  async start(onLimit: () => void) {
    const generation = ++this.generation;
    this.publish({ state: "permission", waveform: emptyWaveform() });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      const context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
      this.context = context;
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) return;
      this.chunks = [];
      this.samples = 0;
      this.finishLimit = onLimit;
      let waveform = emptyWaveform();
      let lastPublish = 0;
      const record = (pcm: Int16Array, peak: number) => {
        if (generation !== this.generation) return;
        const remaining = DICTATION_MAX_SAMPLES - this.samples;
        const chunk = pcm.length > remaining ? pcm.slice(0, remaining) : pcm;
        this.chunks.push(chunk);
        this.samples += chunk.length;
        const now = performance.now();
        if (now - lastPublish >= 50) {
          lastPublish = now;
          waveform = [...waveform.slice(1), Math.sqrt(peak)];
          this.publish({ state: "recording", waveform });
        }
        if (this.samples >= DICTATION_MAX_SAMPLES) this.finishLimit?.();
      };
      const workletLoaded =
        typeof context.audioWorklet?.addModule === "function"
          ? await Promise.race([
              context.audioWorklet.addModule(pcmCaptureWorkletUrl).then(
                () => true,
                () => false,
              ),
              new Promise<false>((resolve) => {
                window.setTimeout(() => resolve(false), 1_000);
              }),
            ])
          : false;
      if (generation !== this.generation) return;
      const source = context.createMediaStreamSource(stream);
      if (workletLoaded) {
        const node = new AudioWorkletNode(context, "dx-pcm-capture", {
          processorOptions: { inputSampleRate: context.sampleRate },
        });
        this.node = node;
        node.port.onmessage = ({
          data,
        }: MessageEvent<{ type: string; pcm?: Int16Array; peak?: number }>) => {
          if (generation !== this.generation) return;
          if (data.type === "limit") {
            this.finishLimit?.();
            return;
          }
          if (data.pcm) record(data.pcm, data.peak ?? 0);
        };
        source.connect(node);
        node.connect(context.destination);
      } else {
        const fallbackNode = context.createScriptProcessor(4_096, 1, 1);
        this.fallbackNode = fallbackNode;
        const ratio = context.sampleRate / DICTATION_SAMPLE_RATE;
        let position = 0;
        let sourceSamples: number[] = [];
        const resample = (flush = false) => {
          const output: number[] = [];
          while (position + 1 < sourceSamples.length) {
            const left = Math.floor(position);
            const fraction = position - left;
            output.push(
              sourceSamples[left] * (1 - fraction) +
                sourceSamples[left + 1] * fraction,
            );
            position += ratio;
          }
          const consumed = Math.min(sourceSamples.length, Math.floor(position));
          if (consumed > 0) {
            sourceSamples = sourceSamples.slice(consumed);
            position -= consumed;
          }
          if (flush && sourceSamples.length > 0) {
            output.push(
              sourceSamples[
                Math.min(Math.floor(position), sourceSamples.length - 1)
              ],
            );
            sourceSamples = [];
            position = 0;
          }
          if (output.length === 0) return;
          let peak = 0;
          const pcm = Int16Array.from(output, (sample) => {
            const normalized = Math.max(-1, Math.min(1, sample));
            peak = Math.max(peak, Math.abs(normalized));
            return normalized * (normalized < 0 ? 32_768 : 32_767);
          });
          record(pcm, peak);
        };
        this.flushFallback = () => resample(true);
        fallbackNode.onaudioprocess = ({ inputBuffer }) => {
          sourceSamples.push(...inputBuffer.getChannelData(0));
          resample();
        };
        source.connect(fallbackNode);
        fallbackNode.connect(context.destination);
      }
      this.publish({ state: "recording", waveform });
      this.wallTimer = window.setTimeout(onLimit, 900_000);
    } catch (cause) {
      if (generation !== this.generation) return;
      await this.release();
      this.publish({
        state: "error",
        waveform: [],
        error:
          cause instanceof Error ? cause.message : "Microphone access failed.",
      });
    }
  }

  async finish() {
    const generation = this.generation;
    const node = this.node;
    if (node) {
      await new Promise<void>((resolve) => {
        const previous = node.port.onmessage;
        const timer = window.setTimeout(resolve, 250);
        node.port.onmessage = (event) => {
          previous?.call(node.port, event);
          if (event.data?.type === "stopped") {
            clearTimeout(timer);
            resolve();
          }
        };
        node.port.postMessage({ type: "stop" });
      });
    }
    this.flushFallback?.();
    if (generation !== this.generation) return wav([], 0);
    const audio = wav(this.chunks, this.samples);
    this.chunks = [];
    this.samples = 0;
    const completed = ++this.generation;
    await this.release();
    if (completed === this.generation)
      this.publish({ state: "idle", waveform: [] });
    return audio;
  }
  async cancel() {
    const generation = ++this.generation;
    this.chunks = [];
    this.samples = 0;
    await this.release();
    if (generation === this.generation)
      this.publish({ state: "idle", waveform: [] });
  }
  private async release() {
    if (this.wallTimer !== undefined) clearTimeout(this.wallTimer);
    this.wallTimer = undefined;
    this.node?.disconnect();
    this.node = undefined;
    if (this.fallbackNode) {
      this.fallbackNode.onaudioprocess = null;
      this.fallbackNode.disconnect();
    }
    this.fallbackNode = undefined;
    this.flushFallback = undefined;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.stream = undefined;
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") await context.close();
  }
}
