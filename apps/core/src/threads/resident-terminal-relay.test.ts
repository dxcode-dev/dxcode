import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type DxdCoreTerminalControl,
  type DxdTerminalHeartbeat,
  DxdU64,
  decodeDxdTerminalFrame,
  encodeDxdTerminalFrame,
  TerminalGeneration,
} from "../execution/dxd/protocol.js";
import {
  type ResidentTerminalMetadata,
  ResidentTerminalRelay,
  type ResidentTerminalSocket,
  type ResidentTerminalTransport,
} from "./resident-terminal-relay.js";

class SocketFake implements ResidentTerminalSocket {
  bufferedAmount = 0;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  readonly closes: Array<[number, string]> = [];
  readonly listeners = new Map<
    string,
    Set<(event: { data?: unknown }) => void>
  >();

  send(value: string | ArrayBuffer | ArrayBufferView) {
    this.sent.push(value);
  }
  close(code: number, reason: string) {
    this.closes.push([code, reason]);
  }
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const resident = Schema.decodeUnknownSync(TerminalGeneration)(
  "AQAAAAAAAAAAAAAAAAAAAA",
);
const restartedResident = Schema.decodeUnknownSync(TerminalGeneration)(
  "AgAAAAAAAAAAAAAAAAAAAA",
);
const u64 = (value: number) => Schema.decodeUnknownSync(DxdU64)(String(value));
const attach = (columns = 80, rows = 20) =>
  JSON.stringify({
    v: 1,
    type: "attach",
    terminal: "default",
    dimensions: { columns, rows },
  });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const controlsSent = (socket: SocketFake) =>
  socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame));

const readyAttachment = async (
  relay: ResidentTerminalRelay,
  socket: SocketFake,
  fixture: ReturnType<typeof transportFixture>,
  through = 1,
) => {
  relay.attach(socket, fixture.transport);
  socket.emit("message", attach());
  await settle();
  const control = fixture.controls.at(-1);
  if (control?.type !== "terminal.attach") throw new Error("attach missing");
  relay.receiveControl({
    terminalVersion: 1,
    type: "terminal.replay-start",
    residentGeneration: resident,
    attachmentGeneration: control.attachmentGeneration,
    firstOutputSequence: u64(1),
    throughOutputSequence: u64(through),
    replayBytes: through,
    truncated: false,
  });
  for (let sequence = 1; sequence <= through; sequence += 1)
    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 2,
        residentGeneration: resident,
        attachmentGeneration: control.attachmentGeneration,
        sequence: u64(sequence),
        payload: Uint8Array.of(sequence),
      }),
    );
  relay.receiveControl({
    terminalVersion: 1,
    type: "terminal.attachment-ready",
    residentGeneration: resident,
    attachmentGeneration: control.attachmentGeneration,
    throughOutputSequence: u64(through),
    dimensionsRevision: u64(0),
    dimensions: { columns: 80, rows: 20 },
  });
  return control.attachmentGeneration;
};

const transportFixture = (
  state: DxdTerminalHeartbeat,
  attemptBinary?: (frame: Uint8Array) => void,
  persist?: (metadata: ResidentTerminalMetadata) => void,
  canSendBinary?: (frameBytes: number) => boolean,
) => {
  const controls: DxdCoreTerminalControl[] = [];
  const binary: Uint8Array[] = [];
  const phases: string[] = [];
  const transport: ResidentTerminalTransport = {
    activate: vi.fn(async () => state),
    refreshEnvironment: vi.fn(async () => state),
    sendControl: vi.fn((control) => controls.push(control)),
    sendBinary: vi.fn((frame) => {
      binary.push(frame);
      attemptBinary?.(frame);
    }),
    canSendBinary,
    persist,
    record: vi.fn((phase) => phases.push(phase)),
  };
  return { transport, controls, binary, phases };
};

describe("resident Terminal tracer relay", () => {
  it("admits eight owner attachments without replacement and admits after one closes", () => {
    const relay = new ResidentTerminalRelay();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    const admitted = Array.from({ length: 8 }, () => new SocketFake());
    for (const socket of admitted) relay.attach(socket, fixture.transport);
    const ninth = new SocketFake();
    relay.attach(ninth, fixture.transport);

    expect(admitted.every((socket) => socket.closes.length === 0)).toBe(true);
    expect(controlsSent(ninth)).toEqual([
      {
        v: 1,
        type: "error",
        code: "attachment-limit",
        retry: "manual",
      },
    ]);
    expect(ninth.closes).toEqual([[1013, ""]]);

    admitted[3]?.emit("close");
    const replacement = new SocketFake();
    relay.attach(replacement, fixture.transport);
    expect(controlsSent(replacement)).toEqual([
      { v: 1, type: "progress", phase: "starting" },
    ]);
    expect(
      admitted.filter((socket) => socket.closes.length === 0),
    ).toHaveLength(8);
  });

  it("reports when an explicit Terminal attach is waking the Orb", () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    relay.attach(socket, fixture.transport);
    socket.emit("message", attach());

    relay.workspaceWaking();

    expect(controlsSent(socket)).toContainEqual({
      v: 1,
      type: "progress",
      phase: "waking",
    });
  });

  it("targets replay, fans out equal live output, orders whole input frames, and isolates a slow tab", async () => {
    const relay = new ResidentTerminalRelay();
    const state = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    } as const;
    const first = new SocketFake();
    const second = new SocketFake();
    const firstFixture = transportFixture(state);
    const secondFixture = transportFixture(state);
    await readyAttachment(relay, first, firstFixture);
    const firstBeforeJoin = first.sent.length;
    await readyAttachment(relay, second, secondFixture);

    expect(first.sent).toHaveLength(firstBeforeJoin);
    expect(second.sent.filter((frame) => ArrayBuffer.isView(frame))).toEqual([
      Uint8Array.of(1),
    ]);

    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 3,
        residentGeneration: resident,
        sequence: u64(2),
        payload: Uint8Array.of(20),
      }),
    );
    expect(first.sent.at(-1)).toEqual(Uint8Array.of(20));
    expect(second.sent.at(-1)).toEqual(Uint8Array.of(20));

    first.emit("message", Uint8Array.of(30).buffer);
    second.emit("message", Uint8Array.of(31).buffer);
    await settle();
    const ordered = [firstFixture.binary[0], secondFixture.binary[0]].map(
      (frame) => decodeDxdTerminalFrame(frame as Uint8Array),
    );
    expect(ordered.map(({ sequence }) => sequence)).toEqual(["1", "2"]);
    expect(ordered.map(({ payload }) => payload)).toEqual([
      Uint8Array.of(30),
      Uint8Array.of(31),
    ]);

    first.bufferedAmount = 256 * 1_024;
    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 3,
        residentGeneration: resident,
        sequence: u64(3),
        payload: Uint8Array.of(21),
      }),
    );
    expect(first.closes.at(-1)).toEqual([1013, ""]);
    expect(controlsSent(first).at(-1)).toMatchObject({ code: "slow-consumer" });
    expect(firstFixture.controls.at(-1)).toMatchObject({
      type: "terminal.detach",
      reason: "slow-consumer",
    });
    expect(second.sent.at(-1)).toEqual(Uint8Array.of(21));
    expect(second.closes).toEqual([]);
  });

  it("closes an attachment when input races daemon recovery", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    relay.attach(socket, fixture.transport);
    socket.emit("message", attach());
    await settle();
    const initial = fixture.controls.at(-1);
    if (initial?.type !== "terminal.attach") throw new Error("attach missing");
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.attachment-ready",
      residentGeneration: resident,
      attachmentGeneration: initial.attachmentGeneration,
      throughOutputSequence: u64(0),
      dimensionsRevision: u64(0),
      dimensions: { columns: 80, rows: 20 },
    });
    relay.daemonConnectionReset();

    socket.emit("message", Uint8Array.of(1).buffer);
    expect(fixture.binary).toEqual([]);
    expect(socket.closes).toEqual([[1012, ""]]);
  });

  it("resets ordinals only after a daemon attachment reset", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    relay.attach(socket, fixture.transport);
    socket.emit("message", attach());
    await settle();
    const initial = fixture.controls.at(-1);
    if (initial?.type !== "terminal.attach") throw new Error("attach missing");
    expect(initial.resizeOrdinal).toBe("1");

    relay.daemonConnectionReset();
    relay.attachmentsReset();
    await settle();
    const freshAttach = fixture.controls.at(-1);
    if (freshAttach?.type !== "terminal.attach")
      throw new Error("rebind missing");
    expect(freshAttach.resizeOrdinal).toBe("1");
    expect(freshAttach.attachmentGeneration).not.toBe(
      initial.attachmentGeneration,
    );
  });

  it("resets ordinals when the resident rotates after the final attachment detaches", async () => {
    const relay = new ResidentTerminalRelay();
    const first = new SocketFake();
    const firstFixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await readyAttachment(relay, first, firstFixture);
    first.emit("message", Uint8Array.of(1).buffer);
    await settle();
    first.emit("close");

    const second = new SocketFake();
    const secondFixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: restartedResident,
      foregroundCommand: false,
      restartRequired: false,
    });
    relay.attach(second, secondFixture.transport);
    second.emit("message", attach());
    await settle();

    const freshAttach = secondFixture.controls.at(-1);
    if (freshAttach?.type !== "terminal.attach")
      throw new Error("attach missing");
    expect(freshAttach.resizeOrdinal).toBe("1");
  });

  it("checks the complete frame against the 2 MiB transport backlog before assigning its ordinal", async () => {
    const relay = new ResidentTerminalRelay();
    const state = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    } as const;
    let backlog = 2 * 1_024 * 1_024 - 51;
    const canSend = vi.fn(
      (frameBytes: number) => backlog + frameBytes <= 2 * 1_024 * 1_024,
    );
    const first = new SocketFake();
    const firstFixture = transportFixture(state, undefined, undefined, canSend);
    await readyAttachment(relay, first, firstFixture);

    first.emit("message", Uint8Array.of(1).buffer);
    await settle();
    expect(canSend).toHaveBeenLastCalledWith(51);
    expect(
      decodeDxdTerminalFrame(firstFixture.binary[0] as Uint8Array).sequence,
    ).toBe("1");

    backlog += 1;
    first.emit("message", Uint8Array.of(2).buffer);
    await settle();
    expect(firstFixture.binary).toHaveLength(1);
    expect(controlsSent(first).at(-1)).toMatchObject({
      code: "input-overflow",
      retry: "manual",
    });

    const second = new SocketFake();
    const secondFixture = transportFixture(
      state,
      undefined,
      undefined,
      () => true,
    );
    await readyAttachment(relay, second, secondFixture);
    second.emit("message", Uint8Array.of(3).buffer);
    await settle();
    expect(
      decodeDxdTerminalFrame(secondFixture.binary[0] as Uint8Array).sequence,
    ).toBe("2");
  });

  it("resumes from exact content-free hibernation metadata and rejects ambiguity", async () => {
    const persisted: ResidentTerminalMetadata[] = [];
    const state = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    } as const;
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture(state, undefined, (metadata) =>
      persisted.push(structuredClone(metadata)),
    );
    await readyAttachment(relay, socket, fixture);
    const metadata = persisted.at(-1) as ResidentTerminalMetadata;

    expect(metadata).toMatchObject({
      version: 1,
      phase: "ready",
      residentGeneration: resident,
      expectedOutputSequence: "2",
      nextInputSequence: "1",
      nextResizeOrdinal: "2",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/payload|content|command/i);
    expect(Object.keys(metadata).sort()).toEqual(
      [
        "attachmentGeneration",
        "dimensions",
        "expectedOutputSequence",
        "nextInputSequence",
        "nextResizeOrdinal",
        "phase",
        "replayBytes",
        "replayReceived",
        "replayThrough",
        "replayTruncated",
        "requested",
        "residentGeneration",
        "restartRequired",
        "restartResident",
        "version",
      ].sort(),
    );

    const restored = new ResidentTerminalRelay();
    const restoredSocket = new SocketFake();
    const restoredFixture = transportFixture(state);
    expect(
      restored.restore(restoredSocket, metadata, restoredFixture.transport),
    ).toBe(true);
    restored.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 3,
        residentGeneration: resident,
        sequence: u64(2),
        payload: Uint8Array.of(42),
      }),
    );
    expect(restoredSocket.sent).toEqual([Uint8Array.of(42)]);

    expect(
      new ResidentTerminalRelay().restore(
        new SocketFake(),
        { ...metadata, expectedOutputSequence: "03" },
        restoredFixture.transport,
      ),
    ).toBe(false);
    expect(
      new ResidentTerminalRelay().restore(
        new SocketFake(),
        { ...metadata, command: "private" },
        restoredFixture.transport,
      ),
    ).toBe(false);
    for (const dimensions of [null, "80x24"]) {
      expect(
        new ResidentTerminalRelay().restore(
          new SocketFake(),
          { ...metadata, dimensions },
          restoredFixture.transport,
        ),
      ).toBe(false);
    }
  });

  it("keeps a paused attachment open, never starts it, and reattaches it on the next registration", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    let persisted: ResidentTerminalMetadata | undefined;
    const fixture = transportFixture(
      {
        terminalVersion: 1,
        terminal: "default",
        state: "ready",
        residentGeneration: resident,
        foregroundCommand: false,
        restartRequired: false,
      },
      undefined,
      (metadata) => {
        persisted = metadata;
      },
    );
    await readyAttachment(relay, socket, fixture);
    // Hibernated before the loss was noticed: persisted as ready.
    const persistedReady = persisted;
    expect(persistedReady?.phase).toBe("ready");
    relay.daemonConnectionReset();
    relay.workspacePaused();

    expect(controlsSent(socket).slice(-2)).toEqual([
      { v: 1, type: "progress", phase: "resident-restarting" },
      { v: 1, type: "error", code: "workspace-paused", retry: "on-focus" },
    ]);
    expect(socket.closes).toEqual([]);

    // Hibernation while paused: the attachment is restored waiting and does
    // not activate, so it cannot wake the workspace.
    const restored = new ResidentTerminalRelay();
    const restoredSocket = new SocketFake();
    const restoredFixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    expect(
      restored.restore(
        restoredSocket,
        persistedReady,
        restoredFixture.transport,
        true,
      ),
    ).toBe(true);
    await settle();
    expect(restoredFixture.transport.activate).not.toHaveBeenCalled();
    restored.workspacePaused();
    expect(controlsSent(restoredSocket)).toEqual([
      { v: 1, type: "error", code: "workspace-paused", retry: "on-focus" },
    ]);

    // A wake from anywhere re-registers the daemon and reattaches it.
    restored.attachmentsReset();
    await settle();
    expect(restoredFixture.transport.activate).toHaveBeenCalledOnce();
    expect(restoredFixture.controls.at(-1)?.type).toBe("terminal.attach");
    expect(restoredSocket.closes).toEqual([]);
  });

  it("serializes concurrent attach dimensions before later resizes", async () => {
    const relay = new ResidentTerminalRelay();
    let releaseFirst!: (state: DxdTerminalHeartbeat) => void;
    const firstActivation = new Promise<DxdTerminalHeartbeat>((resolve) => {
      releaseFirst = resolve;
    });
    const first = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    const firstTransport = {
      ...first.transport,
      activate: vi.fn(() => firstActivation),
    } satisfies ResidentTerminalTransport;
    const second = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    const socketA = new SocketFake();
    const socketB = new SocketFake();
    relay.attach(socketA, firstTransport);
    relay.attach(socketB, second.transport);
    socketA.emit("message", attach(100, 30));
    socketB.emit("message", attach(120, 40));
    await settle();
    expect(firstTransport.activate).toHaveBeenCalledOnce();
    expect(second.transport.activate).not.toHaveBeenCalled();

    releaseFirst({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await settle();
    await settle();

    expect(first.controls[0]).toMatchObject({
      type: "terminal.attach",
      resizeOrdinal: "1",
      dimensions: { columns: 100, rows: 30 },
    });
    expect(second.controls[0]).toMatchObject({
      type: "terminal.attach",
      resizeOrdinal: "2",
      dimensions: { columns: 120, rows: 40 },
    });
  });

  it("consumes explicit exited recovery once before any reconnect", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "exited",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    relay.attach(socket, fixture.transport);
    socket.emit(
      "message",
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
        restartResident: true,
      }),
    );
    await settle();
    expect(
      fixture.controls.filter(({ type }) => type === "terminal.open"),
    ).toHaveLength(1);

    relay.daemonConnectionReset();
    relay.attachmentsReset();
    await settle();

    expect(
      fixture.controls.filter(({ type }) => type === "terminal.open"),
    ).toHaveLength(1);
    expect(controlsSent(socket).at(-1)).toMatchObject({
      code: "terminal-exited",
      retry: "manual",
    });
  });

  it("reports a shell lost with a restarted daemon before activation finishes", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const exited: DxdTerminalHeartbeat = {
      terminalVersion: 1,
      terminal: "default",
      state: "exited",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    };
    const fixture = transportFixture(exited);
    // Activation (environment, Changes repair) is still running.
    const transport = {
      ...fixture.transport,
      activate: vi.fn(() => new Promise<DxdTerminalHeartbeat>(() => undefined)),
      exitedTerminal: async () => exited,
    };
    relay.attach(socket, transport);
    socket.emit(
      "message",
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
      }),
    );
    await settle();

    expect(fixture.controls).toHaveLength(0);
    expect(controlsSent(socket).at(-1)).toMatchObject({
      code: "terminal-exited",
      retry: "manual",
    });
  });

  it("forwards daemon liveness only to ready browser attachments", async () => {
    const relay = new ResidentTerminalRelay();
    const readySocket = new SocketFake();
    const waitingSocket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await readyAttachment(relay, readySocket, fixture);
    relay.attach(waitingSocket, fixture.transport);

    relay.daemonHeartbeat();

    expect(controlsSent(readySocket).at(-1)).toEqual({
      v: 1,
      type: "heartbeat",
    });
    expect(controlsSent(waitingSocket)).toEqual([
      { v: 1, type: "progress", phase: "starting" },
    ]);
  });

  it("answers a present browser's liveness miss on its own socket", async () => {
    const readyState: DxdTerminalHeartbeat = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    };
    const recover = JSON.stringify({ v: 1, type: "recover" });

    // A live daemon: one heartbeat back, no activation, no reattach.
    const liveRelay = new ResidentTerminalRelay();
    const liveSocket = new SocketFake();
    const live = transportFixture(readyState);
    const liveCheck = vi.fn(async () => true);
    await readyAttachment(liveRelay, liveSocket, {
      ...live,
      transport: { ...live.transport, checkLiveness: liveCheck },
    });
    const liveControls = live.controls.length;
    liveSocket.emit("message", recover);
    await settle();
    expect(liveCheck).toHaveBeenCalledOnce();
    expect(controlsSent(liveSocket).at(-1)).toEqual({
      v: 1,
      type: "heartbeat",
    });
    expect(live.transport.activate).toHaveBeenCalledOnce();
    expect(live.controls).toHaveLength(liveControls);
    expect(liveSocket.closes).toEqual([]);

    // A silent daemon is fenced (every attachment waits) and this socket is
    // woken and reattached in place.
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const hiddenSocket = new SocketFake();
    const fixture = transportFixture(readyState);
    const transport: ResidentTerminalTransport = {
      ...fixture.transport,
      checkLiveness: vi.fn(async () => {
        relay.daemonUnavailable();
        return false;
      }),
    };
    await readyAttachment(relay, socket, { ...fixture, transport });
    await readyAttachment(relay, hiddenSocket, { ...fixture, transport });
    expect(fixture.transport.activate).toHaveBeenCalledTimes(2);
    socket.emit("message", recover);
    await settle();
    expect(controlsSent(socket)).toContainEqual({
      v: 1,
      type: "progress",
      phase: "resident-restarting",
    });
    expect(fixture.transport.activate).toHaveBeenCalledTimes(3);
    expect(fixture.controls.at(-1)?.type).toBe("terminal.attach");
    expect(socket.closes).toEqual([]);
    // The other attachment was told, but only the present browser woke it.
    expect(controlsSent(hiddenSocket).at(-1)).toEqual({
      v: 1,
      type: "progress",
      phase: "resident-restarting",
    });

    // A waiting attachment wakes on recovery intent; one already on its way
    // to ready ignores it.
    hiddenSocket.emit("message", recover);
    await settle();
    expect(fixture.transport.activate).toHaveBeenCalledTimes(4);
    hiddenSocket.emit("message", recover);
    await settle();
    expect(fixture.transport.activate).toHaveBeenCalledTimes(4);
    expect(hiddenSocket.closes).toEqual([]);
  });

  it("maps oversized browser controls and input to close 1009", async () => {
    const controlSocket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    new ResidentTerminalRelay().attach(controlSocket, fixture.transport);
    controlSocket.emit("message", "x".repeat(4_097));
    expect(controlSocket.closes).toEqual([[1009, ""]]);
    expect(controlsSent(controlSocket).at(-1)).toMatchObject({
      code: "invalid-message",
      retry: "never",
    });

    const relay = new ResidentTerminalRelay();
    const inputSocket = new SocketFake();
    const readyFixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await readyAttachment(relay, inputSocket, readyFixture);
    inputSocket.emit("message", new Uint8Array(65_487).buffer);
    await settle();
    expect(inputSocket.closes.at(-1)).toEqual([1009, ""]);
  });

  it("drains lifecycle attachments without starting recovery", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await readyAttachment(relay, socket, fixture);

    relay.closeForLifecycle("thread-archived", "after-unarchive", 1000);
    await settle();

    expect(controlsSent(socket).at(-1)).toEqual({
      v: 1,
      type: "error",
      code: "thread-archived",
      retry: "after-unarchive",
    });
    expect(socket.closes.at(-1)).toEqual([1000, ""]);
    expect(fixture.controls.at(-1)).toMatchObject({
      type: "terminal.detach",
      reason: "lifecycle",
    });
    expect(fixture.transport.activate).toHaveBeenCalledOnce();
  });

  it("offers one immediate reconnect after transient activation failure", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    const transport: ResidentTerminalTransport = {
      ...fixture.transport,
      activate: vi.fn(async () => {
        throw new Error("transient activation failure");
      }),
    };

    relay.attach(socket, transport);
    socket.emit("message", attach());
    await settle();

    expect(controlsSent(socket).at(-1)).toEqual({
      v: 1,
      type: "error",
      code: "resident-unavailable",
      retry: "immediate-once",
    });
    expect(socket.closes.at(-1)).toEqual([1012, ""]);
  });

  it("orders first attach, replay, live output, input, resize, detach, and warm reattach", async () => {
    const relay = new ResidentTerminalRelay();
    const firstSocket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    relay.attach(firstSocket, fixture.transport);
    firstSocket.emit("message", attach());
    await settle();

    expect(fixture.controls).toEqual([
      {
        terminalVersion: 1,
        type: "terminal.open",
        terminal: "default",
        mode: "open-if-absent",
        dimensions: { columns: 80, rows: 20 },
      },
    ]);
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.resident-state",
      terminal: "default",
      residentGeneration: resident,
      state: "ready",
      dimensions: { columns: 80, rows: 20 },
      nextOutputSequence: u64(3),
      foregroundCommand: false,
      restartRequired: false,
    });
    const firstAttach = fixture.controls.at(-1);
    expect(firstAttach?.type).toBe("terminal.attach");
    if (firstAttach?.type !== "terminal.attach")
      throw new Error("attach missing");
    expect(firstAttach.resizeOrdinal).toBe("1");
    const firstAttachment = firstAttach.attachmentGeneration;

    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.replay-start",
      residentGeneration: resident,
      attachmentGeneration: firstAttachment,
      firstOutputSequence: u64(1),
      throughOutputSequence: u64(2),
      replayBytes: 2,
      truncated: false,
    });
    for (const sequence of [1, 2])
      relay.receiveBinary(
        encodeDxdTerminalFrame({
          kind: 2,
          residentGeneration: resident,
          attachmentGeneration: firstAttachment,
          sequence: u64(sequence),
          payload: Uint8Array.of(sequence),
        }),
      );
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.attachment-ready",
      residentGeneration: resident,
      attachmentGeneration: firstAttachment,
      throughOutputSequence: u64(2),
      dimensionsRevision: u64(0),
      dimensions: { columns: 80, rows: 20 },
    });
    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 3,
        residentGeneration: resident,
        sequence: u64(3),
        payload: Uint8Array.of(3),
      }),
    );

    firstSocket.emit("message", Uint8Array.of(4).buffer);
    firstSocket.emit(
      "message",
      JSON.stringify({
        v: 1,
        type: "resize",
        dimensions: { columns: 100, rows: 30 },
      }),
    );
    firstSocket.emit("message", JSON.stringify({ v: 1, type: "detach" }));
    await settle();

    expect(
      decodeDxdTerminalFrame(fixture.binary[0] as Uint8Array),
    ).toMatchObject({
      kind: 1,
      residentGeneration: resident,
      attachmentGeneration: firstAttachment,
      sequence: "1",
      payload: Uint8Array.of(4),
    });
    expect(fixture.controls.slice(-2).map(({ type }) => type)).toEqual([
      "terminal.resize",
      "terminal.detach",
    ]);
    expect(
      fixture.controls.find(({ type }) => type === "terminal.resize"),
    ).toMatchObject({
      resizeOrdinal: "2",
      dimensions: { columns: 100, rows: 30 },
    });
    expect(firstSocket.closes.at(-1)).toEqual([1000, ""]);

    const warmSocket = new SocketFake();
    const warm = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    relay.attach(warmSocket, warm.transport);
    warmSocket.emit("message", attach(100, 30));
    await settle();
    const warmAttach = warm.controls[0];
    expect(warmAttach).toMatchObject({
      type: "terminal.attach",
      residentGeneration: resident,
      resizeOrdinal: "3",
      dimensions: { columns: 100, rows: 30 },
    });
    if (warmAttach?.type !== "terminal.attach")
      throw new Error("warm attach missing");
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.replay-start",
      residentGeneration: resident,
      attachmentGeneration: warmAttach.attachmentGeneration,
      firstOutputSequence: u64(1),
      throughOutputSequence: u64(3),
      replayBytes: 3,
      truncated: false,
    });
    for (const sequence of [1, 2, 3])
      relay.receiveBinary(
        encodeDxdTerminalFrame({
          kind: 2,
          residentGeneration: resident,
          attachmentGeneration: warmAttach.attachmentGeneration,
          sequence: u64(sequence),
          payload: Uint8Array.of(sequence),
        }),
      );
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.attachment-ready",
      residentGeneration: resident,
      attachmentGeneration: warmAttach.attachmentGeneration,
      throughOutputSequence: u64(3),
      dimensionsRevision: u64(1),
      dimensions: { columns: 100, rows: 30 },
    });

    expect(
      warmSocket.sent.filter((frame) => ArrayBuffer.isView(frame)),
    ).toEqual([Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)]);
    expect(controlsSent(warmSocket).at(-1)).toMatchObject({
      type: "ready",
      replayBytes: 3,
      dimensions: { columns: 100, rows: 30 },
    });
    expect(warm.phases).toEqual([
      "daemon_ready",
      "resident_ready",
      "resident_attach_dispatched",
      "resident_replay_started",
      "resident_attachment_ready",
      "terminal_ready",
    ]);
  });

  it("attempts the resident commit control once and never reactivates on failure", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const controls: DxdCoreTerminalControl[] = [];
    const transport: ResidentTerminalTransport = {
      activate: vi.fn(
        async () =>
          ({
            terminalVersion: 1,
            terminal: "default",
            state: "absent",
          }) as const,
      ),
      refreshEnvironment: vi.fn(
        async () =>
          ({
            terminalVersion: 1,
            terminal: "default",
            state: "absent",
          }) as const,
      ),
      sendControl: vi.fn((control) => {
        controls.push(control);
        throw new Error("uncertain resident control dispatch");
      }),
      sendBinary: vi.fn(),
      record: vi.fn(),
    };
    relay.attach(socket, transport);
    socket.emit("message", attach());
    await settle();

    expect(controls.map(({ type }) => type)).toEqual(["terminal.open"]);
    expect(transport.activate).toHaveBeenCalledOnce();
    expect(controlsSent(socket).at(-1)).toEqual({
      v: 1,
      type: "error",
      code: "resident-unavailable",
      retry: "manual",
    });
    expect(socket.closes.at(-1)).toEqual([1012, ""]);
  });

  it("refreshes a current environment without restarting the resident", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    });
    await readyAttachment(relay, socket, fixture);

    socket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
    await settle();

    expect(fixture.transport.refreshEnvironment).toHaveBeenCalledOnce();
    expect(
      fixture.controls.some((control) => control.type === "terminal.restart"),
    ).toBe(false);
    expect(socket.closes).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a disconnected owner's pending refresh when it %ss",
    async (outcome) => {
      const relay = new ResidentTerminalRelay();
      const state = {
        terminalVersion: 1,
        terminal: "default",
        state: "ready",
        residentGeneration: resident,
        foregroundCommand: false,
        restartRequired: false,
      } as const;
      const firstSocket = new SocketFake();
      const secondSocket = new SocketFake();
      const first = transportFixture(state);
      const second = transportFixture(state);
      await readyAttachment(relay, firstSocket, first);
      await readyAttachment(relay, secondSocket, second);
      let resolve!: (state: DxdTerminalHeartbeat) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<DxdTerminalHeartbeat>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      vi.mocked(first.transport.refreshEnvironment).mockReturnValue(pending);

      firstSocket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
      await settle();
      expect(first.transport.refreshEnvironment).toHaveBeenCalledOnce();
      firstSocket.emit("close");
      if (outcome === "resolve") resolve({ ...state, restartRequired: true });
      else reject(new Error("refresh failed"));
      await settle();

      expect(
        [...first.controls, ...second.controls].some(
          (control) => control.type === "terminal.restart",
        ),
      ).toBe(false);
      expect(secondSocket.closes).toEqual([]);
      secondSocket.emit("message", Uint8Array.of(42));
      await settle();
      expect(second.binary).toHaveLength(1);
    },
  );

  it("fences repeated and concurrent refreshes with one distinct CAS restart", async () => {
    const relay = new ResidentTerminalRelay();
    const state = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: true,
      restartRequired: false,
    } as const;
    const firstSocket = new SocketFake();
    const secondSocket = new SocketFake();
    const first = transportFixture(state);
    const second = transportFixture(state);
    const refreshed = { ...state, restartRequired: true } as const;
    vi.mocked(first.transport.refreshEnvironment).mockResolvedValue(refreshed);
    vi.mocked(second.transport.refreshEnvironment).mockResolvedValue(refreshed);
    await readyAttachment(relay, firstSocket, first);
    await readyAttachment(relay, secondSocket, second);

    firstSocket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
    firstSocket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
    secondSocket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
    await settle();

    const restarts = [...first.controls, ...second.controls].filter(
      (control) => control.type === "terminal.restart",
    );
    expect(
      vi.mocked(first.transport.refreshEnvironment).mock.calls.length +
        vi.mocked(second.transport.refreshEnvironment).mock.calls.length,
    ).toBe(1);
    expect(restarts).toEqual([
      {
        terminalVersion: 1,
        type: "terminal.restart",
        terminal: "default",
        expectedResidentGeneration: resident,
        dimensions: { columns: 80, rows: 20 },
      },
    ]);
    expect(
      [...first.controls, ...second.controls].some(
        (control) =>
          control.type === "terminal.open" && control.mode === "restart-exited",
      ),
    ).toBe(false);
  });

  it("resets daemon sequence counters when an environment restart rotates the resident", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const state = {
      terminalVersion: 1,
      terminal: "default",
      state: "ready",
      residentGeneration: resident,
      foregroundCommand: false,
      restartRequired: false,
    } as const;
    const fixture = transportFixture(state);
    await readyAttachment(relay, socket, fixture);
    socket.emit("message", Uint8Array.of(9).buffer);
    await settle();
    vi.mocked(fixture.transport.refreshEnvironment).mockResolvedValue({
      ...state,
      restartRequired: true,
    });

    socket.emit("message", JSON.stringify({ v: 1, type: "restart" }));
    await settle();
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.resident-state",
      terminal: "default",
      residentGeneration: restartedResident,
      state: "ready",
      dimensions: { columns: 80, rows: 20 },
      nextOutputSequence: u64(2),
      foregroundCommand: false,
      restartRequired: false,
    });

    const restartedAttach = fixture.controls.at(-1);
    expect(restartedAttach).toMatchObject({
      type: "terminal.attach",
      residentGeneration: restartedResident,
      resizeOrdinal: u64(1),
    });
    if (restartedAttach?.type !== "terminal.attach")
      throw new Error("restarted attach missing");
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.replay-start",
      residentGeneration: restartedResident,
      attachmentGeneration: restartedAttach.attachmentGeneration,
      firstOutputSequence: u64(1),
      throughOutputSequence: u64(1),
      replayBytes: 1,
      truncated: false,
    });
    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 2,
        residentGeneration: restartedResident,
        attachmentGeneration: restartedAttach.attachmentGeneration,
        sequence: u64(1),
        payload: Uint8Array.of(1),
      }),
    );
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.attachment-ready",
      residentGeneration: restartedResident,
      attachmentGeneration: restartedAttach.attachmentGeneration,
      throughOutputSequence: u64(1),
      dimensionsRevision: u64(0),
      dimensions: { columns: 80, rows: 20 },
    });
    socket.emit("message", Uint8Array.of(8).buffer);
    await settle();

    const restartedInputFrame = fixture.binary.at(-1);
    if (restartedInputFrame === undefined)
      throw new Error("restarted input missing");
    const restartedInput = decodeDxdTerminalFrame(restartedInputFrame);
    expect(restartedInput.kind).toBe(1);
    expect(restartedInput.sequence).toBe(u64(1));
  });

  it("never retries an uncertain input or invokes another dispatch path", async () => {
    const relay = new ResidentTerminalRelay();
    const socket = new SocketFake();
    const attempted: Uint8Array[] = [];
    const fixture = transportFixture(
      {
        terminalVersion: 1,
        terminal: "default",
        state: "ready",
        residentGeneration: resident,
        foregroundCommand: false,
        restartRequired: false,
      },
      (frame) => {
        attempted.push(frame);
        throw new Error("uncertain partial write");
      },
    );
    relay.attach(socket, fixture.transport);
    socket.emit("message", attach());
    await settle();
    const control = fixture.controls[0];
    if (control?.type !== "terminal.attach") throw new Error("attach missing");
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.replay-start",
      residentGeneration: resident,
      attachmentGeneration: control.attachmentGeneration,
      firstOutputSequence: u64(1),
      throughOutputSequence: u64(1),
      replayBytes: 1,
      truncated: false,
    });
    relay.receiveBinary(
      encodeDxdTerminalFrame({
        kind: 2,
        residentGeneration: resident,
        attachmentGeneration: control.attachmentGeneration,
        sequence: u64(1),
        payload: Uint8Array.of(1),
      }),
    );
    relay.receiveControl({
      terminalVersion: 1,
      type: "terminal.attachment-ready",
      residentGeneration: resident,
      attachmentGeneration: control.attachmentGeneration,
      throughOutputSequence: u64(1),
      dimensionsRevision: u64(0),
      dimensions: { columns: 80, rows: 20 },
    });

    socket.emit("message", Uint8Array.of(9).buffer);
    await settle();

    expect(attempted).toHaveLength(1);
    expect(controlsSent(socket).at(-1)).toEqual({
      v: 1,
      type: "error",
      code: "resident-unavailable",
      retry: "manual",
    });
    expect(socket.closes.at(-1)).toEqual([1012, ""]);
    expect(fixture.transport.activate).toHaveBeenCalledOnce();
  });

  it("rejects invalid browser controls before resident dispatch without leaking content", async () => {
    const socket = new SocketFake();
    const fixture = transportFixture({
      terminalVersion: 1,
      terminal: "default",
      state: "absent",
    });
    new ResidentTerminalRelay().attach(socket, fixture.transport);

    socket.emit(
      "message",
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 0, rows: 20 },
        cause: "credential provider-id tmux-name secret-command",
      }),
    );
    await settle();

    expect(fixture.transport.activate).not.toHaveBeenCalled();
    expect(fixture.controls).toEqual([]);
    expect(JSON.stringify(socket.sent)).not.toMatch(
      /credential|provider-id|tmux-name|secret-command/,
    );
    expect(controlsSent(socket).at(-1)).toEqual({
      v: 1,
      type: "error",
      code: "invalid-message",
      retry: "never",
    });
  });
});
