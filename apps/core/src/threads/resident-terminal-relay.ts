import {
  THREAD_TERMINAL_ATTACHMENT_LIMIT,
  THREAD_TERMINAL_BINARY_MAX_BYTES,
  THREAD_TERMINAL_CONTROL_MAX_BYTES,
  ThreadTerminalBrowserControlSchema,
  type ThreadTerminalDimensions,
  type ThreadTerminalErrorCode,
  type ThreadTerminalServerPhase,
} from "@dx/api";
import { Option, Schema } from "effect";
import {
  type DxdClientTerminalControl,
  type DxdCoreTerminalControl,
  type DxdTerminalHeartbeat,
  DxdU64,
  decodeDxdTerminalFrame,
  encodeDxdTerminalFrame,
  TerminalGeneration,
  type TerminalGeneration as TerminalGenerationType,
} from "../execution/dxd/protocol.js";

type ResidentTerminalEvent = { readonly data?: unknown };

export interface ResidentTerminalSocket {
  readonly bufferedAmount?: number;
  readonly send: (value: string | ArrayBuffer | ArrayBufferView) => void;
  readonly close: (code: number, reason: string) => void;
  readonly addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: ResidentTerminalEvent) => void,
  ) => void;
}

const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_BROWSER_QUEUE_BYTES = 256 * 1_024;
const MAX_BROWSER_OUTPUT_QUEUE_BYTES = 256 * 1_024;

type ResidentPhase =
  | "starting"
  | "waiting"
  | "opening"
  | "attaching"
  | "replaying"
  | "ready";

export interface ResidentTerminalMetadata {
  readonly version: 1;
  readonly phase: ResidentPhase;
  readonly dimensions: ThreadTerminalDimensions;
  readonly requested: boolean;
  readonly restartResident: boolean;
  readonly restartRequired: boolean;
  readonly residentGeneration?: TerminalGenerationType;
  readonly attachmentGeneration?: TerminalGenerationType;
  readonly replayBytes?: number;
  readonly replayTruncated?: boolean;
  readonly replayReceived: number;
  readonly expectedOutputSequence?: string;
  readonly replayThrough?: string;
  readonly nextInputSequence: string;
  readonly nextResizeOrdinal: string;
}

interface ResidentSession {
  readonly socket: ResidentTerminalSocket;
  readonly transport: ResidentTerminalTransport;
  phase: ResidentPhase;
  dimensions: ThreadTerminalDimensions;
  requested: boolean;
  restartResident: boolean;
  restartRequired: boolean;
  residentGeneration?: TerminalGenerationType;
  attachmentGeneration?: TerminalGenerationType;
  replayBytes?: number;
  replayTruncated?: boolean;
  replayReceived: number;
  expectedOutputSequence?: bigint;
  replayThrough?: bigint;
  pendingBrowserBytes: number;
  activation?: Promise<void>;
  disposed: boolean;
}

export interface ResidentTerminalTransport {
  readonly activate: () => Promise<DxdTerminalHeartbeat>;
  readonly refreshEnvironment: () => Promise<DxdTerminalHeartbeat>;
  readonly sendControl: (control: DxdCoreTerminalControl) => void;
  readonly sendBinary: (frame: Uint8Array) => void;
  readonly canSendBinary?: (frameBytes: number) => boolean;
  readonly beforeInput?: () => Promise<void>;
  readonly persist?: (metadata: ResidentTerminalMetadata) => void;
  readonly record: (phase: ThreadTerminalServerPhase) => void;
}

const generation = () => {
  let bytes: Uint8Array;
  do bytes = crypto.getRandomValues(new Uint8Array(16));
  while (bytes.every((byte) => byte === 0));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Schema.decodeUnknownSync(TerminalGeneration)(
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
  );
};

const dxdU64 = (value: bigint) =>
  Schema.decodeUnknownSync(DxdU64)(value.toString());

const advance = (value: bigint) => {
  if (value >= MAX_U64) throw new Error("Terminal ordinal exhausted.");
  return value + 1n;
};

const metadataU64 = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > MAX_U64
  )
    return undefined;
  return BigInt(value);
};

const decodeMetadata = (
  value: unknown,
): ResidentTerminalMetadata | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const metadata = value as Partial<ResidentTerminalMetadata>;
  const allowed = new Set([
    "version",
    "phase",
    "dimensions",
    "requested",
    "restartResident",
    "restartRequired",
    "residentGeneration",
    "attachmentGeneration",
    "replayBytes",
    "replayTruncated",
    "replayReceived",
    "expectedOutputSequence",
    "replayThrough",
    "nextInputSequence",
    "nextResizeOrdinal",
  ]);
  if (
    Object.keys(metadata).some((key) => !allowed.has(key)) ||
    metadata.version !== 1 ||
    ![
      "starting",
      "waiting",
      "opening",
      "attaching",
      "replaying",
      "ready",
    ].includes(metadata.phase ?? "") ||
    typeof metadata.requested !== "boolean" ||
    typeof metadata.restartResident !== "boolean" ||
    typeof metadata.restartRequired !== "boolean" ||
    typeof metadata.replayReceived !== "number" ||
    !Number.isInteger(metadata.replayReceived) ||
    metadata.replayReceived < 0 ||
    metadataU64(metadata.nextInputSequence) === undefined ||
    metadataU64(metadata.nextResizeOrdinal) === undefined ||
    typeof metadata.dimensions !== "object" ||
    metadata.dimensions === null ||
    !Number.isInteger(metadata.dimensions.columns) ||
    !Number.isInteger(metadata.dimensions.rows) ||
    metadata.dimensions.columns < 1 ||
    metadata.dimensions.columns > 1_000 ||
    metadata.dimensions.rows < 1 ||
    metadata.dimensions.rows > 1_000
  )
    return undefined;
  for (const candidate of [
    metadata.residentGeneration,
    metadata.attachmentGeneration,
  ])
    if (
      candidate !== undefined &&
      Option.isNone(Schema.decodeUnknownOption(TerminalGeneration)(candidate))
    )
      return undefined;
  if (
    (metadata.expectedOutputSequence !== undefined &&
      metadataU64(metadata.expectedOutputSequence) === undefined) ||
    (metadata.replayThrough !== undefined &&
      metadataU64(metadata.replayThrough) === undefined) ||
    (metadata.replayBytes !== undefined &&
      (!Number.isInteger(metadata.replayBytes) ||
        metadata.replayBytes < 1 ||
        metadata.replayBytes > 65_536)) ||
    (metadata.replayTruncated !== undefined &&
      typeof metadata.replayTruncated !== "boolean")
  )
    return undefined;
  const attached =
    metadata.residentGeneration !== undefined &&
    metadata.attachmentGeneration !== undefined;
  if (
    (!metadata.requested && metadata.phase !== "starting") ||
    (["attaching", "replaying", "ready"].includes(metadata.phase ?? "") &&
      !attached) ||
    (metadata.phase === "replaying" &&
      (metadata.replayBytes === undefined ||
        metadata.replayThrough === undefined ||
        metadata.expectedOutputSequence === undefined ||
        metadata.replayReceived > metadata.replayBytes)) ||
    (metadata.phase === "ready" &&
      metadata.expectedOutputSequence === undefined)
  )
    return undefined;
  return metadata as ResidentTerminalMetadata;
};

const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

const sendSafely = (
  socket: ResidentTerminalSocket,
  value: string | ArrayBuffer | ArrayBufferView,
) => {
  try {
    socket.send(value);
    return true;
  } catch {
    return false;
  }
};

const closeSafely = (socket: ResidentTerminalSocket, code: number) => {
  try {
    socket.close(code, "");
  } catch {
    // The peer may already have disconnected.
  }
};

export class ResidentTerminalRelay {
  readonly #sessions = new Map<ResidentTerminalSocket, ResidentSession>();
  #nextInputSequence = 1n;
  #nextResizeOrdinal = 1n;
  #residentGeneration?: TerminalGenerationType;
  #browserOperations = Promise.resolve();
  #residentOpenDispatched = false;

  attach(
    socket: ResidentTerminalSocket,
    transport: ResidentTerminalTransport,
    listen = true,
  ) {
    if (this.#sessions.size >= THREAD_TERMINAL_ATTACHMENT_LIMIT) {
      this.#sendError(socket, "attachment-limit", "manual", 1013);
      return;
    }
    const session: ResidentSession = {
      socket,
      transport,
      phase: "starting",
      dimensions: { columns: 80, rows: 20 },
      requested: false,
      restartResident: false,
      restartRequired: false,
      replayReceived: 0,
      pendingBrowserBytes: 0,
      disposed: false,
    };
    this.#sessions.set(socket, session);
    if (listen) {
      socket.addEventListener("close", () => this.#dispose(session, true));
      socket.addEventListener("error", () => this.#dispose(session, true));
      socket.addEventListener("message", (event) =>
        this.receiveBrowser(socket, event.data),
      );
    }
    this.#persist(session);
    if (
      !this.#sendControl(session, { v: 1, type: "progress", phase: "starting" })
    )
      this.#dispose(session, false);
  }

  receiveBrowser(socket: ResidentTerminalSocket, data: unknown) {
    const session = this.#sessions.get(socket);
    if (session === undefined || session.disposed) return;
    if (!session.requested) {
      if (typeof data !== "string") {
        this.#invalid(session);
        return;
      }
      const control = this.#decodeControl(session, data);
      if (control?.type !== "attach") {
        if (control !== undefined) this.#invalid(session);
        return;
      }
      session.requested = true;
      session.restartResident = control.restartResident === true;
      session.dimensions = control.dimensions;
      this.#persist(session);
      void this.#start(session);
      return;
    }
    if (session.phase !== "ready") {
      if (typeof data !== "string") {
        // The browser accepted this input before it observed the recovery phase.
        // Close so the loss is visible and reconnect; never replay uncertain input.
        this.#dispose(session, true);
        closeSafely(session.socket, 1012);
        return;
      }
      const control = this.#decodeControl(session, data);
      if (control?.type === "resize") {
        session.dimensions = control.dimensions;
        this.#persist(session);
      } else if (control?.type === "detach") {
        this.#dispose(session, true);
        closeSafely(session.socket, 1000);
      } else if (control !== undefined) this.#invalid(session);
      return;
    }
    return this.#enqueueReadyFrame(session, data);
  }

  daemonConnectionReset() {
    this.#residentOpenDispatched = false;
    for (const session of this.#sessions.values()) {
      if (!session.requested) continue;
      session.phase = "waiting";
      session.attachmentGeneration = undefined;
      session.expectedOutputSequence = undefined;
      session.replayThrough = undefined;
      session.replayBytes = undefined;
      session.replayReceived = 0;
      this.#sendControl(session, {
        v: 1,
        type: "progress",
        phase: "resident-restarting",
      });
      this.#persist(session);
    }
  }

  attachmentsReset() {
    this.#nextInputSequence = 1n;
    this.#nextResizeOrdinal = 1n;
    this.#persistAll();
    for (const session of this.#sessions.values())
      if (session.requested && !session.disposed) void this.#start(session);
  }

  daemonUnavailable() {
    this.daemonConnectionReset();
  }

  daemonHeartbeat() {
    for (const session of this.#sessions.values())
      if (session.phase === "ready" && !session.disposed)
        this.#sendControl(session, { v: 1, type: "heartbeat" });
  }

  workspaceWaking() {
    for (const session of this.#sessions.values()) {
      if (!session.requested || session.disposed) continue;
      this.#sendControl(session, {
        v: 1,
        type: "progress",
        phase: "waking",
      });
    }
  }

  environmentRestartRequired() {
    for (const session of this.#sessions.values()) {
      if (!session.requested || session.disposed || session.restartRequired)
        continue;
      session.restartRequired = true;
      if (session.phase === "ready")
        this.#sendControl(session, {
          v: 1,
          type: "restart-required",
          restartRequired: true,
        });
      this.#persist(session);
    }
  }

  close(code: ThreadTerminalErrorCode, retry: Retry, closeCode: number) {
    for (const session of [...this.#sessions.values()])
      this.#fail(session, code, retry, closeCode, false);
  }

  closeForLifecycle(
    code: ThreadTerminalErrorCode,
    retry: Retry,
    closeCode: number,
  ) {
    for (const session of [...this.#sessions.values()]) {
      if (!this.#current(session)) continue;
      this.#sendError(session.socket, code, retry, closeCode);
      this.#dispose(session, "lifecycle");
    }
  }

  disconnect(socket: ResidentTerminalSocket) {
    const session = this.#sessions.get(socket);
    if (session !== undefined) this.#dispose(session, true);
  }

  restore(
    socket: ResidentTerminalSocket,
    source: unknown,
    transport: ResidentTerminalTransport,
  ) {
    const metadata = decodeMetadata(source);
    if (
      metadata === undefined ||
      this.#sessions.size >= THREAD_TERMINAL_ATTACHMENT_LIMIT
    )
      return false;
    const nextInputSequence = metadataU64(metadata.nextInputSequence);
    const nextResizeOrdinal = metadataU64(metadata.nextResizeOrdinal);
    if (nextInputSequence === undefined || nextResizeOrdinal === undefined)
      return false;
    if (this.#sessions.size > 0) {
      if (
        this.#nextInputSequence !== nextInputSequence ||
        this.#nextResizeOrdinal !== nextResizeOrdinal
      )
        return false;
    } else {
      this.#nextInputSequence = nextInputSequence;
      this.#nextResizeOrdinal = nextResizeOrdinal;
      this.#residentGeneration = metadata.residentGeneration;
    }
    const session: ResidentSession = {
      socket,
      transport,
      phase: metadata.phase,
      dimensions: metadata.dimensions,
      requested: metadata.requested,
      restartResident: metadata.restartResident,
      restartRequired: metadata.restartRequired,
      residentGeneration: metadata.residentGeneration,
      attachmentGeneration: metadata.attachmentGeneration,
      replayBytes: metadata.replayBytes,
      replayTruncated: metadata.replayTruncated,
      replayReceived: metadata.replayReceived,
      expectedOutputSequence:
        metadata.expectedOutputSequence === undefined
          ? undefined
          : BigInt(metadata.expectedOutputSequence),
      replayThrough:
        metadata.replayThrough === undefined
          ? undefined
          : BigInt(metadata.replayThrough),
      pendingBrowserBytes: 0,
      disposed: false,
    };
    this.#sessions.set(socket, session);
    this.#persist(session);
    if (session.requested && ["starting", "waiting"].includes(session.phase))
      void this.#start(session);
    return true;
  }

  receiveControl(control: DxdClientTerminalControl) {
    if (control.type === "terminal.resident-state") {
      if (control.state !== "starting") this.#residentOpenDispatched = false;
      if (control.state === "ready")
        this.#resetSequencesForResidentRotation(control.residentGeneration);
      for (const session of [...this.#sessions.values()]) {
        if (
          session.phase === "ready" &&
          session.residentGeneration === control.residentGeneration &&
          control.state === "ready"
        ) {
          if (control.restartRequired && !session.restartRequired) {
            session.restartRequired = true;
            this.#sendControl(session, {
              v: 1,
              type: "restart-required",
              restartRequired: true,
            });
            this.#persist(session);
          }
          continue;
        }
        if (session.phase !== "opening") continue;
        if (control.state === "starting") continue;
        if (control.state === "ready") {
          session.residentGeneration = control.residentGeneration;
          session.restartResident = false;
          session.restartRequired = control.restartRequired;
          session.transport.record("resident_ready");
          this.#dispatchAttach(session);
        } else if (control.state === "exited")
          this.#fail(session, "terminal-exited", "manual", 1000, false);
        else this.#fail(session, "resident-unavailable", "manual", 1012, false);
      }
      return;
    }
    if (control.type === "terminal.dimensions") {
      for (const session of [...this.#sessions.values()]) {
        if (
          session.phase !== "ready" ||
          session.residentGeneration !== control.residentGeneration
        )
          continue;
        session.dimensions = control.dimensions;
        if (
          !this.#sendControl(session, {
            v: 1,
            type: "dimensions",
            dimensions: control.dimensions,
          })
        )
          this.#fail(session, "resident-unavailable", "manual", 1011, true);
        else this.#persist(session);
      }
      return;
    }
    const targets = [...this.#sessions.values()].filter(
      (session) =>
        session.residentGeneration === control.residentGeneration &&
        ("attachmentGeneration" in control
          ? control.attachmentGeneration === session.attachmentGeneration
          : true),
    );
    for (const session of targets)
      this.#receiveTargetedControl(session, control);
  }

  receiveBinary(source: ArrayBuffer | ArrayBufferView) {
    const frame = decodeDxdTerminalFrame(source);
    if (frame.kind === 1) throw new Error("dxd sent an input frame");
    if (frame.kind === 2) {
      const session = [...this.#sessions.values()].find(
        (candidate) =>
          candidate.residentGeneration === frame.residentGeneration &&
          candidate.attachmentGeneration === frame.attachmentGeneration,
      );
      if (session === undefined || session.phase !== "replaying") return;
      this.#deliverOutput(session, frame.sequence, frame.payload, true);
      return;
    }
    for (const session of [...this.#sessions.values()]) {
      if (
        session.residentGeneration !== frame.residentGeneration ||
        session.phase !== "ready"
      )
        continue;
      this.#deliverOutput(session, frame.sequence, frame.payload, false);
    }
  }

  async #start(session: ResidentSession) {
    if (session.activation !== undefined) return session.activation;
    const activation = this.#browserOperations
      .then(() => this.#runStart(session))
      .finally(() => {
        if (session.activation === activation) session.activation = undefined;
      });
    session.activation = activation;
    this.#browserOperations = activation.catch(() => undefined);
    return activation;
  }

  async #runStart(session: ResidentSession) {
    if (!this.#current(session)) return;
    let state: DxdTerminalHeartbeat;
    try {
      state = await session.transport.activate();
    } catch {
      if (this.#current(session))
        this.close("resident-unavailable", "immediate-once", 1012);
      return;
    }
    try {
      if (!this.#current(session)) return;
      session.transport.record("daemon_ready");
      if (state.state === "absent") {
        session.phase = "opening";
        if (!this.#residentOpenDispatched) {
          this.#residentOpenDispatched = true;
          this.#dispatch(session, {
            terminalVersion: 1,
            type: "terminal.open",
            terminal: "default",
            mode: "open-if-absent",
            dimensions: session.dimensions,
          });
          session.transport.record("resident_open_dispatched");
        }
        this.#persist(session);
      } else if (state.state === "ready") {
        this.#resetSequencesForResidentRotation(state.residentGeneration);
        session.residentGeneration = state.residentGeneration;
        session.restartRequired = state.restartRequired;
        session.transport.record("resident_ready");
        this.#dispatchAttach(session);
      } else if (
        (state.state === "exited" || state.state === "failed") &&
        session.restartResident
      ) {
        session.phase = "opening";
        session.residentGeneration = state.residentGeneration;
        session.restartResident = false;
        this.#persist(session);
        if (!this.#residentOpenDispatched) {
          this.#residentOpenDispatched = true;
          this.#dispatch(session, {
            terminalVersion: 1,
            type: "terminal.open",
            terminal: "default",
            mode: "restart-exited",
            expectedResidentGeneration: state.residentGeneration,
            dimensions: session.dimensions,
          });
          session.transport.record("resident_open_dispatched");
        }
        this.#persist(session);
      } else if (state.state === "starting") {
        session.phase = "opening";
        this.#persist(session);
      } else if (state.state === "exited")
        this.#fail(session, "terminal-exited", "manual", 1000, false);
      else this.#fail(session, "resident-unavailable", "manual", 1012, false);
    } catch {
      if (this.#current(session))
        this.close("resident-unavailable", "manual", 1012);
    }
  }

  #resetSequencesForResidentRotation(
    residentGeneration: TerminalGenerationType,
  ) {
    const knownGenerations = [...this.#sessions.values()].flatMap((session) =>
      session.residentGeneration === undefined
        ? []
        : [session.residentGeneration],
    );
    if (knownGenerations.includes(residentGeneration)) {
      this.#residentGeneration = residentGeneration;
      return;
    }
    const previousGeneration =
      this.#residentGeneration ?? knownGenerations.at(0);
    this.#residentGeneration = residentGeneration;
    if (
      previousGeneration !== undefined &&
      previousGeneration !== residentGeneration
    ) {
      this.#nextInputSequence = 1n;
      this.#nextResizeOrdinal = 1n;
      this.#persistAll();
    }
  }

  #dispatchAttach(session: ResidentSession) {
    const residentGeneration = session.residentGeneration;
    if (residentGeneration === undefined || !this.#current(session)) return;
    const attachmentGeneration = generation();
    const resizeOrdinal = this.#nextResizeOrdinal;
    this.#nextResizeOrdinal = advance(resizeOrdinal);
    session.attachmentGeneration = attachmentGeneration;
    session.phase = "attaching";
    this.#dispatch(session, {
      terminalVersion: 1,
      type: "terminal.attach",
      terminal: "default",
      residentGeneration,
      attachmentGeneration,
      resizeOrdinal: dxdU64(resizeOrdinal),
      dimensions: session.dimensions,
    });
    session.transport.record("resident_attach_dispatched");
    this.#persistAll();
  }

  #receiveTargetedControl(
    session: ResidentSession,
    control: Exclude<
      DxdClientTerminalControl,
      { readonly type: "terminal.resident-state" | "terminal.dimensions" }
    >,
  ) {
    if (control.type === "terminal.replay-start") {
      if (session.phase !== "attaching") return;
      const first = BigInt(control.firstOutputSequence);
      const through = BigInt(control.throughOutputSequence);
      if (first < 1n || through < first) {
        this.#fail(session, "reconnect-required", "immediate-once", 1012, true);
        return;
      }
      session.phase = "replaying";
      session.replayBytes = control.replayBytes;
      session.replayTruncated = control.truncated;
      session.replayReceived = 0;
      session.expectedOutputSequence = first;
      session.replayThrough = through;
      session.transport.record("resident_replay_started");
      this.#persist(session);
      if (
        !this.#sendControl(session, {
          v: 1,
          type: "replay-start",
          reset: true,
          truncated: control.truncated,
        })
      )
        this.#fail(session, "resident-unavailable", "manual", 1011, true);
      return;
    }
    if (control.type === "terminal.attachment-ready") {
      const through = BigInt(control.throughOutputSequence);
      if (
        session.phase !== "replaying" ||
        session.replayBytes === undefined ||
        session.replayReceived !== session.replayBytes ||
        session.replayThrough !== through ||
        session.expectedOutputSequence !== advance(through)
      ) {
        this.#fail(session, "reconnect-required", "immediate-once", 1012, true);
        return;
      }
      session.phase = "ready";
      session.dimensions = control.dimensions;
      session.transport.record("resident_attachment_ready");
      session.transport.record("terminal_ready");
      if (
        !this.#sendControl(session, {
          v: 1,
          type: "ready",
          terminal: "default",
          dimensions: control.dimensions,
          replayBytes: session.replayBytes,
          replayTruncated: session.replayTruncated ?? false,
          restartRequired: session.restartRequired,
        })
      )
        this.#fail(session, "resident-unavailable", "manual", 1011, true);
      else this.#persist(session);
      return;
    }
    if (control.type === "terminal.detached") {
      closeSafely(session.socket, 1000);
      this.#dispose(session, false);
      return;
    }
    if (control.type === "terminal.error")
      this.#dxdError(session, control.code);
  }

  #deliverOutput(
    session: ResidentSession,
    encodedSequence: string,
    payload: Uint8Array,
    replay: boolean,
  ) {
    const sequence = BigInt(encodedSequence);
    if (session.expectedOutputSequence !== sequence) {
      this.#fail(session, "reconnect-required", "immediate-once", 1012, true);
      return;
    }
    session.expectedOutputSequence = advance(sequence);
    if (replay) {
      session.replayReceived += payload.byteLength;
      if (
        session.replayBytes === undefined ||
        session.replayReceived > session.replayBytes ||
        (session.replayThrough !== undefined &&
          sequence > session.replayThrough)
      ) {
        this.#fail(session, "reconnect-required", "immediate-once", 1012, true);
        return;
      }
    }
    if (
      payload.byteLength > THREAD_TERMINAL_BINARY_MAX_BYTES ||
      (session.socket.bufferedAmount ?? 0) + payload.byteLength >
        MAX_BROWSER_OUTPUT_QUEUE_BYTES ||
      !sendSafely(session.socket, payload)
    )
      this.#fail(session, "slow-consumer", "manual", 1013, "slow-consumer");
    else this.#persist(session);
  }

  #enqueueReadyFrame(session: ResidentSession, data: unknown) {
    const size =
      typeof data === "string"
        ? byteLength(data)
        : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? data.byteLength
          : data instanceof Blob
            ? data.size
            : undefined;
    if (size === undefined || size < 1) {
      this.#invalid(session);
      return;
    }
    if (
      (typeof data === "string" && size > THREAD_TERMINAL_CONTROL_MAX_BYTES) ||
      (typeof data !== "string" && size > THREAD_TERMINAL_BINARY_MAX_BYTES)
    ) {
      this.#tooLarge(session);
      return;
    }
    if (session.pendingBrowserBytes + size > MAX_BROWSER_QUEUE_BYTES) {
      this.#fail(session, "input-overflow", "manual", 1013, true);
      return;
    }
    session.pendingBrowserBytes += size;
    this.#browserOperations = this.#browserOperations
      .then(async () => {
        if (!this.#current(session) || session.phase !== "ready") return;
        if (typeof data === "string") {
          const control = this.#decodeControl(session, data);
          if (control?.type === "resize")
            this.#dispatchResize(session, control.dimensions);
          else if (control?.type === "restart")
            await this.#refreshEnvironment(session);
          else if (control?.type === "detach") {
            this.#dispose(session, true);
            closeSafely(session.socket, 1000);
          } else if (control !== undefined) this.#invalid(session);
          return;
        }
        let payload: Uint8Array;
        if (data instanceof ArrayBuffer) payload = new Uint8Array(data);
        else if (ArrayBuffer.isView(data))
          payload = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
        else if (data instanceof Blob)
          payload = new Uint8Array(await data.arrayBuffer());
        else return;
        await session.transport.beforeInput?.();
        if (!this.#current(session) || session.phase !== "ready") return;
        this.#dispatchInput(session, payload);
      })
      .catch(() => {
        if (
          this.#current(session) &&
          session.phase !== "waiting" &&
          session.phase !== "starting"
        )
          this.#fail(session, "resident-unavailable", "manual", 1012, false);
      })
      .finally(() => {
        session.pendingBrowserBytes -= size;
        if (this.#current(session)) this.#persist(session);
      });
    return this.#browserOperations;
  }

  #dispatchResize(
    session: ResidentSession,
    dimensions: ThreadTerminalDimensions,
  ) {
    const residentGeneration = session.residentGeneration;
    const attachmentGeneration = session.attachmentGeneration;
    if (residentGeneration === undefined || attachmentGeneration === undefined)
      return;
    const resizeOrdinal = this.#nextResizeOrdinal;
    this.#nextResizeOrdinal = advance(resizeOrdinal);
    session.dimensions = dimensions;
    this.#dispatch(session, {
      terminalVersion: 1,
      type: "terminal.resize",
      terminal: "default",
      residentGeneration,
      attachmentGeneration,
      resizeOrdinal: dxdU64(resizeOrdinal),
      dimensions,
    });
    this.#persistAll();
  }

  async #refreshEnvironment(session: ResidentSession) {
    const expectedResidentGeneration = session.residentGeneration;
    if (
      expectedResidentGeneration === undefined ||
      !this.#current(session) ||
      session.phase !== "ready"
    ) {
      this.#invalid(session);
      return;
    }
    let current: DxdTerminalHeartbeat;
    try {
      current = await session.transport.refreshEnvironment();
    } catch {
      if (!this.#current(session) || session.phase !== "ready") return;
      this.close("environment-unavailable", "manual", 1012);
      return;
    }
    if (!this.#current(session) || session.phase !== "ready") return;
    if (
      current.state !== "ready" ||
      current.residentGeneration !== expectedResidentGeneration
    ) {
      this.#fail(session, "reconnect-required", "immediate-once", 1012, false);
      return;
    }
    if (!current.restartRequired) {
      session.restartRequired = false;
      this.#persist(session);
      return;
    }
    for (const candidate of this.#sessions.values()) {
      if (
        !candidate.requested ||
        candidate.disposed ||
        candidate.residentGeneration !== expectedResidentGeneration
      )
        continue;
      candidate.phase = "opening";
      candidate.restartRequired = false;
      candidate.attachmentGeneration = undefined;
      candidate.expectedOutputSequence = undefined;
      candidate.replayThrough = undefined;
      candidate.replayBytes = undefined;
      candidate.replayReceived = 0;
      this.#sendControl(candidate, {
        v: 1,
        type: "progress",
        phase: "resident-restarting",
      });
      this.#persist(candidate);
    }
    if (this.#residentOpenDispatched) return;
    this.#residentOpenDispatched = true;
    this.#dispatch(session, {
      terminalVersion: 1,
      type: "terminal.restart",
      terminal: "default",
      expectedResidentGeneration,
      dimensions: session.dimensions,
    });
  }

  #dispatchInput(session: ResidentSession, payload: Uint8Array) {
    const residentGeneration = session.residentGeneration;
    const attachmentGeneration = session.attachmentGeneration;
    if (residentGeneration === undefined || attachmentGeneration === undefined)
      return;
    const sequence = this.#nextInputSequence;
    const encoded = encodeDxdTerminalFrame({
      kind: 1,
      residentGeneration,
      attachmentGeneration,
      sequence: dxdU64(sequence),
      payload,
    });
    if (session.transport.canSendBinary?.(encoded.byteLength) === false) {
      this.#fail(session, "input-overflow", "manual", 1013, true);
      return;
    }
    this.#nextInputSequence = advance(sequence);
    session.transport.sendBinary(encoded);
    this.#persistAll();
  }

  #dispatch(session: ResidentSession, control: DxdCoreTerminalControl) {
    session.transport.sendControl(control);
  }

  #decodeControl(session: ResidentSession, value: string) {
    if (byteLength(value) > THREAD_TERMINAL_CONTROL_MAX_BYTES) {
      this.#tooLarge(session);
      return;
    }
    try {
      const decoded = Schema.decodeUnknownOption(
        ThreadTerminalBrowserControlSchema,
      )(JSON.parse(value), { onExcessProperty: "error" });
      if (Option.isSome(decoded)) return decoded.value;
    } catch {
      // Invalid controls map to one fixed public error below.
    }
    this.#invalid(session);
  }

  #dxdError(
    session: ResidentSession,
    code:
      | "invalid-attachment"
      | "attachment-limit"
      | "input-overflow"
      | "terminal-exited"
      | "terminal-overflow"
      | "terminal-unavailable",
  ) {
    if (code === "invalid-attachment")
      this.#fail(session, "reconnect-required", "immediate-once", 1012, false);
    else if (code === "terminal-unavailable")
      this.#fail(session, "resident-unavailable", "manual", 1012, false);
    else
      this.#fail(
        session,
        code,
        "manual",
        code === "terminal-exited"
          ? 1000
          : code === "terminal-overflow"
            ? 1011
            : 1013,
        false,
      );
  }

  #invalid(session: ResidentSession) {
    this.#fail(session, "invalid-message", "never", 1008, true);
  }

  #tooLarge(session: ResidentSession) {
    this.#fail(session, "invalid-message", "never", 1009, true);
  }

  #fail(
    session: ResidentSession,
    code: ThreadTerminalErrorCode,
    retry: Retry,
    closeCode: number,
    detach: boolean | "slow-consumer",
  ) {
    if (!this.#current(session)) return;
    this.#sendError(session.socket, code, retry, closeCode);
    this.#dispose(session, detach);
  }

  #sendError(
    socket: ResidentTerminalSocket,
    code: ThreadTerminalErrorCode,
    retry: Retry,
    closeCode: number,
  ) {
    sendSafely(socket, JSON.stringify({ v: 1, type: "error", code, retry }));
    closeSafely(socket, closeCode);
  }

  #sendControl(session: ResidentSession, control: object) {
    return sendSafely(session.socket, JSON.stringify(control));
  }

  #persist(session: ResidentSession) {
    session.transport.persist?.({
      version: 1,
      phase: session.phase,
      dimensions: session.dimensions,
      requested: session.requested,
      restartResident: session.restartResident,
      restartRequired: session.restartRequired,
      residentGeneration: session.residentGeneration,
      attachmentGeneration: session.attachmentGeneration,
      replayBytes: session.replayBytes,
      replayTruncated: session.replayTruncated,
      replayReceived: session.replayReceived,
      expectedOutputSequence: session.expectedOutputSequence?.toString(),
      replayThrough: session.replayThrough?.toString(),
      nextInputSequence: this.#nextInputSequence.toString(),
      nextResizeOrdinal: this.#nextResizeOrdinal.toString(),
    });
  }

  #persistAll() {
    for (const session of this.#sessions.values()) this.#persist(session);
  }

  #dispose(
    session: ResidentSession,
    detach: boolean | "browser-detached" | "slow-consumer" | "lifecycle",
  ) {
    if (!this.#current(session)) return;
    session.disposed = true;
    this.#sessions.delete(session.socket);
    if (
      detach !== false &&
      session.residentGeneration !== undefined &&
      session.attachmentGeneration !== undefined
    ) {
      try {
        this.#dispatch(session, {
          terminalVersion: 1,
          type: "terminal.detach",
          terminal: "default",
          residentGeneration: session.residentGeneration,
          attachmentGeneration: session.attachmentGeneration,
          reason:
            detach === "lifecycle"
              ? "lifecycle"
              : detach === "slow-consumer"
                ? "slow-consumer"
                : "browser-detached",
        });
      } catch {
        // A detach after loss is best effort and never replays input.
      }
    }
  }

  #current(session: ResidentSession) {
    return !session.disposed && this.#sessions.get(session.socket) === session;
  }
}

type Retry =
  | "immediate-once"
  | "manual"
  | "on-focus"
  | "after-unarchive"
  | "never";
