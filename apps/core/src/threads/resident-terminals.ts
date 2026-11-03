import type { ThreadTerminalErrorCode, ThreadTerminalId } from "@dx/api";
import type { DxdClientTerminalControl } from "../execution/dxd/protocol.js";
import {
  ResidentTerminalRelay,
  type ResidentTerminalSocket,
  type ResidentTerminalTransport,
} from "./resident-terminal-relay.js";

type Retry = Parameters<ResidentTerminalRelay["close"]>[1];

/**
 * Every Terminal of one Thread, each with its own relay: its own resident
 * in dxd, its own browser attachments, and its own input and resize order.
 * Daemon-wide events reach all of them; a resident's own messages reach the
 * relay that holds its generation.
 */
export class ResidentTerminals {
  readonly #relays = new Map<ThreadTerminalId, ResidentTerminalRelay>();

  #relay(terminal: ThreadTerminalId) {
    let relay = this.#relays.get(terminal);
    if (relay === undefined) {
      relay = new ResidentTerminalRelay(terminal);
      this.#relays.set(terminal, relay);
    }
    return relay;
  }

  #holding(socket: ResidentTerminalSocket) {
    for (const relay of this.#relays.values())
      if (relay.has(socket)) return relay;
    return undefined;
  }

  attach(
    terminal: ThreadTerminalId,
    socket: ResidentTerminalSocket,
    transport: ResidentTerminalTransport,
    listen = true,
  ) {
    this.#relay(terminal).attach(socket, transport, listen);
  }

  restore(
    terminal: ThreadTerminalId,
    socket: ResidentTerminalSocket,
    source: unknown,
    transport: ResidentTerminalTransport,
    paused = false,
  ) {
    return this.#relay(terminal).restore(socket, source, transport, paused);
  }

  receiveBrowser(socket: ResidentTerminalSocket, data: unknown) {
    return this.#holding(socket)?.receiveBrowser(socket, data);
  }

  endSession(socket: ResidentTerminalSocket, closeCode: number) {
    (this.#holding(socket) ?? this.#relay("default")).endSession(
      socket,
      closeCode,
    );
  }

  disconnect(socket: ResidentTerminalSocket) {
    this.#holding(socket)?.disconnect(socket);
  }

  receiveControl(control: DxdClientTerminalControl) {
    if ("terminal" in control) {
      this.#relays.get(control.terminal)?.receiveControl(control);
      return;
    }
    // Generation-addressed: only the relay holding that resident acts.
    for (const relay of this.#relays.values()) relay.receiveControl(control);
  }

  receiveBinary(source: ArrayBuffer | ArrayBufferView) {
    for (const relay of this.#relays.values()) relay.receiveBinary(source);
  }

  daemonConnectionReset(quiet = false) {
    let notified = 0;
    for (const relay of this.#relays.values())
      notified += relay.daemonConnectionReset(quiet);
    return notified;
  }

  attachmentsReset() {
    for (const relay of this.#relays.values()) relay.attachmentsReset();
  }

  daemonUnavailable(quiet = false) {
    return this.daemonConnectionReset(quiet);
  }

  get sessionCount() {
    let count = 0;
    for (const relay of this.#relays.values()) count += relay.sessionCount;
    return count;
  }

  daemonHeartbeat() {
    for (const relay of this.#relays.values()) relay.daemonHeartbeat();
  }

  workspaceWaking() {
    for (const relay of this.#relays.values()) relay.workspaceWaking();
  }

  workspacePaused() {
    for (const relay of this.#relays.values()) relay.workspacePaused();
  }

  environmentRestartRequired() {
    for (const relay of this.#relays.values())
      relay.environmentRestartRequired();
  }

  close(code: ThreadTerminalErrorCode, retry: Retry, closeCode: number) {
    for (const relay of this.#relays.values())
      relay.close(code, retry, closeCode);
  }

  closeForLifecycle(
    code: ThreadTerminalErrorCode,
    retry: Retry,
    closeCode: number,
  ) {
    for (const relay of this.#relays.values())
      relay.closeForLifecycle(code, retry, closeCode);
  }

  /** The Terminal was closed: its browsers are told and never retry. */
  terminalClosed(terminal: ThreadTerminalId) {
    const relay = this.#relays.get(terminal);
    if (relay === undefined) return;
    relay.closeForLifecycle("terminal-closed", "never", 1000);
    this.#relays.delete(terminal);
  }
}
