// The shell that copies a person's unsaved work out of an Orb that dx is
// about to restart or stop without a save of its latest files (#1620, and a
// read-only Orb's restart). It needs no writable disk: the archive is built
// in /dev/shm. Kept free of Core imports so the Orb Worker bundles it too.
//
// Every git checkout under ~/workspace (the Thread's repository, its
// worktrees, additional repositories) gets, at its path relative to
// ~/workspace inside the archive:
//   .dx-recovered/status.txt         `git status --porcelain`
//   .dx-recovered/uncommitted.patch  `git diff HEAD --binary`
//   .dx-recovered/unpushed.patch     commits on no remote (`git am`)
//   its untracked files              (left out when the archive is too big)
// Gitignored files (caches, build output, most secrets) are never copied.
// Prints `none`, or `archive <dir> <bytes> <changes> <commits> <checkouts>
// <untracked:1|0> <full bytes>`, where <full bytes> is the size with the
// untracked files, when they were left out; `<dir>/archive.tar.gz` is it.

/** `/dev/shm` holds 64 MB on a Cloudflare Orb; leave it room. */
export const UNSAVED_WORK_MAX_BYTES = 48 * 1024 * 1024;

export const UNSAVED_WORK_SCRIPT = `set -u
root=/home/user/workspace
[ -d "$root" ] || { echo none; exit 0; }
t=$(mktemp -d /dev/shm/dx-rescue.XXXXXX) || { echo failed; exit 0; }
build() {
  with_untracked=$1
  rm -rf "$t/tree" "$t/archive.tar" "$t/archive.tar.gz"
  mkdir -p "$t/tree"
  : > "$t/archive.tar"
  changes=0; commits=0; checkouts=0
  for git in $(find "$root" -mindepth 2 -maxdepth 4 -name .git -not -path '*/node_modules/*' 2>/dev/null | sort); do
    d=\${git%/.git}
    rel=\${d#"$root"/}
    git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || continue
    out="$t/tree/$rel/.dx-recovered"
    mkdir -p "$out"
    git -C "$d" -c core.quotepath=off status --porcelain=v1 > "$out/status.txt" 2>/dev/null
    git -C "$d" diff HEAD --binary > "$out/uncommitted.patch" 2>/dev/null || git -C "$d" diff --binary > "$out/uncommitted.patch" 2>/dev/null
    git -C "$d" format-patch --stdout --branches --not --remotes > "$out/unpushed.patch" 2>/dev/null || :
    c=$(wc -l < "$out/status.txt")
    k=$(grep -c '^From [0-9a-f]\\{40\\} ' "$out/unpushed.patch" 2>/dev/null) || k=0
    if [ "$c" -eq 0 ] && [ "$k" -eq 0 ]; then rm -rf "$t/tree/$rel"; continue; fi
    changes=$((changes + c)); commits=$((commits + k)); checkouts=$((checkouts + 1))
    if [ "$with_untracked" = 1 ]; then
      git -C "$d" ls-files -z -o --exclude-standard > "$t/untracked" 2>/dev/null
      if [ -s "$t/untracked" ]; then
        tar rf "$t/archive.tar" -C "$d" --null -T "$t/untracked" --transform "s,^,$rel/," 2>/dev/null || :
      fi
    fi
  done
  [ "$checkouts" -gt 0 ] || return 1
  tar rf "$t/archive.tar" -C "$t/tree" . 2>/dev/null
  gzip -c "$t/archive.tar" > "$t/archive.tar.gz" && rm -f "$t/archive.tar"
}
if ! build 1; then rm -rf "$t"; echo none; exit 0; fi
untracked=1
size=$(stat -c %s "$t/archive.tar.gz" 2>/dev/null || echo 0)
full=$size
if [ "$size" -gt ${UNSAVED_WORK_MAX_BYTES} ] || [ "$size" -eq 0 ]; then
  untracked=0
  build 0 || :
  size=$(stat -c %s "$t/archive.tar.gz" 2>/dev/null || echo 0)
fi
echo "archive $t $size $changes $commits $checkouts $untracked $full"
`;

/** The script's last line, read. */
export const parseUnsavedWork = (stdout: string) => {
  const line = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (line === "none") return { kind: "none" as const };
  const parts = line.split(/\s+/);
  if (parts[0] !== "archive" || parts.length !== 8)
    return { kind: "failed" as const, reason: "the copy did not finish" };
  const [, directory = "", size, changes, commits, checkouts, untracked, full] =
    parts;
  if (!/^\/dev\/shm\/dx-rescue\.[A-Za-z0-9]+$/.test(directory))
    return { kind: "failed" as const, reason: "the copy did not finish" };
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    return { kind: "failed" as const, reason: "the copy did not finish" };
  if (bytes > UNSAVED_WORK_MAX_BYTES)
    return {
      kind: "failed" as const,
      reason: `the unsaved work is ${String(Math.ceil(bytes / 1024 / 1024))} MB compressed even without untracked files, more than dx can keep`,
    };
  return {
    kind: "archive" as const,
    directory,
    size: bytes,
    changes: Number(changes) || 0,
    commits: Number(commits) || 0,
    checkouts: Number(checkouts) || 0,
    untracked: untracked === "1",
    /** With the untracked files, when they did not fit. */
    ...(untracked === "1" ? {} : { fullBytes: Number(full) || 0 }),
  };
};
