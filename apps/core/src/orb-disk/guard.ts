// A full Orb disk must never stop a Thread for good. Every activation and
// every Claude Code launch runs this guard first, before anything dx writes:
//
// - The first activation with room to spare writes a 256 MB dx-owned reserve
//   file. A disk that later fills up completely gets that space back.
// - A disk with less than 64 MB free loses the reserve, dx's own leftovers
//   (settled Claude Code runs, interrupted installs), and the caches below,
//   so setup and the agent can start and the agent can free space itself.
//   The next activation with room writes the reserve again.
// - Free space is the smaller of what `df` reports and, on btrfs (Cloudflare
//   Orbs), the room left for metadata: small files such as a pnpm store and
//   node_modules live in metadata, and once it runs out every write fails,
//   even `rm`, while `df` still reports gigabytes free. Freeing space then
//   takes a restart, so the guard frees caches while it still can.
//
// What dx clears is only what any package manager rebuilds on demand, plus
// temporary files: never the user's checkout or anything else under home.
//
// The guard prints one `dx-disk <total KiB> <available KiB> <full>` line to
// stderr; `full` says it had to free space. Core reads it to tell the agent
// (see note.ts). When a write still fails, Core runs the cleanup once more
// on its own (workspaceDiskCleanup) and retries, and a disk that is still
// full starts the turn in recovery mode (see recovery.ts).

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
/** The user's checkout (SOURCE_WORKSPACE_CWD); never touched here. */
const SOURCE_CHECKOUT_PATH = "/home/user/workspace/repo";

/** The guard's reading of the workspace filesystem (the one holding home). */
export interface WorkspaceDiskReading {
  readonly totalBytes: number;
  readonly availableBytes: number;
  /** The disk was (nearly) full and the guard freed dx's space. */
  readonly full: boolean;
  /**
   * Set by Core after a write failed for lack of space: `cleaned` when its
   * cleanup made room and the retry worked, `recovery` when the disk stayed
   * full and the turn started without preparing the checkout.
   */
  readonly after?: "cleaned" | "recovery";
}

/**
 * Package-manager caches and temporary files under the Orb user's home and
 * /tmp. Each is rebuilt on demand; none holds work. Exported for the tests
 * that check nothing else is ever removed.
 */
export const WORKSPACE_DISK_CACHES = [
  "/home/user/.local/share/pnpm/store",
  "/home/user/.pnpm-store",
  "/home/user/.cache/pnpm",
  "/home/user/.npm/_cacache",
  "/home/user/.cache/yarn",
  "/home/user/.yarn/berry/cache",
  "/home/user/.bun/install/cache",
  "/home/user/.cache/pip",
  "/home/user/.cache/uv",
  "/home/user/.cache/go-build",
  "/home/user/.cargo/registry/cache",
] as const;

/**
 * Shell functions the guard and the cleanup share. `dx_disk_kib` is the free
 * space in KiB: `df`'s, or less on btrfs when metadata is nearly out (its
 * unused allocation plus unallocated device space at its profile's ratio).
 * `dx_disk_clean` removes dx's reserve and leftovers, the caches, and the
 * Orb user's regular files in /tmp (not sockets, not other users' files);
 * it never fails.
 */
const diskFunctions = `dx_disk_kib() {
  dx_df="$(df -Pk /home/user 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$dx_df" ] || return 0
  dx_fs="$(findmnt -no FSTYPE,UUID -T /home/user 2>/dev/null)"
  case "$dx_fs" in
    btrfs\\ *)
      dx_b="/sys/fs/btrfs/\${dx_fs#btrfs }"
      if [ -r "$dx_b/allocation/metadata/total_bytes" ]; then
        dx_dev=0
        for dx_d in "$dx_b"/devices/*; do
          dx_dev=$((dx_dev + $(cat "$dx_d/size" 2>/dev/null || echo 0) * 512))
        done
        dx_meta="$(awk -v dev="$dx_dev" 'FNR==1 {v[FILENAME]=$1} END {
          m="'"$dx_b"'/allocation/metadata/"; d="'"$dx_b"'/allocation/data/"; s="'"$dx_b"'/allocation/system/"
          alloc=v[m "disk_total"]+v[d "disk_total"]+v[s "disk_total"]
          unalloc=dev-alloc; if (unalloc<0) unalloc=0
          ratio=(v[m "total_bytes"]>0)?v[m "disk_total"]/v[m "total_bytes"]:1; if (ratio<1) ratio=1
          free=v[m "total_bytes"]-v[m "bytes_used"]-v[m "bytes_reserved"]+unalloc/ratio
          if (free<0) free=0; printf "%d", free/1024 }' \\
          "$dx_b/allocation/metadata/total_bytes" "$dx_b/allocation/metadata/bytes_used" "$dx_b/allocation/metadata/bytes_reserved" "$dx_b/allocation/metadata/disk_total" \\
          "$dx_b/allocation/data/disk_total" "$dx_b/allocation/system/disk_total" 2>/dev/null)"
        if [ -n "$dx_meta" ] && [ "$dx_dev" -gt 0 ] && [ "$dx_meta" -lt "$dx_df" ]; then dx_df="$dx_meta"; fi
      fi
      ;;
  esac
  echo "$dx_df"
}
dx_disk_clean() {
  rm -f ${WORKSPACE_DISK_RESERVE_PATH} ${WORKSPACE_DISK_RESERVE_PATH}.tmp 2>/dev/null || true
  for dx_disk_run in /home/user/.local/state/dx-claude-code/runs/*/; do
    if [ -f "$dx_disk_run/exit" ]; then rm -rf "$dx_disk_run" 2>/dev/null || true; fi
  done
  rm -rf /home/user/.local/share/dx/skills.stage.* /home/user/.local/share/dx/skills.old.* /home/user/.local/state/dxd/trash 2>/dev/null || true
  rm -rf ${WORKSPACE_DISK_CACHES.join(" ")} 2>/dev/null || true
  find /tmp -xdev -mindepth 1 -user "$(id -u)" -type f -delete 2>/dev/null || true
  # A Cloudflare Orb's filesystem returns deleted blocks a moment later, so
  # the reading waits (up to 5 s) for the freed space instead of reporting
  # the disk as still full.
  dx_disk_wait=0
  while [ "$dx_disk_wait" -lt 25 ] && [ "$(dx_disk_kib)" -lt ${START_BYTES / KIB} ]; do
    sync -f /home/user 2>/dev/null || true
    sleep 0.2
    dx_disk_wait=$((dx_disk_wait + 1))
  done
}
`;

const reading = (full: string) =>
  `df -Pk /home/user 2>/dev/null | awk -v full="${full}" -v avail="$(dx_disk_kib)" 'NR==2 {print "dx-disk", $2, avail, full}' >&2
`;

/**
 * POSIX shell for the start of a guest command. It never fails the command,
 * even under `set -e`, and leaves `dx_disk_full` set to 1 when it freed space;
 * `reserve` is false for the local runtime, whose home is a developer's disk.
 */
export const workspaceDiskGuard = (reserve: boolean) =>
  `${diskFunctions}dx_disk_full=0
dx_disk_free="$(dx_disk_kib)"
if [ -n "$dx_disk_free" ] && [ "$dx_disk_free" -lt ${RELEASE_BELOW_BYTES / KIB} ]; then
  dx_disk_full=1
  dx_disk_clean
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
${reading("$dx_disk_full")}`;

/**
 * Core's cleanup after a write failed for lack of space, whatever the guard
 * read before: everything the guard frees, then its reading (always `full`).
 * The second line says whether the user's checkout exists, so a recovery
 * mode turn starts there.
 */
export const workspaceDiskCleanup = () =>
  `${diskFunctions}dx_disk_clean
${reading("1")}if [ -d ${SOURCE_CHECKOUT_PATH}/.git ]; then echo dx-checkout >&2; fi
`;

/** The cleanup's stderr says the user's checkout is there. */
export const cleanupFoundCheckout = (stderr: string) =>
  /^dx-checkout$/m.test(stderr);

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
