import {
  DICTATION_STREAM_SUBPROTOCOL,
  type DictationStreamResult,
  DictationStreamResultSchema,
} from "@dx/api";
import { Option, Schema } from "effect";

/** 100 ms of 16 kHz audio per frame. */
const FRAME_SAMPLES = 1_600;
const FINISH_TIMEOUT = 10_000;

const decodeResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(DictationStreamResultSchema),
);

/**
 * Streams captured PCM to `/v1/dictation/:id/stream` while the user speaks,
 * so the transcript is ready moments after they stop. It only speeds
 * dictation up: the capture keeps the whole recording, and a session that
 * fails resolves `undefined` so the composer uploads the recording instead.
 */
export class LiveDictation {
  private readonly socket: WebSocket;
  private readonly queued: Array<ArrayBuffer | string> = [];
  private frame = new Int16Array(FRAME_SAMPLES);
  private filled = 0;
  private broken = false;
  private result?: (result: DictationStreamResult | undefined) => void;

  constructor(id: string) {
    const url = new URL(
      `/v1/dictation/${encodeURIComponent(id)}/stream`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url, DICTATION_STREAM_SUBPROTOCOL);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => {
      for (const message of this.queued.splice(0)) this.deliver(message);
    });
    this.socket.addEventListener("message", ({ data }) => {
      this.settle(Option.getOrUndefined(decodeResult(data)));
    });
    this.socket.addEventListener("close", () => this.settle(undefined));
  }

  /** Queues captured PCM; it reaches the server in 100 ms frames. */
  push(pcm: Int16Array) {
    let offset = 0;
    while (offset < pcm.length && !this.broken) {
      const taken = Math.min(FRAME_SAMPLES - this.filled, pcm.length - offset);
      this.frame.set(pcm.subarray(offset, offset + taken), this.filled);
      this.filled += taken;
      offset += taken;
      if (this.filled === FRAME_SAMPLES) this.sendFrame();
    }
  }

  /** The whole transcript, or `undefined` when the session cannot give it. */
  finish(signal: AbortSignal): Promise<string | undefined> {
    if (this.filled > 0) this.sendFrame();
    if (this.broken) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => this.close(), FINISH_TIMEOUT);
      const abort = () => this.close();
      signal.addEventListener("abort", abort, { once: true });
      this.result = (result) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(result?.type === "completed" ? result.text : undefined);
      };
      this.deliver(JSON.stringify({ type: "finish" }));
    });
  }

  /** Abandons the session; the server cancels its job. */
  close() {
    this.settle(undefined);
  }

  private sendFrame() {
    this.deliver(this.frame.slice(0, this.filled).buffer);
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  private deliver(message: ArrayBuffer | string) {
    if (this.broken) return;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
    else if (this.socket.readyState === WebSocket.CONNECTING)
      this.queued.push(message);
    else this.broken = true;
  }

  private settle(result: DictationStreamResult | undefined) {
    this.broken = true;
    this.queued.length = 0;
    const waiting = this.result;
    this.result = undefined;
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000);
    waiting?.(result);
  }
}

/**
 * The live session of one recording. Its first captured audio opens it, so
 * a microphone prompt that is never granted opens nothing. `take` ends the
 * recording and hands over the session, if any.
 */
export const liveRecording = () => {
  let session: LiveDictation | undefined;
  let open = true;
  return {
    push: (pcm: Int16Array) => {
      if (!open) return;
      session ??= new LiveDictation(crypto.randomUUID());
      session.push(pcm);
    },
    take: () => {
      open = false;
      const taken = session;
      session = undefined;
      return taken;
    },
  };
};
export type LiveRecording = ReturnType<typeof liveRecording>;
