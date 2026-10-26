// Orb disk inside the Thread execution Durable Object. The resident daemon
// reports the workspace filesystem's usage on every heartbeat, on every
// Execution provider; this object tells the Thread's viewers when it crosses
// into pressure, answers usage from the last heartbeat, and relays folder
// snapshots and deletes without ever waking a paused workspace.
//
// Contract (Thread execution object), after Thread authorization:
//   GET  https://thread-execution/orb/disk[?folders=1]   usage [+ folders]
//   POST https://thread-execution/orb/disk/delete        {"path": "<home-relative>"}
// with x-dx-thread-id. Both answer 200 with `OrbDiskRelayResult` JSON.

import { OrbFolderPathSchema } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import {
  DxdDiskDeleteResult,
  DxdDiskSnapshotResult,
  type DxdDiskUsage,
  type DxdOperation,
} from "../execution/dxd/protocol.js";

/** What the object tells the route; the route adds the public framing. */
export type OrbDiskRelayResult =
  | { readonly workspace: "paused" | "unavailable" }
  | {
      readonly workspace: "running";
      readonly usage?: DxdDiskUsage;
      readonly snapshot?: Extract<
        DxdDiskSnapshotResult,
        { readonly kind: "snapshot" }
      >;
    }
  | {
      readonly workspace: "running";
      readonly deleted: DxdDiskDeleteResult;
    };

export interface OrbDiskDaemon {
  /** The Thread this object's daemon serves, if it ever activated. */
  readonly threadId: string | undefined;
  /** A live, heartbeating daemon: nothing here may wake the workspace. */
  readonly running: boolean;
  /** The daemon registered the `disk` capability. */
  readonly disk: boolean;
  /** The last heartbeat's reading. */
  readonly usage: DxdDiskUsage | undefined;
  readonly dispatch: (operation: DxdOperation) => Promise<Response>;
}

const DeleteRequest = Schema.Struct({ path: OrbFolderPathSchema });

const relay = (result: OrbDiskRelayResult) =>
  Response.json(result, { headers: { "cache-control": "no-store" } });

/** A daemon answer, or undefined when it failed or does not decode. */
const answer = async (response: Response): Promise<unknown> => {
  if (response.ok) return response.json().catch(() => undefined);
  await response.body?.cancel();
  return undefined;
};

/** Serves `/orb/disk` and `/orb/disk/delete` for an authorized caller. */
export const serveOrbDisk = async (
  request: Request,
  path: "/orb/disk" | "/orb/disk/delete",
  threadId: ThreadId,
  daemon: OrbDiskDaemon,
): Promise<Response> => {
  const deleting = path === "/orb/disk/delete";
  if (request.method !== (deleting ? "POST" : "GET"))
    return new Response(null, { status: 405 });
  let folder: string | undefined;
  if (deleting) {
    const body = Schema.decodeUnknownOption(DeleteRequest)(
      await request.json().catch(() => undefined),
      { onExcessProperty: "error" },
    );
    if (Option.isNone(body)) return new Response(null, { status: 400 });
    folder = body.value.path;
  }
  if (daemon.threadId !== threadId) return relay({ workspace: "unavailable" });
  if (!daemon.running) return relay({ workspace: "paused" });
  if (!daemon.disk)
    return deleting
      ? relay({ workspace: "unavailable" })
      : relay({ workspace: "running" });
  if (folder !== undefined) {
    const deleted = Schema.decodeUnknownOption(DxdDiskDeleteResult)(
      await answer(
        await daemon.dispatch({ operation: "disk.delete", path: folder }),
      ),
      { onExcessProperty: "error" },
    );
    return relay(
      Option.isNone(deleted)
        ? { workspace: "unavailable" }
        : { workspace: "running", deleted: deleted.value },
    );
  }
  const usage = daemon.usage;
  if (new URL(request.url).searchParams.get("folders") !== "1")
    return relay({
      workspace: "running",
      ...(usage === undefined ? {} : { usage }),
    });
  const decoded = Schema.decodeUnknownOption(DxdDiskSnapshotResult)(
    await answer(await daemon.dispatch({ operation: "disk.snapshot" })),
    { onExcessProperty: "error" },
  );
  if (Option.isNone(decoded)) return relay({ workspace: "unavailable" });
  const snapshot = decoded.value;
  if (snapshot.kind !== "snapshot")
    return relay({
      workspace: "running",
      ...(usage === undefined ? {} : { usage }),
    });
  return relay({ workspace: "running", snapshot });
};
