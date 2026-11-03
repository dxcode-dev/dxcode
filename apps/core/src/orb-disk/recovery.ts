// A turn whose source preparation fails because the Orb's disk is full
// (#1614). Before this, every later turn failed the same way at the checkout
// read, before the agent ran, so nothing could ever free space:
//
// 1. dx runs its cleanup once (dx's reserve and leftovers, package-manager
//    caches, the Orb user's /tmp files; never the checkout) and retries the
//    preparation once.
// 2. When the retry still finds the disk full, the turn starts anyway in
//    recovery mode: no checkout read, no setup or resume scripts, in the
//    checkout when it exists. The agent is told so (note.ts) and frees space
//    with its shell. The next turn prepares the source as usual.
//
// Any other failure, and a disk-full failure where there is no guard (the
// local runtime), fails as before.

import type { WorkspacePreparation } from "../execution/workspace-preparation.js";
import { executionWorkspaceLogger } from "../logging.js";
import type { SourceWorkspaceDiskOptions } from "../source-control/source-workspace.js";
import {
  cleanupFoundCheckout,
  parseWorkspaceDiskReading,
  type WorkspaceDiskReading,
  workspaceDiskCleanup,
} from "./guard.js";

/** The home directory, where a recovery turn starts without a checkout. */
const HOME = "/home/user";
const CHECKOUT = "/home/user/workspace/repo";
const CLEANUP_TIMEOUT_MS = 120_000;

const messageOf = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" &&
        cause !== null &&
        "message" in cause &&
        typeof cause.message === "string"
      ? cause.message
      : "";

/** The preparation failed because the Orb's disk is full. */
export const isWorkspaceDiskFullFailure = (cause: unknown) =>
  messageOf(cause).includes(":WORKSPACE_DISK_FULL)");

/**
 * Runs `prepare` (the source activation); on a full disk, cleans up and
 * retries once, then falls back to recovery mode. Returns the turn's cwd.
 */
export const prepareWithDiskRecovery = async (
  threadId: string,
  preparation: WorkspacePreparation,
  disk: SourceWorkspaceDiskOptions | undefined,
  prepare: (disk: SourceWorkspaceDiskOptions | undefined) => Promise<string>,
): Promise<string> => {
  try {
    return await prepare(disk);
  } catch (cause) {
    if (
      disk === undefined ||
      !disk.reserve ||
      !isWorkspaceDiskFullFailure(cause)
    )
      throw cause;
    const cleanup = await preparation
      .run(workspaceDiskCleanup(), { cwd: HOME, timeoutMs: CLEANUP_TIMEOUT_MS })
      .catch(() => undefined);
    if (cleanup === undefined) throw cause;
    let latest: WorkspaceDiskReading | undefined = parseWorkspaceDiskReading(
      cleanup.stderr ?? "",
    );
    const remember = (reading: WorkspaceDiskReading) => {
      disk.onReading?.(reading);
    };
    executionWorkspaceLogger.warn("The Orb's disk was full; dx cleaned up.", {
      event: "workspace_disk_cleanup",
      threadId,
      ...(latest === undefined
        ? {}
        : {
            availableBytes: latest.availableBytes,
            totalBytes: latest.totalBytes,
          }),
    });
    try {
      const cwd = await prepare({
        ...disk,
        onReading: (reading) => {
          latest = reading;
        },
      });
      if (latest !== undefined)
        remember({ ...latest, full: true, after: "cleaned" });
      executionWorkspaceLogger.info("The turn started after dx cleaned up.", {
        event: "workspace_disk_cleanup",
        threadId,
        outcome: "cleaned",
      });
      return cwd;
    } catch (again) {
      if (!isWorkspaceDiskFullFailure(again)) throw again;
      // Without a reading the agent could not be told why; fail as before.
      if (latest === undefined) throw again;
      remember({ ...latest, full: true, after: "recovery" });
      executionWorkspaceLogger.warn(
        "The Orb's disk is still full; the turn starts in recovery mode.",
        {
          event: "workspace_disk_cleanup",
          threadId,
          outcome: "recovery",
          availableBytes: latest.availableBytes,
        },
      );
      return cleanupFoundCheckout(cleanup.stderr ?? "") ? CHECKOUT : HOME;
    }
  }
};
