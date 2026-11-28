import { DurableObject } from "cloudflare:workers";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../http/types.js";
import {
  decodeStreamFrame,
  RUNNER_OFFLINE_MS,
  RUNNER_PING,
  RUNNER_PONG,
  RunnerFrameJoiner,
  type RunnerOperation,
  RunnerOperationError,
  runnerFrames,
  STREAM_KIND_BINARY,
  STREAM_KIND_CLOSE,
  STREAM_KIND_TEXT,
  STREAM_MORE,
  StreamMessageJoiner,
  splitStreamMessage,
  streamClosePayload,
} from "./protocol.js";
import { machineRemoved, recordMachineSeen } from "./repository.js";

const logger = getLogger(["dx", "runners", "session"]);

/** Set by Core's connect route; callers' copies never reach the object. */
export const RUNNER_MACHINE_HEADER = "x-dx-runner-machine";
export const RUNNER_ORIGIN_HEADER = "x-dx-runner-origin";

/** How long a request waits for an offline runner to come back. */
const RECONNECT_WAIT_MS = 10_000;
const DEFAULT_REQUEST_MS = 60_000;
/** last_seen_at is written at most this often while requests flow. */
const SEEN_WRITE_MS = 60_000;

interface SocketState {
  readonly machineId: string;
  readonly origin: string;
  readonly connectedAt: number;
  readonly version?: string;
  readonly os?: "macos" | "linux";
  readonly arch?: string;
  readonly sandbox?: string;
  /** Prerequisites the machine lacks (git, python3), as its hello said. */
  readonly missing?: readonly string[];
  /** The runner's public IP as Cloudflare saw it when it connected. */
  readonly ip?: string;
}

/** A viewer's WebSocket to the machine's Desktop (voxl via the runner). */
interface DesktopSocketState {
  readonly kind: "desktop";
  readonly stream: number;
  readonly thread: string;
}

const isDesktopSocket = (state: unknown): state is DesktopSocketState =>
  typeof state === "object" &&
  state !== null &&
  (state as { readonly kind?: unknown }).kind === "desktop";

const desktopTag = (stream: number) => `desktop:${String(stream)}`;

/** Close codes a server may send; voxl's own pass, others become 1011. */
const browserCloseCode = (code: number | undefined) =>
  code !== undefined &&
  code >= 1000 &&
  code <= 4999 &&
  code !== 1004 &&
  code !== 1005 &&
  code !== 1006 &&
  code !== 1015 &&
  (code < 1016 || code >= 3000)
    ? code
    : 1011;

export interface RunnerStatus {
  readonly online: boolean;
  readonly lastSeenAt: number | null;
  readonly version: string | null;
  readonly os: string | null;
  readonly arch: string | null;
  readonly sandbox: string | null;
  /**
   * Prerequisites dx cannot fetch that the machine lacks (git, python3: on
   * a Mac, Apple's Command Line Tools).
   */
  readonly missing: readonly string[];
  /** The runner's public IP, for telling a viewer on the same network. */
  readonly ip: string | null;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RunnerOperationError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const SUPPORTED_ASSETS = new Set([
  "macos-aarch64",
  "linux-x86_64",
  "linux-aarch64",
]);

/**
 * One paired machine's live connection (`idFromName(machineId)`). The
 * runner dials out to it; Core's runner provider calls {@link call} to run
 * a workspace operation for one of the machine's Threads and awaits the
 * reply. Pings are answered without waking the object (an automatic
 * response), and their timestamp tells whether the runner is online.
 *
 * It also holds the viewers of the machine's Desktop (`/desktop/ws`, after
 * Core's owner check): each is a hibernatable socket tagged with its
 * stream, relayed to and from voxl through the runner's own connection.
 */
export class RunnerSessionObject extends DurableObject<Bindings> {
  readonly #pending = new Map<string, Pending>();
  readonly #joiner = new RunnerFrameJoiner();
  /** Desktop fragments from the runner, per stream, until a message joins. */
  readonly #fromRunner = new Map<number, StreamMessageJoiner>();
  #nextId = 0;
  #seenWrittenAt = 0;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RUNNER_PING, RUNNER_PONG),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/desktop/ws")
      return this.#openDesktop(request);
    const machineId = request.headers.get(RUNNER_MACHINE_HEADER);
    const origin = request.headers.get(RUNNER_ORIGIN_HEADER);
    if (
      machineId === null ||
      origin === null ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response(null, { status: 400 });
    // A machine holds one connection: a new one replaces the old, and the
    // Desktop streams that went through the old one end with it.
    for (const socket of this.ctx.getWebSockets())
      socket.close(
        isDesktopSocket(socket.deserializeAttachment()) ? 1012 : 4000,
        "Replaced by a newer connection.",
      );
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [machineId]);
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    const state: SocketState = {
      machineId,
      origin,
      connectedAt: Date.now(),
      ...(ip === undefined ? {} : { ip }),
    };
    server.serializeAttachment(state);
    // Removing a machine marks it revoked, then closes the sockets it finds
    // (`revoke`). Checked again at the primary once this socket is accepted,
    // a removal that raced the connection closes this one too (#2696).
    if (
      this.env.DB !== undefined &&
      (await machineRemoved(this.env.DB, machineId))
    ) {
      server.close(4401, "This runner was removed from dx.");
      logger.warn("Removed runner refused.", {
        event: "runner_removed_refused",
        machineId,
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    await this.#recordSeen(state, true);
    logger.info("Runner connected.", { event: "runner_connected", machineId });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as unknown;
    if (isDesktopSocket(attachment)) {
      this.#fromBrowser(socket, attachment, message);
      return;
    }
    if (typeof message !== "string") {
      this.#fromRunnerData(message);
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "part") {
      const whole = this.#joiner.accept(frame);
      if (whole === undefined) return;
      try {
        frame = JSON.parse(whole) as Record<string, unknown>;
      } catch {
        return;
      }
    }
    const state = socket.deserializeAttachment() as SocketState | null;
    if (state === null) return;
    switch (frame.type) {
      case "hello":
        await this.#hello(socket, state, frame);
        return;
      case "reply":
        this.#reply(frame);
        await this.#recordSeen(state, false);
        return;
      case "ping":
        socket.send(RUNNER_PONG);
        return;
      default:
        return;
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    await this.#disconnected(socket, code, reason);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.#disconnected(socket, 1011, "");
  }

  /** Whether the runner is connected now, and what it last reported. */
  async status(): Promise<RunnerStatus> {
    const socket = this.#socket();
    const state = socket?.deserializeAttachment() as SocketState | undefined;
    return {
      online: socket !== undefined,
      lastSeenAt: socket === undefined ? null : this.#lastHeard(socket),
      version: state?.version ?? null,
      os: state?.os ?? null,
      arch: state?.arch ?? null,
      sandbox: state?.sandbox ?? null,
      missing: state?.missing ?? [],
      ip: state?.ip ?? null,
    };
  }

  /** Closes the machine's connection for good: it was removed. */
  async revoke(): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      socket.close(4401, "This runner was removed from dx.");
  }

  /**
   * Runs one operation for a Thread on the machine. `body.uploadPath` and
   * `body.restore.path` become absolute URLs on the origin the runner
   * connected to. Throws {@link RunnerOperationError}, `offline` when the
   * machine is not connected.
   */
  async call(
    op: RunnerOperation,
    thread: string,
    body: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_MS,
  ): Promise<unknown> {
    const socket = await this.#awaitSocket();
    if (socket === undefined)
      throw new RunnerOperationError("offline", "The runner is offline.");
    const state = socket.deserializeAttachment() as SocketState;
    const id = `r${Date.now().toString(36)}${(this.#nextId++).toString(36)}`;
    const text = JSON.stringify({
      type: "request",
      id,
      op,
      thread,
      body: withAbsoluteUrls(body, state.origin),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new RunnerOperationError(
            "timeout",
            `The runner did not answer ${op} in time.`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        for (const frame of runnerFrames(text, id)) socket.send(frame);
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new RunnerOperationError("offline", "The runner is offline."));
      }
    });
  }

  #socket(): WebSocket | undefined {
    const now = Date.now();
    return this.#runnerSockets().find(
      (socket) => now - this.#lastHeard(socket) < RUNNER_OFFLINE_MS,
    );
  }

  #runnerSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => !isDesktopSocket(socket.deserializeAttachment()));
  }

  /**
   * A viewer of the machine's Desktop, already authorized as the Thread's
   * owner by Core's route: a new stream to voxl through the runner.
   */
  async #openDesktop(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 400 });
    const thread = request.headers.get("x-dx-thread-id") ?? "";
    const runner = await this.#awaitSocket();
    if (runner === undefined)
      return new Response(null, {
        status: 503,
        headers: { "x-dx-proxy-error": "workspace-unavailable" },
      });
    let stream = 0;
    while (
      stream === 0 ||
      this.ctx.getWebSockets(desktopTag(stream)).length > 0
    )
      stream = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ["desktop", desktopTag(stream)]);
    server.serializeAttachment({
      kind: "desktop",
      stream,
      thread,
    } satisfies DesktopSocketState);
    try {
      runner.send(JSON.stringify({ type: "stream-open", stream, path: "/ws" }));
    } catch {
      server.close(1011, "The runner is offline.");
    }
    logger.info("Desktop stream opened.", {
      event: "runner_desktop_opened",
      threadId: thread,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A viewer's message, to voxl through the runner. */
  #fromBrowser(
    socket: WebSocket,
    state: DesktopSocketState,
    message: string | ArrayBuffer,
  ) {
    const runner = this.#socket();
    if (runner === undefined) {
      socket.close(1012, "The runner disconnected.");
      return;
    }
    const [kind, payload] =
      typeof message === "string"
        ? [STREAM_KIND_TEXT, new TextEncoder().encode(message)]
        : [STREAM_KIND_BINARY, new Uint8Array(message)];
    try {
      for (const frame of splitStreamMessage(state.stream, kind, payload))
        runner.send(frame);
    } catch {
      socket.close(1012, "The runner disconnected.");
    }
  }

  /** A data message from the runner, for one viewer. */
  #fromRunnerData(message: ArrayBuffer) {
    const frame = decodeStreamFrame(message);
    if (frame === undefined) return;
    const viewers = this.ctx.getWebSockets(desktopTag(frame.stream));
    if (viewers.length === 0) {
      this.#fromRunner.delete(frame.stream);
      // Nobody watches this stream any more: tell the runner to end it.
      if ((frame.kind & ~STREAM_MORE) !== STREAM_KIND_CLOSE)
        this.#sendClose(frame.stream, 1001, "The viewer left.");
      return;
    }
    let joiner = this.#fromRunner.get(frame.stream);
    if (joiner === undefined) {
      joiner = new StreamMessageJoiner();
      this.#fromRunner.set(frame.stream, joiner);
    }
    const joined = joiner.accept(frame.kind, frame.payload);
    if (joined === undefined) return;
    if (joined === null) {
      this.#fromRunner.delete(frame.stream);
      this.#sendClose(frame.stream, 1009, "Desktop message too large.");
      for (const viewer of viewers) viewer.close(1009, "Message too large.");
      return;
    }
    if (joined.kind === STREAM_KIND_CLOSE) {
      this.#fromRunner.delete(frame.stream);
      const view = new DataView(
        joined.payload.buffer,
        joined.payload.byteOffset,
        joined.payload.byteLength,
      );
      const code =
        joined.payload.byteLength >= 2 ? view.getUint16(0) : undefined;
      const reason = new TextDecoder().decode(joined.payload.subarray(2));
      for (const viewer of viewers)
        try {
          viewer.close(browserCloseCode(code), reason);
        } catch {
          // Already closing.
        }
      return;
    }
    const data =
      joined.kind === STREAM_KIND_TEXT
        ? new TextDecoder().decode(joined.payload)
        : joined.payload;
    for (const viewer of viewers)
      try {
        viewer.send(data);
      } catch {
        // The viewer is closing; its close event ends the stream.
      }
  }

  #sendClose(stream: number, code: number, reason: string) {
    const runner = this.#socket();
    if (runner === undefined) return;
    try {
      for (const frame of splitStreamMessage(
        stream,
        STREAM_KIND_CLOSE,
        streamClosePayload(code, reason),
      ))
        runner.send(frame);
    } catch {
      // The runner went away; its streams ended with it.
    }
  }

  #lastHeard(socket: WebSocket): number {
    const state = socket.deserializeAttachment() as SocketState | null;
    const pinged =
      this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
    return Math.max(pinged, state?.connectedAt ?? 0, this.#seenWrittenAt);
  }

  async #awaitSocket(): Promise<WebSocket | undefined> {
    const deadline = Date.now() + RECONNECT_WAIT_MS;
    for (;;) {
      const socket = this.#socket();
      if (socket !== undefined || Date.now() >= deadline) return socket;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async #hello(
    socket: WebSocket,
    state: SocketState,
    frame: Record<string, unknown>,
  ) {
    const os =
      frame.os === "macos" || frame.os === "linux" ? frame.os : undefined;
    const arch =
      typeof frame.arch === "string" && /^[a-z0-9_]{1,32}$/.test(frame.arch)
        ? frame.arch
        : undefined;
    const version =
      typeof frame.version === "string" &&
      /^[0-9A-Za-z.+-]{1,32}$/.test(frame.version)
        ? frame.version
        : undefined;
    const next: SocketState = {
      ...state,
      ...(os === undefined ? {} : { os }),
      ...(arch === undefined ? {} : { arch }),
      ...(version === undefined ? {} : { version }),
      ...(typeof frame.sandbox === "string"
        ? { sandbox: frame.sandbox.slice(0, 32) }
        : {}),
      ...(Array.isArray(frame.missing)
        ? {
            missing: frame.missing
              .filter(
                (tool): tool is string =>
                  typeof tool === "string" && /^[a-z0-9-]{1,32}$/.test(tool),
              )
              .slice(0, 8),
          }
        : {}),
    };
    socket.serializeAttachment(next);
    await this.#recordSeen(next, true);
    const sha256 =
      typeof frame.sha256 === "string" && /^[0-9a-f]{64}$/.test(frame.sha256)
        ? frame.sha256
        : undefined;
    const update =
      os === undefined || arch === undefined
        ? undefined
        : await this.#updateOffer(next.origin, `${os}-${arch}`, {
            version,
            sha256,
          });
    socket.send(
      JSON.stringify({
        type: "hello",
        ...(update === undefined ? {} : { update }),
      }),
    );
  }

  /**
   * The deployment's runner build, when it differs from the runner's: by
   * the running binary's SHA-256 when the runner reports it (a branch
   * preview rebuilds without a version change), else by version.
   */
  async #updateOffer(
    origin: string,
    platform: string,
    running: { readonly version?: string; readonly sha256?: string },
  ) {
    const assets = this.env.ASSETS;
    if (assets === undefined) return undefined;
    try {
      const response = await assets.fetch(
        new URL("/runner/manifest.json", origin),
      );
      if (!response.ok) return undefined;
      const manifest = (await response.json()) as {
        readonly version?: unknown;
        readonly assets?: Record<
          string,
          { readonly path?: unknown; readonly sha256?: unknown }
        >;
      };
      if (typeof manifest.version !== "string" || manifest.assets === undefined)
        return undefined;
      const own = manifest.assets[platform];
      const current =
        running.sha256 === undefined
          ? manifest.version === running.version
          : own?.sha256 === running.sha256;
      if (current) return undefined;
      const offered: Record<string, { url: string; sha256: string }> = {};
      for (const [key, asset] of Object.entries(manifest.assets))
        if (
          SUPPORTED_ASSETS.has(key) &&
          typeof asset.path === "string" &&
          asset.path.startsWith("/runner/") &&
          typeof asset.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(asset.sha256)
        )
          offered[key] = {
            url: new URL(asset.path, origin).toString(),
            sha256: asset.sha256,
          };
      return { version: manifest.version, assets: offered };
    } catch {
      return undefined;
    }
  }

  #reply(frame: Record<string, unknown>) {
    if (typeof frame.id !== "string") return;
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok === true) {
      pending.resolve(frame.result ?? {});
      return;
    }
    const error = (frame.error ?? {}) as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    pending.reject(
      RunnerOperationError.from(
        `runner:${typeof error.code === "string" ? error.code : "failed"}:${
          typeof error.message === "string"
            ? error.message.slice(0, 2000)
            : "The runner could not finish the operation."
        }`,
      ),
    );
  }

  async #disconnected(socket: WebSocket, code: number, reason: string) {
    const attachment = socket.deserializeAttachment() as unknown;
    if (isDesktopSocket(attachment)) {
      // The viewer left: end its stream to voxl.
      this.#fromRunner.delete(attachment.stream);
      this.#sendClose(
        attachment.stream,
        code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000,
        reason,
      );
      return;
    }
    const state = attachment as SocketState | null;
    if (this.#runnerSockets().some((open) => open !== socket)) return;
    for (const viewer of this.ctx.getWebSockets("desktop"))
      try {
        viewer.close(1012, "The runner disconnected.");
      } catch {
        // Already closing.
      }
    this.#fromRunner.clear();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new RunnerOperationError("offline", "The runner disconnected."),
      );
      this.#pending.delete(id);
    }
    if (state !== null) await this.#recordSeen(state, true);
  }

  async #recordSeen(state: SocketState, force: boolean) {
    const now = Date.now();
    if (!force && now - this.#seenWrittenAt < SEEN_WRITE_MS) return;
    this.#seenWrittenAt = now;
    const db = this.env.DB;
    if (db === undefined) return;
    try {
      await recordMachineSeen(db, state.machineId, {
        at: now,
        ...(state.version === undefined ? {} : { version: state.version }),
        ...(state.os === undefined ? {} : { os: state.os }),
        ...(state.arch === undefined ? {} : { arch: state.arch }),
      });
    } catch (cause) {
      logger.warn("Runner last-seen write failed.", {
        event: "runner_seen_write_failed",
        machineId: state.machineId,
        errorName: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
  }
}

/** Paths Core names for archive transfers, on the runner's own origin. */
const withAbsoluteUrls = (
  body: Record<string, unknown>,
  origin: string,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...body };
  if (typeof body.uploadPath === "string") {
    next.uploadUrl = new URL(body.uploadPath, origin).toString();
    delete next.uploadPath;
  }
  const restore = body.restore as { readonly path?: unknown } | undefined;
  if (restore !== undefined && typeof restore.path === "string")
    next.restore = { url: new URL(restore.path, origin).toString() };
  return next;
};
