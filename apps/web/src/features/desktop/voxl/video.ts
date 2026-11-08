// Decoding voxl's H.264 stripes with WebCodecs and painting them on a canvas,
// ported from voxl's web client (web/src/worker.ts at tembo/voxl 176f8be,
// MIT, © 2026 Tembo). voxl decodes in a worker onto an OffscreenCanvas; dx
// keeps the socket on the page so its session rules (status checks, the
// signed-out close code, idle pause) see every socket, and decoding still
// runs off the main thread inside WebCodecs. Each frame is drawn the moment
// all its stripes decode, in order, and then acknowledged: voxl paces its
// stream by those acknowledgements.
import {
  cmd,
  parseVideoHeader,
  type Stripe,
  VIDEO_HEADER_BYTES,
} from "./protocol.js";

interface StripeState {
  decoder: VideoDecoder | null;
  codec: string | null;
  waitingKey: boolean;
  timestamp: number;
  /** Decoder timestamp -> frame id. */
  readonly ids: Map<number, number>;
}
interface DecodedStripe {
  readonly y: number;
  readonly frame: VideoFrame;
}
interface PendingFrame {
  need: number;
  readonly got: DecodedStripe[];
}

/** Keyframe requests at most this often while a decoder waits for one. */
const KEYFRAME_REQUEST_MS = 500;

const hex2 = (x: number) => x.toString(16).padStart(2, "0");

/** avc1.PPCCLL from the first SPS in an Annex-B keyframe. */
const codecFromSps = (d: Uint8Array): string | null => {
  for (let i = 0; i + 6 < d.length; i++) {
    if (
      d[i] === 0 &&
      d[i + 1] === 0 &&
      d[i + 2] === 1 &&
      ((d[i + 3] ?? 0) & 0x1f) === 7
    )
      return `avc1.${hex2(d[i + 4] ?? 0)}${hex2(d[i + 5] ?? 0)}${hex2(d[i + 6] ?? 0)}`;
  }
  return null;
};

export interface VideoSink {
  /** Sends a text command on the socket. */
  send(command: string): void;
  /** A frame was drawn. */
  drawn(): void;
}

export function createVideo(canvas: HTMLCanvasElement, sink: VideoSink) {
  const context = canvas.getContext("2d", { alpha: false });
  let layout: readonly Stripe[] = [];
  const stripes: StripeState[] = [];
  const frames = new Map<number, PendingFrame>();
  /** Frame ids awaiting presentation, oldest first. */
  const order: number[] = [];
  let keyframeRequested = Number.NEGATIVE_INFINITY;

  const requestKeyframe = () => {
    const now = performance.now();
    if (now - keyframeRequested < KEYFRAME_REQUEST_MS) return;
    keyframeRequested = now;
    sink.send(cmd.keyframe);
  };

  const reset = () => {
    for (const stripe of stripes)
      if (stripe.decoder && stripe.decoder.state !== "closed") {
        try {
          stripe.decoder.close();
        } catch {}
      }
    stripes.length = 0;
    for (const pending of frames.values())
      for (const part of pending.got) part.frame.close();
    frames.clear();
    order.length = 0;
  };

  /** Draws every complete frame at the head of the queue, then acknowledges it. */
  const flush = () => {
    while (order.length > 0) {
      const id = order[0] as number;
      const pending = frames.get(id);
      if (pending && pending.got.length < pending.need) return;
      order.shift();
      frames.delete(id);
      if (pending && pending.got.length > 0) {
        for (const part of pending.got) {
          context?.drawImage(part.frame, 0, part.y);
          part.frame.close();
        }
        sink.drawn();
      }
      sink.send(cmd.ack(id));
    }
  };

  const stripeState = (index: number): StripeState => {
    let stripe = stripes[index];
    if (stripe === undefined) {
      stripe = {
        decoder: null,
        codec: null,
        waitingKey: true,
        timestamp: 0,
        ids: new Map(),
      };
      stripes[index] = stripe;
    }
    return stripe;
  };

  const makeDecoder = (index: number, codec: string): VideoDecoder => {
    const stripe = stripeState(index);
    const decoder = new VideoDecoder({
      output: (frame) => {
        const id = stripe.ids.get(frame.timestamp);
        stripe.ids.delete(frame.timestamp);
        const pending = id === undefined ? undefined : frames.get(id);
        if (!pending) {
          frame.close();
          return;
        }
        pending.got.push({ y: layout[index]?.[0] ?? 0, frame });
        flush();
      },
      error: () => {
        reset();
        requestKeyframe();
      },
    });
    decoder.configure({
      codec,
      optimizeForLatency: true,
      hardwareAcceleration: "no-preference",
    });
    return decoder;
  };

  return {
    /** The server's geometry, from each hello: a new stream starts. */
    configure(width: number, height: number, list: readonly Stripe[]) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      layout = list.length > 0 ? list : [[0, height]];
      reset();
    },
    /** One video message, type byte included. */
    receive(message: Uint8Array) {
      const header = parseVideoHeader(message);
      const data = message.subarray(VIDEO_HEADER_BYTES);
      let pending = frames.get(header.frame);
      if (!pending) {
        pending = { need: header.parts, got: [] };
        frames.set(header.frame, pending);
        order.push(header.frame);
      }
      const stripe = stripeState(header.stripe);
      if (stripe.waitingKey && !header.key) {
        pending.need -= 1;
        requestKeyframe();
        flush();
        return;
      }
      if (header.key) {
        const codec = codecFromSps(data) ?? "avc1.640034";
        if (
          !stripe.decoder ||
          stripe.decoder.state === "closed" ||
          codec !== stripe.codec
        ) {
          if (stripe.decoder && stripe.decoder.state !== "closed") {
            try {
              stripe.decoder.close();
            } catch {}
          }
          stripe.codec = codec;
          stripe.ids.clear();
          try {
            stripe.decoder = makeDecoder(header.stripe, codec);
          } catch {
            pending.need -= 1;
            flush();
            return;
          }
        }
        stripe.waitingKey = false;
      }
      stripe.timestamp += 1;
      stripe.ids.set(stripe.timestamp, header.frame);
      try {
        stripe.decoder?.decode(
          new EncodedVideoChunk({
            type: header.key ? "key" : "delta",
            timestamp: stripe.timestamp,
            data,
          }),
        );
      } catch {
        reset();
        requestKeyframe();
      }
    },
    reset,
  };
}
