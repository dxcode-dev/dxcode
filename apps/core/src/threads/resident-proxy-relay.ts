import {
  type BrowserSessionBinding,
  closeForEndedSession,
} from "../auth/session-sockets.js";
import {
  DXD_PROXY_KIND_BYTES,
  DXD_PROXY_KIND_TEXT,
  DXD_PROXY_MAX_BODY_CHUNK_BYTES,
  DXD_PROXY_MAX_HEAD_FRAME_BYTES,
  DXD_PROXY_MAX_STREAM_ID,
  DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES,
  DXD_PROXY_STREAM_WINDOW,
  type DxdProxyClientMessage,
  decodeDxdProxyFrame,
  dxdProxyOpenProblem,
  encodeDxdProxyFrame,
} from "../execution/dxd/protocol.js";

/**
 * Relays Portal and Desktop traffic to a guest loopback port through the
 * resident daemon's session (`proxy.open` streams and `DXP1` frames). An
 * HTTP exchange lives in memory for the length of its request; a proxied
 * WebSocket is a hibernatable browser socket tagged with its stream, so it
 * survives this object's hibernation.
 *
 * Nothing a browser or guest sends may end the daemon session: Core checks
 * every request against dxd's bounds before sending it and never sends more
 * than `DXD_PROXY_STREAM_WINDOW` unacknowledged frames on a stream, and a
 * stream that misbehaves fails alone.
 */

export const PROXY_ERROR_HEADER = "x-dx-proxy-error";

export type ProxyFailure =
  | "upstream-unreachable"
  | "upstream-timeout"
  | "upstream-reset"
  | "upstream-rejected"
  | "invalid-request"
  | "invalid-response"
  | "too-many-streams"
  | "closed"
  | "workspace-unavailable"
  | "workspace-paused"
  | "desktop-unavailable"
  | "desktop-unsupported"
  | "service-starting";

const failureStatus: Record<ProxyFailure, number> = {
  "upstream-unreachable": 502,
  "upstream-reset": 502,
  "upstream-rejected": 502,
  "invalid-response": 502,
  closed: 502,
  "upstream-timeout": 504,
  "invalid-request": 400,
  "too-many-streams": 503,
  "workspace-unavailable": 503,
  "workspace-paused": 503,
  "desktop-unavailable": 503,
  "desktop-unsupported": 501,
  "service-starting": 503,
};

/** The relay's own failures, known without trusting any header. */
const relayFailures = new WeakMap<Response, ProxyFailure>();

/**
 * A relay failure. `x-dx-proxy-error` carries the reason past this object;
 * the relay strips that header from every guest response, so it is never
 * the guest's.
 */
export const proxyFailure = (
  reason: ProxyFailure,
  status = failureStatus[reason],
) => {
  const response = new Response(null, {
    status,
    headers: { [PROXY_ERROR_HEADER]: reason, "cache-control": "no-store" },
  });
  relayFailures.set(response, reason);
  return response;
};

/** The reason when `response` is the relay's own failure. */
export const proxyFailureReason = (response: Response) =>
  relayFailures.get(response);

export interface ProxyBrowserAttachment {
  readonly kind: "proxy-browser";
  readonly streamId: number;
  /** The daemon session the guest end of this stream lives in. */
  readonly daemonNonce: string;
  /** The browser session that opened the socket; it closes when that ends. */
  readonly session?: BrowserSessionBinding;
}

export const proxyBrowserTag = (streamId: number) => `proxy:${streamId}`;

export interface ResidentProxyHost {
  /** The current daemon socket when it speaks proxy version 1. */
  readonly daemon: () => { socket: WebSocket; nonce: string } | undefined;
  readonly acceptBrowser: (
    server: WebSocket,
    attachment: ProxyBrowserAttachment,
  ) => void;
  readonly browsers: (streamId?: number) => WebSocket[];
  /**
   * Proxied traffic is workspace activity. Only a request that was allowed
   * to wake the workspace (`wake`) may reach a paused one to record it.
   */
  readonly activity: (wake: boolean) => void;
}

/** dxd allows 128 per session; leave room for streams still closing. */
const MAX_STREAMS = 96;
/**
 * The longest a request waits for its response head without progress: the
 * clock restarts whenever dxd takes a request body frame, so a large upload
 * is not cut off, and a dev server may compile on its first request.
 */
const HEAD_TIMEOUT_MS = 125_000;
const ACCEPT_TIMEOUT_MS = 15_000;
/** Response chunks buffered for a slow browser before acknowledgements wait. */
const RESPONSE_HIGH_WATER_MARK = 4;
/**
 * Browser messages held while dxd's window for the stream is full. A
 * browser that sends past this is closed with 1013; one maximal message
 * always fits an empty buffer.
 */
const BROWSER_BUFFER_BYTES = DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES;
const BROWSER_BUFFER_MESSAGES = 1_024;
/** Across every proxied WebSocket of this object. */
const BROWSER_BUFFER_TOTAL_BYTES = 4 * DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES;
/** Statuses whose response has no body (Fetch's null body statuses). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Headers that describe one connection, never the exchange it carries. */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

interface HttpStream {
  readonly kind: "http";
  readonly socket: WebSocket;
  readonly method: string;
  readonly resolveHead: (response: Response) => void;
  headSettled: boolean;
  headTimer?: ReturnType<typeof setTimeout>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  /** Body frames received but not yet acknowledged, held for backpressure. */
  pendingAcks: number;
  /** Request body frames dxd may still accept. */
  requestCredits: number;
  readonly creditWaiters: Array<(available: boolean) => void>;
  /** The browser's request body, cancelled when the exchange ends. */
  requestBody?: ReadableStreamDefaultReader<Uint8Array>;
}

interface WebSocketOpening {
  readonly kind: "websocket";
  readonly socket: WebSocket;
  readonly settle: (
    outcome: { protocol: string | null } | { failure: ProxyFailure },
  ) => void;
}

type Stream = HttpStream | WebSocketOpening;

/**
 * Browser-to-guest flow for an accepted WebSocket. It lives in memory only;
 * an object that lost it (hibernation, a reset) starts a fresh one.
 */
interface BrowserWindow {
  readonly daemon: WebSocket;
  /** Frames dxd may still accept. */
  credits: number;
  readonly queue: Array<{ readonly frame: Uint8Array; readonly bytes: number }>;
  queuedBytes: number;
}

const closeCodeForBrowser = (code: number) =>
  code === 1005 || code === 1006 || code === 1015 ? 1000 : code;

const truncateReason = (reason: string) => {
  const encoder = new TextEncoder();
  let truncated = reason;
  while (encoder.encode(truncated).byteLength > 123)
    truncated = truncated.slice(0, -1);
  return truncated;
};

export class ResidentProxyRelay {
  readonly #host: ResidentProxyHost;
  readonly #streams = new Map<number, Stream>();
  readonly #windows = new Map<number, BrowserWindow>();
  #queuedBytes = 0;

  constructor(host: ResidentProxyHost) {
    this.#host = host;
  }

  get size() {
    return this.#streams.size;
  }

  #allocate() {
    for (;;) {
      const candidate =
        (crypto.getRandomValues(new Uint32Array(1))[0] as number) %
        DXD_PROXY_MAX_STREAM_ID;
      if (
        candidate !== 0 &&
        !this.#streams.has(candidate) &&
        this.#host.browsers(candidate).length === 0
      )
        return candidate;
    }
  }

  #send(socket: WebSocket, message: unknown) {
    socket.send(JSON.stringify(message));
  }

  /** The `proxy.open` frame, or the failure Core answers instead. */
  #open(open: {
    readonly streamId: number;
    readonly port: number;
    readonly mode: "http" | "websocket";
    readonly method: string;
    readonly target: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly protocols: readonly string[];
    readonly body: boolean;
  }): string | Response {
    const problem = dxdProxyOpenProblem(open);
    if (problem !== undefined)
      return proxyFailure("invalid-request", problem === "headers" ? 431 : 400);
    const frame = JSON.stringify({ type: "proxy.open", ...open });
    return new TextEncoder().encode(frame).byteLength >
      DXD_PROXY_MAX_HEAD_FRAME_BYTES
      ? proxyFailure("invalid-request", 431)
      : frame;
  }

  async http(input: {
    readonly port: number;
    readonly target: string;
    readonly method: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly body: ReadableStream<Uint8Array> | null;
    readonly wake: boolean;
  }): Promise<Response> {
    const daemon = this.#host.daemon();
    if (daemon === undefined) return proxyFailure("workspace-unavailable");
    if (this.#streams.size >= MAX_STREAMS)
      return proxyFailure("too-many-streams");
    const streamId = this.#allocate();
    const open = this.#open({
      streamId,
      port: input.port,
      mode: "http",
      method: input.method,
      target: input.target,
      headers: input.headers,
      protocols: [],
      body: input.body !== null,
    });
    if (typeof open !== "string") return open;
    let resolveHead!: (response: Response) => void;
    const head = new Promise<Response>((resolve) => {
      resolveHead = resolve;
    });
    const stream: HttpStream = {
      kind: "http",
      socket: daemon.socket,
      method: input.method,
      resolveHead,
      headSettled: false,
      pendingAcks: 0,
      requestCredits: DXD_PROXY_STREAM_WINDOW,
      creditWaiters: [],
    };
    this.#streams.set(streamId, stream);
    try {
      daemon.socket.send(open);
    } catch {
      this.#streams.delete(streamId);
      return proxyFailure("workspace-unavailable");
    }
    this.#host.activity(input.wake);
    this.#armHeadTimeout(streamId, stream);
    if (input.body !== null) void this.#pumpBody(streamId, stream, input.body);
    return head;
  }

  /** (Re)start the wait for the response head; body progress restarts it. */
  #armHeadTimeout(streamId: number, stream: HttpStream) {
    clearTimeout(stream.headTimer);
    if (stream.headSettled) return;
    stream.headTimer = setTimeout(
      () => this.#abandon(streamId, "upstream-timeout"),
      HEAD_TIMEOUT_MS,
    );
  }

  #settleHead(stream: HttpStream, response: Response) {
    stream.headSettled = true;
    clearTimeout(stream.headTimer);
    stream.resolveHead(response);
  }

  async #pumpBody(
    streamId: number,
    stream: HttpStream,
    body: ReadableStream<Uint8Array>,
  ) {
    const reader = body.getReader();
    stream.requestBody = reader;
    const current = () => this.#streams.get(streamId) === stream;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // The exchange ended and cancelled the body.
        if (!current()) return;
        if (done) break;
        for (
          let offset = 0;
          offset < value.byteLength;
          offset += DXD_PROXY_MAX_BODY_CHUNK_BYTES
        ) {
          if (!(await this.#requestCredit(stream)) || !current()) return;
          stream.socket.send(
            encodeDxdProxyFrame(
              streamId,
              DXD_PROXY_KIND_BYTES,
              value.subarray(offset, offset + DXD_PROXY_MAX_BODY_CHUNK_BYTES),
            ),
          );
        }
      }
      if (current()) this.#send(stream.socket, { type: "proxy.end", streamId });
    } catch {
      if (current()) this.#abandon(streamId, "invalid-request");
    }
  }

  #requestCredit(stream: HttpStream) {
    if (stream.requestCredits > 0) {
      stream.requestCredits -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      stream.creditWaiters.push(resolve);
    });
  }

  /** Core gives up on an exchange; dxd abandons it too. */
  #abandon(streamId: number, reason: ProxyFailure) {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) return;
    this.#streams.delete(streamId);
    try {
      this.#send(stream.socket, {
        type: "proxy.close",
        streamId,
        code: null,
        reason: null,
      });
    } catch {
      // The daemon session already ended.
    }
    this.#fail(stream, reason);
  }

  /** The exchange is over: stop its timer and its request body. */
  #finish(stream: HttpStream) {
    clearTimeout(stream.headTimer);
    for (const waiter of stream.creditWaiters.splice(0)) waiter(false);
    stream.requestBody?.cancel().catch(() => undefined);
  }

  #fail(stream: Stream, reason: ProxyFailure) {
    if (stream.kind === "websocket") {
      stream.settle({ failure: reason });
      return;
    }
    this.#finish(stream);
    if (!stream.headSettled) {
      this.#settleHead(stream, proxyFailure(reason));
      return;
    }
    try {
      stream.controller?.error(new Error(reason));
    } catch {
      // Already closed or cancelled.
    }
  }

  async websocket(input: {
    readonly port: number;
    readonly target: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly protocols: readonly string[];
    readonly wake: boolean;
    readonly session?: BrowserSessionBinding;
  }): Promise<Response> {
    const daemon = this.#host.daemon();
    if (daemon === undefined) return proxyFailure("workspace-unavailable");
    if (this.#streams.size >= MAX_STREAMS)
      return proxyFailure("too-many-streams");
    const streamId = this.#allocate();
    const open = this.#open({
      streamId,
      port: input.port,
      mode: "websocket",
      method: "GET",
      target: input.target,
      headers: input.headers,
      protocols: input.protocols,
      body: false,
    });
    if (typeof open !== "string") return open;
    let settle!: WebSocketOpening["settle"];
    const accepted = new Promise<
      { protocol: string | null } | { failure: ProxyFailure }
    >((resolve) => {
      settle = resolve;
    });
    this.#streams.set(streamId, {
      kind: "websocket",
      socket: daemon.socket,
      settle,
    });
    try {
      daemon.socket.send(open);
    } catch {
      this.#streams.delete(streamId);
      return proxyFailure("workspace-unavailable");
    }
    this.#host.activity(input.wake);
    const timeout = setTimeout(
      () => this.#abandon(streamId, "upstream-timeout"),
      ACCEPT_TIMEOUT_MS,
    );
    const outcome = await accepted;
    clearTimeout(timeout);
    this.#streams.delete(streamId);
    if ("failure" in outcome) return proxyFailure(outcome.failure);
    // From here the stream is the tagged browser socket, so it outlives
    // this object's memory. This continuation runs before the daemon's next
    // message is delivered, so no frame for the stream is missed.
    const pair = new WebSocketPair();
    this.#host.acceptBrowser(pair[1], {
      kind: "proxy-browser",
      streamId,
      daemonNonce: daemon.nonce,
      ...(input.session === undefined ? {} : { session: input.session }),
    });
    this.#windows.set(streamId, {
      daemon: daemon.socket,
      credits: DXD_PROXY_STREAM_WINDOW,
      queue: [],
      queuedBytes: 0,
    });
    const headers = new Headers();
    if (outcome.protocol !== null)
      headers.set("sec-websocket-protocol", outcome.protocol);
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  receiveDaemonMessage(socket: WebSocket, message: DxdProxyClientMessage) {
    const { streamId } = message;
    const stream = this.#streams.get(streamId);
    if (stream !== undefined && stream.socket !== socket) return;
    if (stream?.kind === "http") {
      this.#receiveHttp(streamId, stream, message);
      return;
    }
    if (stream?.kind === "websocket") {
      if (message.type === "proxy.accepted")
        stream.settle({ protocol: message.protocol });
      else if (message.type === "proxy.error")
        stream.settle({ failure: message.reason });
      else this.#abandon(streamId, "invalid-response");
      return;
    }
    // An accepted WebSocket: the stream is its tagged browser socket.
    if (message.type === "proxy.ack") {
      const window = this.#windows.get(streamId);
      if (window === undefined || window.daemon !== socket) return;
      window.credits = Math.min(DXD_PROXY_STREAM_WINDOW, window.credits + 1);
      this.#flush(streamId, window);
      return;
    }
    const browsers = this.#host.browsers(streamId);
    this.#dropWindow(streamId);
    if (message.type === "proxy.closed") {
      for (const browser of browsers)
        browser.close(closeCodeForBrowser(message.code), message.reason);
      return;
    }
    if (message.type === "proxy.error") {
      for (const browser of browsers)
        browser.close(1011, truncateReason(message.reason));
      return;
    }
    if (browsers.length > 0) this.rejectDaemonMessage(socket, streamId);
  }

  /**
   * dxd sent a `proxy.*` message for `streamId` that Core cannot use (it
   * broke the schema, or came out of order): that stream fails, and the
   * daemon session carries on.
   */
  rejectDaemonMessage(socket: WebSocket, streamId: number) {
    const stream = this.#streams.get(streamId);
    if (stream !== undefined) {
      if (stream.socket === socket) this.#abandon(streamId, "invalid-response");
      return;
    }
    const browsers = this.#host.browsers(streamId);
    if (browsers.length === 0) return;
    this.#dropWindow(streamId);
    for (const browser of browsers)
      try {
        browser.close(1011, "Invalid workspace response");
      } catch {
        // Already closed.
      }
    this.#closeStream(socket, streamId, 1011);
  }

  #closeStream(socket: WebSocket, streamId: number, code: number | null) {
    try {
      this.#send(socket, { type: "proxy.close", streamId, code, reason: null });
    } catch {
      // The daemon session already ended.
    }
  }

  #receiveHttp(
    streamId: number,
    stream: HttpStream,
    message: DxdProxyClientMessage,
  ) {
    switch (message.type) {
      case "proxy.ack": {
        // dxd took a request body frame: the exchange is progressing.
        this.#armHeadTimeout(streamId, stream);
        const waiter = stream.creditWaiters.shift();
        if (waiter !== undefined) waiter(true);
        else
          stream.requestCredits = Math.min(
            DXD_PROXY_STREAM_WINDOW,
            stream.requestCredits + 1,
          );
        return;
      }
      case "proxy.response": {
        if (
          stream.headSettled ||
          message.status < 200 ||
          message.status > 599
        ) {
          this.#abandon(streamId, "invalid-response");
          return;
        }
        const headers = new Headers();
        for (const [name, value] of message.headers) {
          const lower = name.toLowerCase();
          // Only the relay reports relay failures.
          if (HOP_BY_HOP_HEADERS.has(lower) || lower === PROXY_ERROR_HEADER)
            continue;
          try {
            headers.append(name, value);
          } catch {
            // A header Workers cannot represent is dropped.
          }
        }
        const bodyless =
          stream.method === "HEAD" || NULL_BODY_STATUSES.has(message.status);
        // The guest's bytes are already encoded: Workers must not encode
        // them again for the `Content-Encoding` they carry.
        const init: ResponseInit = {
          status: message.status,
          headers,
          ...(!bodyless && headers.has("content-encoding")
            ? { encodeBody: "manual" }
            : {}),
        };
        let response: Response;
        try {
          response = bodyless
            ? new Response(null, init)
            : new Response(
                new ReadableStream<Uint8Array>(
                  {
                    start: (controller) => {
                      stream.controller = controller;
                    },
                    pull: () => {
                      if (stream.pendingAcks === 0) return;
                      stream.pendingAcks -= 1;
                      if (this.#streams.get(streamId) === stream)
                        this.#ack(stream.socket, streamId);
                    },
                    cancel: () => this.#abandon(streamId, "closed"),
                  },
                  { highWaterMark: RESPONSE_HIGH_WATER_MARK },
                ),
                init,
              );
        } catch {
          this.#abandon(streamId, "invalid-response");
          return;
        }
        this.#settleHead(stream, response);
        return;
      }
      case "proxy.end":
        this.#streams.delete(streamId);
        this.#finish(stream);
        if (!stream.headSettled) {
          this.#settleHead(stream, proxyFailure("invalid-response"));
          return;
        }
        try {
          stream.controller?.close();
        } catch {
          // The browser already cancelled.
        }
        return;
      case "proxy.error":
        this.#streams.delete(streamId);
        this.#fail(stream, message.reason);
        return;
      default:
        this.#abandon(streamId, "invalid-response");
    }
  }

  #ack(socket: WebSocket, streamId: number) {
    try {
      this.#send(socket, { type: "proxy.ack", streamId });
    } catch {
      // The daemon session already ended.
    }
  }

  receiveDaemonFrame(socket: WebSocket, frame: ArrayBuffer) {
    const { streamId, kind, payload } = decodeDxdProxyFrame(frame);
    const stream = this.#streams.get(streamId);
    if (stream !== undefined) {
      if (stream.socket !== socket) return;
      if (
        stream.kind !== "http" ||
        stream.controller === undefined ||
        kind !== DXD_PROXY_KIND_BYTES
      ) {
        this.#abandon(streamId, "invalid-response");
        return;
      }
      try {
        stream.controller.enqueue(payload);
      } catch {
        // The browser cancelled; `cancel` already closed the stream.
        return;
      }
      if ((stream.controller.desiredSize ?? 0) > 0)
        this.#ack(stream.socket, streamId);
      else stream.pendingAcks += 1;
      return;
    }
    const browsers = this.#host.browsers(streamId);
    if (browsers.length === 0) {
      // Nobody holds this stream any more.
      this.#closeStream(socket, streamId, 1001);
      return;
    }
    const message =
      kind === DXD_PROXY_KIND_TEXT
        ? new TextDecoder().decode(payload)
        : payload;
    for (const browser of browsers)
      try {
        browser.send(message);
      } catch {
        // The browser is closing; its close event ends the stream.
      }
    // Workers exposes no `bufferedAmount` on a server WebSocket, so this
    // object cannot see the browser read. A message is acknowledged once
    // handed to the runtime; dxd's window bounds what is in flight between
    // the guest and this object, not what the runtime holds for a browser
    // that reads slower than the guest writes.
    this.#ack(socket, streamId);
  }

  receiveBrowser(
    socket: WebSocket,
    attachment: ProxyBrowserAttachment,
    frame: string | ArrayBuffer,
  ) {
    const { streamId } = attachment;
    const daemon = this.#host.daemon();
    if (daemon === undefined || daemon.nonce !== attachment.daemonNonce) {
      this.#dropWindow(streamId);
      socket.close(1012, "Workspace connection changed");
      return;
    }
    const payload =
      typeof frame === "string"
        ? new TextEncoder().encode(frame)
        : new Uint8Array(frame);
    if (payload.byteLength > DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES) {
      this.#closeBrowser(
        socket,
        daemon.socket,
        streamId,
        1009,
        "Message too large",
      );
      return;
    }
    let window = this.#windows.get(streamId);
    if (window === undefined || window.daemon !== daemon.socket) {
      // This object restarted (hibernation, or a reset) and lost the window.
      // It hibernates only with no event pending, so dxd has acknowledged
      // everything it was sent; a full window is the right guess, and a
      // wrong one fails only this stream in dxd.
      window = {
        daemon: daemon.socket,
        credits: DXD_PROXY_STREAM_WINDOW,
        queue: [],
        queuedBytes: 0,
      };
      this.#windows.set(streamId, window);
    }
    const encoded = encodeDxdProxyFrame(
      streamId,
      typeof frame === "string" ? DXD_PROXY_KIND_TEXT : DXD_PROXY_KIND_BYTES,
      payload,
    );
    if (window.credits > 0 && window.queue.length === 0) {
      try {
        daemon.socket.send(encoded);
      } catch {
        this.#dropWindow(streamId);
        socket.close(1012, "Workspace connection lost");
        return;
      }
      window.credits -= 1;
    } else {
      // dxd's window is full: hold the message until it acknowledges one.
      if (
        window.queue.length >= BROWSER_BUFFER_MESSAGES ||
        window.queuedBytes + payload.byteLength > BROWSER_BUFFER_BYTES ||
        this.#queuedBytes + payload.byteLength > BROWSER_BUFFER_TOTAL_BYTES
      ) {
        this.#closeBrowser(
          socket,
          daemon.socket,
          streamId,
          1013,
          "Workspace is not keeping up",
        );
        return;
      }
      window.queue.push({ frame: encoded, bytes: payload.byteLength });
      window.queuedBytes += payload.byteLength;
      this.#queuedBytes += payload.byteLength;
    }
    this.#host.activity(false);
  }

  /** Send held browser messages while dxd's window has room. */
  #flush(streamId: number, window: BrowserWindow) {
    while (window.credits > 0) {
      const next = window.queue.shift();
      if (next === undefined) return;
      window.queuedBytes -= next.bytes;
      this.#queuedBytes -= next.bytes;
      try {
        window.daemon.send(next.frame);
      } catch {
        this.#dropWindow(streamId);
        return;
      }
      window.credits -= 1;
    }
  }

  #dropWindow(streamId: number) {
    const window = this.#windows.get(streamId);
    if (window === undefined) return;
    this.#queuedBytes -= window.queuedBytes;
    this.#windows.delete(streamId);
  }

  /** End one proxied WebSocket from Core's side: the browser and the guest. */
  #closeBrowser(
    socket: WebSocket,
    daemon: WebSocket,
    streamId: number,
    code: number,
    reason: string,
  ) {
    this.#dropWindow(streamId);
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
    this.#closeStream(daemon, streamId, 1001);
  }

  /** The browser session behind this socket ended; the guest end closes too. */
  endSession(socket: WebSocket, attachment: ProxyBrowserAttachment) {
    closeForEndedSession(socket);
    this.browserClosed(attachment, 1001, "");
  }

  browserClosed(
    attachment: ProxyBrowserAttachment,
    code: number,
    reason: string,
  ) {
    this.#dropWindow(attachment.streamId);
    const daemon = this.#host.daemon();
    if (daemon === undefined || daemon.nonce !== attachment.daemonNonce) return;
    try {
      this.#send(daemon.socket, {
        type: "proxy.close",
        streamId: attachment.streamId,
        code:
          code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
            ? code
            : 1000,
        reason: truncateReason(reason),
      });
    } catch {
      // The daemon session already ended.
    }
  }

  /**
   * The daemon session ended, was replaced, or was drained: every stream it
   * carried is gone, so pending exchanges fail and proxied sockets close.
   */
  daemonUnavailable(currentNonce?: string) {
    for (const [streamId, stream] of this.#streams) {
      this.#streams.delete(streamId);
      this.#fail(stream, "workspace-unavailable");
    }
    for (const browser of this.#host.browsers()) {
      const attachment = browser.deserializeAttachment() as
        | ProxyBrowserAttachment
        | undefined;
      if (attachment?.daemonNonce === currentNonce) continue;
      if (attachment !== undefined) this.#dropWindow(attachment.streamId);
      try {
        browser.close(1012, "Workspace connection lost");
      } catch {
        // Already closed.
      }
    }
  }
}
