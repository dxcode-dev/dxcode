// A full Orb disk must never stop a Thread for good. Every activation and
// every Claude Code launch runs this guard first, before anything dx writes:
//
// - The first activation with room to spare writes a 256 MB dx-owned reserve
//   file. A disk that later fills up completely gets that space back.
// - A disk with less than 64 MB free loses the reserve and dx's own
//   leftovers (settled Claude Code runs, interrupted installs), so setup and
//   the agent can start and the agent can free space itself. The next
//   activation with room writes the reserve again.
//
// The guard prints one `dx-disk <total KiB> <available KiB> <full>` line to
// stderr; `full` says it had to free space. Core reads it to tell the agent
// (see note.ts), or to fail with WORKSPACE_DISK_FULL when even that left too
// little room to start.

import { markRunFailure } from "../runtime/run-failure.js";

export const WORKSPACE_DISK_RESERVE_PATH =
  "/home/user/.local/state/dx-disk-reserve";

const KIB = 1_024;
const MIB = 1_024 * KIB;
const GIB = 1_024 * MIB;

/** The reserve's size. */
export const WORKSPACE_DISK_RESERVE_BYTES = 256 * MIB;
/** Below this much free space the guard frees the reserve and leftovers. */
const RELEASE_BELOW_BYTES = 64 * MIB;
/** The reserve is written again only with this much free beside it. */
const RESERVE_ABOVE_BYTES = WORKSPACE_DISK_RESERVE_BYTES + GIB;
/** Less free space than this after the guard cannot start a turn. */
const START_BYTES = 16 * MIB;

/** The guard's reading of the workspace filesystem (the one holding home). */
export interface WorkspaceDiskReading {
  readonly totalBytes: number;
  readonly availableBytes: number;
  /** The disk was (nearly) full and the guard freed dx's space. */
  readonly full: boolean;
}

/**
 * POSIX shell for the start of a guest command. It never fails the command,
 * even under `set -e`, and leaves `dx_disk_full` set to 1 when it freed space;
 * `reserve` is false for the local runtime, whose home is a developer's disk.
 */
export const workspaceDiskGuard = (reserve: boolean) =>
  `dx_disk_kib() { df -Pk /home/user 2>/dev/null | awk 'NR==2 {print $4}'; }
dx_disk_full=0
dx_disk_free="$(dx_disk_kib)"
if [ -n "$dx_disk_free" ] && [ "$dx_disk_free" -lt ${RELEASE_BELOW_BYTES / KIB} ]; then
  dx_disk_full=1
  rm -f ${WORKSPACE_DISK_RESERVE_PATH} ${WORKSPACE_DISK_RESERVE_PATH}.tmp
  for dx_disk_run in /home/user/.local/state/dx-claude-code/runs/*/; do
    if [ -f "$dx_disk_run/exit" ]; then rm -rf "$dx_disk_run" 2>/dev/null || true; fi
  done
  rm -rf /home/user/.local/share/dx/skills.stage.* /home/user/.local/share/dx/skills.old.* /home/user/.local/state/dxd/trash 2>/dev/null || true
  # A Cloudflare Orb's filesystem returns deleted blocks a moment later, so
  # the reading waits (up to 5 s) for the freed space instead of reporting
  # the disk as still full.
  dx_disk_wait=0
  while [ "$dx_disk_wait" -lt 25 ] && [ "$(dx_disk_kib)" -lt ${START_BYTES / KIB} ]; do
    sync -f /home/user 2>/dev/null || true
    sleep 0.2
    dx_disk_wait=$((dx_disk_wait + 1))
  done
${
  reserve
    ? `elif [ -n "$dx_disk_free" ] && [ "$dx_disk_free" -gt ${RESERVE_ABOVE_BYTES / KIB} ] && [ ! -e ${WORKSPACE_DISK_RESERVE_PATH} ]; then
  mkdir -p /home/user/.local/state 2>/dev/null || true
  if { fallocate -l ${WORKSPACE_DISK_RESERVE_BYTES} ${WORKSPACE_DISK_RESERVE_PATH}.tmp 2>/dev/null || head -c ${WORKSPACE_DISK_RESERVE_BYTES} /dev/zero > ${WORKSPACE_DISK_RESERVE_PATH}.tmp 2>/dev/null; }; then
    chmod 600 ${WORKSPACE_DISK_RESERVE_PATH}.tmp 2>/dev/null || true
    mv -f ${WORKSPACE_DISK_RESERVE_PATH}.tmp ${WORKSPACE_DISK_RESERVE_PATH} 2>/dev/null || true
  fi
  rm -f ${WORKSPACE_DISK_RESERVE_PATH}.tmp
`
    : ""
}fi
df -Pk /home/user 2>/dev/null | awk -v full="$dx_disk_full" 'NR==2 {print "dx-disk", $2, $4, full}' >&2
`;

/** The guard's line in a command's stderr, if it ran. */
export const parseWorkspaceDiskReading = (
  stderr: string,
): WorkspaceDiskReading | undefined => {
  const match = /^dx-disk (\d+) (\d+) ([01])$/m.exec(stderr);
  if (match === null) return undefined;
  const totalBytes = Number(match[1]) * KIB;
  const availableBytes = Number(match[2]) * KIB;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return undefined;
  return {
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
    full: match[3] === "1",
  };
};

/** The guard's line removed, for logs and failure text. */
export const withoutWorkspaceDiskReading = (stderr: string) =>
  stderr.replace(/^dx-disk \d+ \d+ [01]\n?/m, "");

/** Even after the guard freed what it could, a turn cannot start. */
export const workspaceDiskBlocksStart = (reading: WorkspaceDiskReading) =>
  reading.availableBytes < START_BYTES;

/** `20 GB`: the size people know their Orb by. */
export const formatDiskBytes = (bytes: number) =>
  bytes >= GIB
    ? `${Number((bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1))} GB`
    : `${Math.max(1, Math.round(bytes / MIB))} MB`;

/** A write in the workspace failed because its filesystem is full. */
export const isDiskFullText = (text: string) =>
  /No space left on device|ENOSPC|Disk quota exceeded|EDQUOT/i.test(text);

/**
 * WORKSPACE_DISK_FULL: not retried, since a retry frees nothing. The Thread
 * stays usable: deleting files (from the Terminal, the disk notice, or the
 * agent once it starts) lets the next message run.
 */
export const workspaceDiskFullFailure = (totalBytes?: number) =>
  markRunFailure({
    class: "internal",
    code: "WORKSPACE_DISK_FULL",
    message: `Workspace disk is full${
      totalBytes === undefined ? "" : ` (${formatDiskBytes(totalBytes)} limit)`
    }. Delete files you don't need, then retry.`,
    retryable: false,
  });
