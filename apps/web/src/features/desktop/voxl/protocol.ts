// voxl's wire protocol, ported from voxl's web client (web/src/protocol.ts at
// tembo/voxl 176f8be, MIT, © 2026 Tembo; see THIRD_PARTY_NOTICES.md), less
// the files, microphone, and audio messages dx does not use. One WebSocket
// carries everything: binary messages start with a type byte, text messages
// are JSON from the server and short comma-separated commands from the
// client.

/** Type byte of binary messages. */
export const Bin = {
  /** Server: H.264 stripe update (16-byte header, then Annex-B). */
  Video: 0x01,
  /** Server: cursor image (RGBA). */
  Cursor: 0x03,
  /** Server: clipboard image (PNG). */
  ClipImage: 0x04,
  /** Client: clipboard image (PNG). */
  ClipImageUp: 0x11,
} as const;

/** A horizontal band of the screen encoded as its own H.264 stream: [y, height]. */
export type Stripe = readonly [y: number, h: number];

export interface Hello {
  readonly t: "hello";
  readonly w: number;
  readonly h: number;
  readonly stripes?: readonly Stripe[];
  /** The server only shows the desktop: the viewer cannot send input. */
  readonly readOnly?: boolean;
  /** Dynamic resolution is on: the viewer may ask for its own size. */
  readonly resize?: { readonly scale: number };
}

/** JSON text messages from the server. */
export type ServerMessage =
  | Hello
  | { readonly t: "ping"; readonly s: number }
  | { readonly t: "clip"; readonly d: string }
  | { readonly t: "close" };

/** Text commands to the server. */
export const cmd = {
  ack: (frame: number) => `a,${frame}`,
  move: (x: number, y: number) => `m,${x},${y}`,
  button: (button: number, down: boolean) => `b,${button},${down ? 1 : 0}`,
  /** Scroll in desktop pixels; the server turns it into smooth scrolling or wheel clicks. */
  scroll: (dx: number, dy: number) => `sp,${dx.toFixed(1)},${dy.toFixed(1)}`,
  key: (keysym: number, down: boolean) => `k,${keysym},${down ? 1 : 0}`,
  releaseAll: "r",
  clipboard: (text: string) => `c,${text}`,
  video: (on: boolean) => `v,${on ? 1 : 0}`,
  /** Ask for a desktop of this size (dynamic resolution). */
  resize: (w: number, h: number) => `sz,${w},${h}`,
  keyframe: "kf",
  pong: (sent: number) => `po,${sent}`,
} as const;

/** Commands that only watch; the server accepts only these from a read-only viewer. */
export const WATCH_COMMANDS: ReadonlySet<string> = new Set([
  "a",
  "v",
  "kf",
  "po",
]);

/** Header of a video message (after the type byte). */
export interface VideoHeader {
  readonly key: boolean;
  readonly frame: number;
  readonly stripe: number;
  /** Stripe updates that make up this frame. */
  readonly parts: number;
}

export const VIDEO_HEADER_BYTES = 16;

export function parseVideoHeader(b: Uint8Array): VideoHeader {
  const at = (i: number) => b[i] ?? 0;
  const u32 = (i: number) =>
    ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  return {
    key: (at(1) & 1) === 1,
    frame: u32(2),
    stripe: at(10),
    parts: at(12),
  };
}
