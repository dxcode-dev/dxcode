// The shell dx uses to read an Orb's free space and clear what it may clear
// (#1614, #1649). Shared by the activation and Claude Code launch guard
// (orb-disk/guard.ts) and the Orb container object's heartbeat; kept free of
// Core imports so the Orb Worker bundles it too. `home` is the Orb user's
// home; tests pass a temporary one.
//
// dx clears only what any package manager rebuilds on demand and its own
// leftovers: never the user's checkout, untracked work, or other files.

const KIB = 1_024;
const MIB = 1_024 * KIB;

/** Package-manager caches and stores under the Orb user's home. */
export const diskCaches = (home: string) =>
  [
    ".local/share/pnpm/store",
    ".pnpm-store",
    ".cache/pnpm",
    ".npm/_cacache",
    ".cache/yarn",
    ".yarn/berry/cache",
    ".bun/install/cache",
    ".cache/pip",
    ".cache/uv",
    ".cache/go-build",
    ".cargo/registry/cache",
  ].map((path) => `${home}/${path}`);

/** dx's own files a full disk may lose: its reserve and leftovers. */
const dxLeftovers = (
  home: string,
) => `rm -f ${home}/.local/state/dx-disk-reserve ${home}/.local/state/dx-disk-reserve.tmp 2>/dev/null || true
  for dx_disk_run in ${home}/.local/state/dx-claude-code/runs/*/; do
    if [ -f "$dx_disk_run/exit" ]; then rm -rf "$dx_disk_run" 2>/dev/null || true; fi
  done
  rm -rf ${home}/.local/share/dx/skills.stage.* ${home}/.local/share/dx/skills.old.* ${home}/.local/state/dxd/trash 2>/dev/null || true`;

/**
 * Shell functions. `dx_disk_kib` is the free space in KiB: `df`'s, or less on
 * btrfs when metadata is nearly out (its unused allocation plus unallocated
 * device space at its profile's ratio): a Cloudflare Orb keeps small files
 * in metadata, and once it runs out every new file fails while `df` still
 * reports gigabytes free. `dx_disk_clean` removes dx's leftovers, the
 * caches, and the Orb user's regular files in /tmp, then waits (up to 5 s)
 * for the freed space to show; it never fails.
 */
export const diskShellFunctions = (
  home: string,
  startKiB = (16 * MIB) / KIB,
) => `dx_disk_kib() {
  dx_df="$(df -Pk ${home} 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$dx_df" ] || return 0
  dx_fs="$(findmnt -no FSTYPE,UUID -T ${home} 2>/dev/null)"
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
  ${dxLeftovers(home)}
  rm -rf ${diskCaches(home).join(" ")} 2>/dev/null || true
  find /tmp -xdev -mindepth 1 -user "$(id -u)" -type f -delete 2>/dev/null || true
  dx_disk_wait=0
  while [ "$dx_disk_wait" -lt 25 ] && [ "$(dx_disk_kib)" -lt ${startKiB} ]; do
    sync -f ${home} 2>/dev/null || true
    sleep 0.2
    dx_disk_wait=$((dx_disk_wait + 1))
  done
}
`;

/** The heartbeat clears only below this much free space. */
export const DISK_RELIEF_BELOW_BYTES = 64 * MIB;

/**
 * The Orb container object's check between commands (#1649). Below
 * `belowKiB` free, it clears dx's leftovers and the package-manager caches,
 * but never while something may be using them: a dx shell command that is
 * still running, or any package manager or build tool that reads those
 * caches (an install, fetch, or build half-way through would break; a dev
 * server or test run does not hold them). It leaves /tmp alone:
 * running programs keep files there. Its one line of output:
 *   dx-relief ok <free KiB>
 *   dx-relief busy <what> <free KiB>        deferred to a later check
 *   dx-relief nothing <free KiB>            no cache left to clear
 *   dx-relief cleaned <before KiB> <after KiB> <path>...
 */
export const diskReliefScript = (
  home = "/home/user",
  belowKiB = DISK_RELIEF_BELOW_BYTES / KIB,
  /**
   * Tests only: consider just the processes whose command line contains
   * this, so other tests running beside them do not count. An Orb checks
   * every process.
   */
  onlyProcessesWith = "",
) => `# dx_relief_self_7f3a: this script's own processes skip themselves.
${diskShellFunctions(home)}dx_free="$(dx_disk_kib)"
[ -n "$dx_free" ] || { echo "dx-relief ok 0"; exit 0; }
[ "$dx_free" -lt ${belowKiB} ] || { echo "dx-relief ok $dx_free"; exit 0; }
for dx_s in ${home}/.local/state/dx-shell/start.*/; do
  [ -f "$dx_s/pid" ] && [ ! -f "$dx_s/exit" ] && kill -0 "$(cat "$dx_s/pid" 2>/dev/null)" 2>/dev/null && { echo "dx-relief busy shell-command $dx_free"; exit 0; }
done
# Commands that read or write those caches: installs, fetches, and builds.
# A dev server or a test run (\`pnpm dev\`, \`pnpm exec vitest\`) does not.
dx_users='[ /](pnpm|npm|yarn|bun)(.c?js|-cli.js)? +(i|install|add|ci|update|up|upgrade|fetch|import|rebuild|dlx|store|link|unlink|remove|rm|uninstall)( |$)|[ /](npx|bunx|pnpx)( |$)|[ /](pip|pip3)( +[^ ]+)* +(install|download|wheel)( |$)|[ /]uv +(pip|sync|add|lock|tool|run)( |$)|[ /]cargo +(build|b|check|c|fetch|install|update|run|r|test|t|bench|doc|vendor)( |$)|[ /]go +(build|get|install|mod|run|test|vet|generate)( |$)'
for dx_p in /proc/[0-9]*; do
  dx_pid=\${dx_p#/proc/}
  [ "$dx_pid" = "$$" ] && continue
  dx_cmd="$(tr '\\0' ' ' < "$dx_p/cmdline" 2>/dev/null)"
  case "$dx_cmd" in *dx_relief_self_7f3a*|"") continue ;; esac
  case "$dx_cmd" in *"${onlyProcessesWith}"*) ;; *) continue ;; esac
  if printf '%s' " $dx_cmd" | grep -Eq "$dx_users"; then
    echo "dx-relief busy $(printf '%s' "$dx_cmd" | cut -c1-60 | tr ' ' '_') $dx_free"; exit 0
  fi
done
dx_present=""
for dx_c in ${diskCaches(home).join(" ")}; do [ -e "$dx_c" ] && dx_present="$dx_present $dx_c"; done
[ -n "$dx_present" ] || { echo "dx-relief nothing $dx_free"; exit 0; }
${dxLeftovers(home)}
rm -rf $dx_present 2>/dev/null || true
sync -f ${home} 2>/dev/null || true
echo "dx-relief cleaned $dx_free $(dx_disk_kib)$dx_present"
`;

export type DiskRelief =
  | { readonly kind: "ok" | "nothing"; readonly freeKiB: number }
  | { readonly kind: "busy"; readonly what: string; readonly freeKiB: number }
  | {
      readonly kind: "cleaned";
      readonly beforeKiB: number;
      readonly afterKiB: number;
      readonly paths: ReadonlyArray<string>;
    };

/** The script's line, read; undefined when it did not run to the end. */
export const parseDiskRelief = (stdout: string): DiskRelief | undefined => {
  const line = stdout
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("dx-relief "));
  if (line === undefined) return undefined;
  const parts = line.trim().split(/\s+/);
  const number = (value: string | undefined) => Number(value) || 0;
  switch (parts[1]) {
    case "ok":
    case "nothing":
      return { kind: parts[1], freeKiB: number(parts[2]) };
    case "busy":
      return { kind: "busy", what: parts[2] ?? "", freeKiB: number(parts[3]) };
    case "cleaned":
      return {
        kind: "cleaned",
        beforeKiB: number(parts[2]),
        afterKiB: number(parts[3]),
        paths: parts.slice(4),
      };
    default:
      return undefined;
  }
};
