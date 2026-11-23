/**
 * The runner channel: `dxd runner` on a person's machine holds one
 * WebSocket to its `RunnerSessionObject` and serves workspace operations
 * for every Thread pinned to that machine. Frames are JSON text.
 *
 * - runner -> Core on open: `{type:"hello", version, os, arch, sandbox, threads}`
 * - Core -> runner: `{type:"hello", update?}` (update when the deployment
 *   serves another version)
 * - Core -> runner: `{type:"request", id, op, thread, body}`
 * - runner -> Core: `{type:"reply", id, ok:true, result}` or
 *   `{type:"reply", id, ok:false, error:{code, message}}`
 * - `{type:"ping"}` / `{type:"pong"}`, every 15 s from the runner
 * - Core -> runner: `{type:"stream-open", stream, path}`, then binary data
 *   messages both ways (Desktop streams, below)
 * - A frame over {@link RUNNER_FRAME_BYTES} travels as `{type:"part", msg,
 *   seq, last, data}` pieces of its JSON text, in order; the receiver joins
 *   the `data` of one `msg` and parses the whole when `last` arrives.
 */

/** A Workers WebSocket message is at most 1 MiB; split well below it. */
export const RUNNER_FRAME_BYTES = 512 * 1024;
/** The runner pings every 15 s; this long silent, it is offline. */
export const RUNNER_OFFLINE_MS = 45_000;
export const RUNNER_PING = '{"type":"ping"}';
export const RUNNER_PONG = '{"type":"pong"}';

export type RunnerOperation =
  | "ensure"
  | "exec"
  | "read"
  | "write"
  | "stat"
  | "readdir"
  | "mkdir"
  | "rm"
  | "daemon"
  | "archive"
  | "pause"
  | "destroy"
  | "threads"
  | "desktop.ensure"
  | "desktop.health"
  | "desktop.windows"
  | "desktop.settings";

export type RunnerErrorCode =
  | "not-found"
  | "exists"
  | "invalid"
  | "offline"
  /** The machine was removed in Settings › Runners (Core's own code). */
  | "removed"
  /** The machine lacks a prerequisite dx cannot fetch (git: on a Mac, Apple's Command Line Tools). */
  | "prerequisites"
  | "timeout"
  | "failed";

const ERROR_CODES = new Set<string>([
  "not-found",
  "exists",
  "invalid",
  "offline",
  "removed",
  "prerequisites",
  "timeout",
  "failed",
]);

/**
 * A runner operation that failed. Durable Object RPC carries only an
 * error's message, so the code travels in it (`runner:<code>:<message>`).
 */
export class RunnerOperationError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(`runner:${code}:${message}`);
    this.name = "RunnerOperationError";
  }

  /** The runner's own words, without the code prefix. */
  get detail(): string {
    return this.message.replace(/^runner:[a-z-]+:/, "");
  }

  static from(cause: unknown): RunnerOperationError {
    if (cause instanceof RunnerOperationError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const match = /^runner:([a-z-]+):([\s\S]*)$/.exec(message);
    if (match !== null && ERROR_CODES.has(match[1] as string))
      return new RunnerOperationError(
        match[1] as RunnerErrorCode,
        match[2] as string,
      );
    return new RunnerOperationError("failed", message);
  }
}

/** Splits a frame's JSON text into parts when it is too large for one. */
export const runnerFrames = (text: string, messageId: string): string[] => {
  // UTF-16 units, not bytes: 256 Ki units are at most 768 KiB of UTF-8,
  // and a part's JSON escaping stays under the 1 MiB message limit.
  const size = RUNNER_FRAME_BYTES / 2;
  if (text.length <= size) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += size)
    parts.push(
      JSON.stringify({
        type: "part",
        msg: messageId,
        seq: parts.length,
        last: offset + size >= text.length,
        data: text.slice(offset, offset + size),
      }),
    );
  return parts;
};

/** Joins `part` frames back into whole frames, in arrival order. */
export class RunnerFrameJoiner {
  readonly #pending = new Map<string, { seq: number; data: string[] }>();

  /** The whole frame's text, or undefined while more parts are due. */
  accept(frame: {
    readonly msg?: unknown;
    readonly seq?: unknown;
    readonly last?: unknown;
    readonly data?: unknown;
  }): string | undefined {
    if (
      typeof frame.msg !== "string" ||
      typeof frame.seq !== "number" ||
      typeof frame.data !== "string"
    )
      return undefined;
    const entry = this.#pending.get(frame.msg) ?? { seq: 0, data: [] };
    if (frame.seq !== entry.seq) {
      this.#pending.delete(frame.msg);
      return undefined;
    }
    entry.data.push(frame.data);
    entry.seq += 1;
    if (frame.last !== true) {
      this.#pending.set(frame.msg, entry);
      // A runner that stops halfway leaves no unbounded buffer behind.
      if (this.#pending.size > 16) {
        const oldest = this.#pending.keys().next().value;
        if (oldest !== undefined) this.#pending.delete(oldest);
      }
      return undefined;
    }
    this.#pending.delete(frame.msg);
    return entry.data.join("");
  }
}

/**
 * Desktop streams (a Mac runner's voxl, reached only through the
 * supervisor). Core opens one per viewer with the text frame
 * `{type:"stream-open", stream, path:"/ws"}`; data then travels as binary
 * messages in both directions: `[u32 stream BE][u8 kind][payload]`, kind 0 a
 * text WebSocket message (UTF-8), 1 a binary one, 2 a close
 * (`[u16 code BE][reason]`). Kind | {@link STREAM_MORE} marks a fragment:
 * payloads up to the next message without it join into one WebSocket
 * message, so a large keyframe crosses in pieces under the 1 MiB limit.
 * dxd's `runner/desktop.rs` holds the same constants.
 */
export const STREAM_KIND_TEXT = 0;
export const STREAM_KIND_BINARY = 1;
export const STREAM_KIND_CLOSE = 2;
export const STREAM_MORE = 0x80;
export const STREAM_CHUNK_BYTES = 512 * 1024;
export const STREAM_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export const encodeStreamFrame = (
  stream: number,
  kind: number,
  payload: Uint8Array,
): Uint8Array => {
  const frame = new Uint8Array(5 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, stream);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
};

export const decodeStreamFrame = (
  frame: ArrayBuffer,
):
  | {
      readonly stream: number;
      readonly kind: number;
      readonly payload: Uint8Array;
    }
  | undefined => {
  if (frame.byteLength < 5) return undefined;
  const view = new DataView(frame);
  return {
    stream: view.getUint32(0),
    kind: view.getUint8(4),
    payload: new Uint8Array(frame, 5),
  };
};

/** One WebSocket message as one or more data messages. */
export const splitStreamMessage = (
  stream: number,
  kind: number,
  payload: Uint8Array,
): Uint8Array[] => {
  if (payload.byteLength <= STREAM_CHUNK_BYTES)
    return [encodeStreamFrame(stream, kind, payload)];
  const frames: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += STREAM_CHUNK_BYTES
  )
    frames.push(
      encodeStreamFrame(
        stream,
        offset + STREAM_CHUNK_BYTES >= payload.byteLength
          ? kind
          : kind | STREAM_MORE,
        payload.subarray(offset, offset + STREAM_CHUNK_BYTES),
      ),
    );
  return frames;
};

export const streamClosePayload = (code: number, reason: string) => {
  const text = new TextEncoder().encode(reason).subarray(0, 120);
  const payload = new Uint8Array(2 + text.byteLength);
  new DataView(payload.buffer).setUint16(0, code);
  payload.set(text, 2);
  return payload;
};

/**
 * Joins one stream's fragments. `undefined` while more are due; `null`
 * when they do not fit together (the stream should end).
 */
export class StreamMessageJoiner {
  #kind: number | undefined;
  #parts: Uint8Array[] = [];
  #bytes = 0;

  accept(
    kind: number,
    payload: Uint8Array,
  ):
    | { readonly kind: number; readonly payload: Uint8Array }
    | undefined
    | null {
    const base = kind & ~STREAM_MORE;
    if (base === STREAM_KIND_CLOSE) {
      this.#reset();
      return { kind: base, payload };
    }
    if (
      (base !== STREAM_KIND_TEXT && base !== STREAM_KIND_BINARY) ||
      (this.#kind !== undefined && this.#kind !== base) ||
      this.#bytes + payload.byteLength > STREAM_MAX_MESSAGE_BYTES
    ) {
      this.#reset();
      return null;
    }
    this.#kind = base;
    this.#parts.push(payload.slice());
    this.#bytes += payload.byteLength;
    if ((kind & STREAM_MORE) !== 0) return undefined;
    const whole = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const part of this.#parts) {
      whole.set(part, offset);
      offset += part.byteLength;
    }
    this.#reset();
    return { kind: base, payload: whole };
  }

  #reset() {
    this.#kind = undefined;
    this.#parts = [];
    this.#bytes = 0;
  }
}
