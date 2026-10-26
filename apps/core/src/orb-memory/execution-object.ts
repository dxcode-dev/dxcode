// Orb memory inside the Thread execution Durable Object. The resident daemon
// reports the guest's memory on every heartbeat, on every Execution provider;
// this object tells the Thread's viewers when it crosses into pressure, and
// relays snapshots and stops without ever waking a paused workspace.
//
// Contract (Thread execution object), after Thread authorization:
//   GET  https://thread-execution/orb/memory        snapshot
//   POST https://thread-execution/orb/memory/stop   {"process": "<id>"}
// with x-dx-thread-id. Both answer 200 with `OrbMemoryRelayResult` JSON.

import { isOrbMemoryPressure, OrbProcessIdSchema } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import {
  DxdMemorySnapshotResult,
  DxdMemoryStopResult,
  type DxdMemoryUsage,
  type DxdOperation,
} from "../execution/dxd/protocol.js";

/** Viewers are told of new pressure at most this often. */
export const ORB_MEMORY_HINT_INTERVAL_MS = 10_000;

/** A heartbeat's reading of memory or disk. */
type OrbUsage = Pick<DxdMemoryUsage, "usedBytes" | "totalBytes">;

/**
 * Whether the current pressure episode (memory, or with `isPressure` the
 * disk) was announced to the Thread's viewers. Ephemeral: after hibernation
 * or a lost daemon, the next heartbeat (two seconds) announces an ongoing
 * episode again.
 */
export class OrbPressureMonitor {
  #announced = false;
  #announcedAt = Number.NEGATIVE_INFINITY;
  readonly #announce: (threadId: ThreadId, usage: OrbUsage) => void;
  readonly #isPressure: (usedBytes: number, totalBytes: number) => boolean;

  constructor(
    announce: (threadId: ThreadId, usage: OrbUsage) => void,
    isPressure = isOrbMemoryPressure,
  ) {
    this.#announce = announce;
    this.#isPressure = isPressure;
  }

  /**
   * A heartbeat's report. Rising into pressure announces once per episode,
   * no more often than `ORB_MEMORY_HINT_INTERVAL_MS`; viewers who see the
   * pressure poll until it ends, so falling out needs no announcement.
   */
  observe(threadId: ThreadId, usage: OrbUsage | undefined, now: number) {
    if (
      usage === undefined ||
      !this.#isPressure(usage.usedBytes, usage.totalBytes)
    ) {
      this.#announced = false;
      return;
    }
    if (
      this.#announced ||
      now - this.#announcedAt < ORB_MEMORY_HINT_INTERVAL_MS
    )
      return;
    this.#announced = true;
    this.#announcedAt = now;
    this.#announce(threadId, usage);
  }

  /** The daemon is gone or replaced: a later report starts a new episode. */
  reset() {
    this.#announced = false;
  }
}

/** What the object tells the route; the route adds the public framing. */
export type OrbMemoryRelayResult =
  | { readonly workspace: "paused" | "unavailable" }
  | {
      readonly workspace: "running";
      readonly snapshot?: Extract<
        DxdMemorySnapshotResult,
        { readonly kind: "snapshot" }
      >;
    }
  | {
      readonly workspace: "running";
      readonly stop: DxdMemoryStopResult;
    };

export interface OrbMemoryDaemon {
  /** The Thread this object's daemon serves, if it ever activated. */
  readonly threadId: string | undefined;
  /** A live, heartbeating daemon: nothing here may wake the workspace. */
  readonly running: boolean;
  /** The daemon registered the `memory` capability. */
  readonly memory: boolean;
  readonly dispatch: (operation: DxdOperation) => Promise<Response>;
}

const StopRequest = Schema.Struct({ process: OrbProcessIdSchema });

const relay = (result: OrbMemoryRelayResult) =>
  Response.json(result, { headers: { "cache-control": "no-store" } });

/** Serves `/orb/memory` and `/orb/memory/stop` for an authorized caller. */
export const serveOrbMemory = async (
  request: Request,
  path: "/orb/memory" | "/orb/memory/stop",
  threadId: ThreadId,
  daemon: OrbMemoryDaemon,
): Promise<Response> => {
  const stopping = path === "/orb/memory/stop";
  if (request.method !== (stopping ? "POST" : "GET"))
    return new Response(null, { status: 405 });
  let process: string | undefined;
  if (stopping) {
    const body = Schema.decodeUnknownOption(StopRequest)(
      await request.json().catch(() => undefined),
      { onExcessProperty: "error" },
    );
    if (Option.isNone(body)) return new Response(null, { status: 400 });
    process = body.value.process;
  }
  if (daemon.threadId !== threadId) return relay({ workspace: "unavailable" });
  if (!daemon.running) return relay({ workspace: "paused" });
  if (!daemon.memory)
    return stopping
      ? relay({ workspace: "unavailable" })
      : relay({ workspace: "running" });
  const response = await daemon.dispatch(
    process === undefined
      ? { operation: "memory.snapshot" }
      : { operation: "memory.stop", process },
  );
  if (!response.ok) return relay({ workspace: "unavailable" });
  const body = await response.json().catch(() => undefined);
  if (process !== undefined) {
    const stop = Schema.decodeUnknownOption(DxdMemoryStopResult)(body, {
      onExcessProperty: "error",
    });
    return relay(
      Option.isNone(stop)
        ? { workspace: "unavailable" }
        : { workspace: "running", stop: stop.value },
    );
  }
  const snapshot = Schema.decodeUnknownOption(DxdMemorySnapshotResult)(body, {
    onExcessProperty: "error",
  });
  if (Option.isNone(snapshot)) return relay({ workspace: "unavailable" });
  if (snapshot.value.kind !== "snapshot")
    return relay({ workspace: "running" });
  return relay({ workspace: "running", snapshot: snapshot.value });
};
