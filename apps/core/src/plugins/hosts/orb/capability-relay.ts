import { getLogger } from "@logtape/logtape";
import type { DxdPluginCapabilityMessage } from "../../../execution/dxd/protocol.js";
import { DXD_MAX_PLUGIN_CAPABILITY_FRAME_BYTES } from "../../../execution/dxd/protocol.js";

/**
 * The Orb host's capability relay inside the Thread's execution object.
 *
 * A `plugin.invoke` in flight carries an RPC stub to the calling Worker's
 * capabilities (one `PluginHost`, behind {@link OrbCapabilities}). While it
 * runs, the plugin's Orb process asks dxd for a capability, dxd sends
 * `plugin.capability` naming the invoke's `requestId`, and this relay calls
 * the stub and answers `plugin.capability-result`. A capability for a call
 * that already ended, or from another daemon connection, is refused.
 */

const logger = getLogger(["dx", "plugins", "hosts", "orb"]);

/** What the execution object holds for one invoke: the Worker's stub. */
export interface OrbCapabilityTarget {
  call(method: string, args: ReadonlyArray<unknown>): Promise<unknown>;
}

interface Pending {
  readonly socket: WebSocket;
  readonly generation: string;
  readonly target: OrbCapabilityTarget;
}

const utf8 = new TextEncoder();

export class OrbCapabilityRelay {
  readonly #pending = new Map<string, Pending>();

  /** Starts relaying for one invoke; returns the function that ends it. */
  open(requestId: string, pending: Pending) {
    this.#pending.set(requestId, pending);
    return () => {
      if (this.#pending.get(requestId) === pending)
        this.#pending.delete(requestId);
    };
  }

  get size() {
    return this.#pending.size;
  }

  /** Answers one capability frame; never throws. */
  async receive(socket: WebSocket, message: DxdPluginCapabilityMessage) {
    const pending = this.#pending.get(message.requestId);
    const answer = (
      result: { ok: true; value: unknown } | { ok: false; error: string },
    ) => {
      let encoded = JSON.stringify({
        type: "plugin.capability-result",
        generation: message.generation,
        requestId: message.requestId,
        callId: message.callId,
        ...result,
      });
      if (
        utf8.encode(encoded).byteLength > DXD_MAX_PLUGIN_CAPABILITY_FRAME_BYTES
      )
        encoded = JSON.stringify({
          type: "plugin.capability-result",
          generation: message.generation,
          requestId: message.requestId,
          callId: message.callId,
          ok: false,
          error: "The answer is larger than 1 MiB; ask for less at once.",
        });
      try {
        socket.send(encoded);
      } catch {
        // The daemon is gone; its call fails on its own.
      }
    };
    if (
      pending === undefined ||
      pending.socket !== socket ||
      pending.generation !== message.generation
    ) {
      answer({ ok: false, error: "The call this belongs to has ended." });
      return;
    }
    try {
      const value = await pending.target.call(message.method, message.args);
      answer({ ok: true, value: value ?? null });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      logger.info("Orb plugin capability refused or failed.", {
        event: "plugin_orb_capability_failed",
        method: message.method,
        reason: text.slice(0, 200),
      });
      answer({ ok: false, error: text.slice(0, 4_096) });
    }
  }
}
