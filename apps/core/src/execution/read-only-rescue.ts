import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger } from "../logging.js";
import type { RestoredWork } from "../orb-disk/read-only.js";
import type { ExecutionGuest } from "../plugins/execution/provider.js";
import { SOURCE_WORKSPACE_CWD } from "../source-control/source-workspace.js";
import { putThreadStorageFile } from "../thread-storage/store.js";

/**
 * Before dx restarts an Orb whose disk turned read-only, it copies the
 * person's unsaved work out of the checkout, which a read-only disk still
 * lets it read: the repository's untracked files, `uncommitted.patch`
 * (`git diff HEAD`) and `unpushed.patch` (commits on no remote), with
 * `git status`. The archive is built in `/dev/shm`, the one writable place
 * left, and read back in base64 chunks. A restart that cannot keep the
 * Orb's files restores this archive into the new Orb and Thread storage.
 */

/** `/dev/shm` holds 64 MB on a Cloudflare Orb; leave it room. */
export const RESCUE_MAX_BYTES = 48 * 1024 * 1024;
/** Raw bytes per read: about 5.3 MB of base64, under the 8 MB exec output. */
const CHUNK_MIB = 4;
const COMMAND_TIMEOUT_MS = 60_000;

export type UnsavedWorkRescue =
  | { readonly kind: "none" }
  | {
      readonly kind: "archive";
      readonly bytes: Uint8Array;
      readonly changes: number;
      readonly commits: number;
    }
  | { readonly kind: "failed"; readonly reason: string };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const BUILD = `set -eu
cd ${quote(SOURCE_WORKSPACE_CWD)} 2>/dev/null || { echo none; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo none; exit 0; }
t=$(mktemp -d /dev/shm/dx-rescue.XXXXXX)
mkdir "$t/.dx-recovered"
git -c core.quotepath=off status --porcelain=v1 > "$t/.dx-recovered/status.txt"
git diff HEAD --binary > "$t/.dx-recovered/uncommitted.patch" 2>/dev/null || git diff --binary > "$t/.dx-recovered/uncommitted.patch"
git format-patch --stdout --branches --not --remotes > "$t/.dx-recovered/unpushed.patch" 2>/dev/null || :
git ls-files -z -o --exclude-standard > "$t/untracked"
changes=$(wc -l < "$t/.dx-recovered/status.txt")
commits=$(grep -c '^From [0-9a-f]\\{40\\} ' "$t/.dx-recovered/unpushed.patch" || :)
if [ "$changes" -eq 0 ] && [ "\${commits:-0}" -eq 0 ]; then rm -rf "$t"; echo none; exit 0; fi
tar czf "$t/archive.tar.gz" --null -T "$t/untracked" -C "$t" .dx-recovered
echo "archive $t $(stat -c %s "$t/archive.tar.gz") $changes \${commits:-0}"
`;

const decodeBase64 = (text: string) => {
  const binary = atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const run = async (guest: ExecutionGuest, command: string) => {
  const result = await guest.commands.run(command, {
    cwd: "/home/user",
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if ((result.exitCode ?? 0) !== 0)
    throw new Error(
      (result.stderr ?? "").trim().slice(-300) || `exit ${result.exitCode}`,
    );
  return result.stdout ?? "";
};

/** Copies the checkout's unsaved work out of a read-only Orb. */
export const rescueUnsavedWork = async (
  guest: ExecutionGuest,
): Promise<UnsavedWorkRescue> => {
  let directory: string | undefined;
  try {
    const built = (await run(guest, BUILD)).trim().split(/\s+/);
    if (built[0] === "none") return { kind: "none" };
    if (built[0] !== "archive" || built.length !== 5)
      return { kind: "failed", reason: "the copy did not finish" };
    directory = built[1] ?? "";
    if (!/^\/dev\/shm\/dx-rescue\.[A-Za-z0-9]+$/.test(directory))
      return { kind: "failed", reason: "the copy did not finish" };
    const size = Number(built[2]);
    if (!Number.isSafeInteger(size) || size <= 0)
      return { kind: "failed", reason: "the copy did not finish" };
    if (size > RESCUE_MAX_BYTES)
      return {
        kind: "failed",
        reason: `the unsaved work is ${Math.ceil(size / 1024 / 1024)} MB compressed, more than dx can copy`,
      };
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let chunk = 0; offset < size; chunk += 1) {
      const part = decodeBase64(
        await run(
          guest,
          `dd if=${quote(`${directory}/archive.tar.gz`)} bs=1M skip=${chunk * CHUNK_MIB} count=${CHUNK_MIB} status=none | base64 -w0`,
        ),
      );
      if (part.byteLength === 0 || offset + part.byteLength > size)
        return { kind: "failed", reason: "the copy came back incomplete" };
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return {
      kind: "archive",
      bytes,
      changes: Number(built[3]) || 0,
      commits: Number(built[4]) || 0,
    };
  } catch (cause) {
    return {
      kind: "failed",
      reason: `copying it failed (${cause instanceof Error ? cause.message.slice(0, 200) : "unknown error"})`,
    };
  } finally {
    if (directory !== undefined)
      await guest.commands
        .run(`rm -rf -- ${quote(directory)}`, { timeoutMs: 10_000 })
        .catch(() => undefined);
  }
};

/**
 * Puts the rescued archive in the restarted Orb and in Thread storage, so
 * neither a lost write nor the next restart loses it.
 */
export const restoreUnsavedWork = async (
  bindings: Bindings,
  threadId: string,
  guest: ExecutionGuest,
  rescue: Extract<UnsavedWorkRescue, { kind: "archive" }>,
  now = new Date(),
): Promise<RestoredWork> => {
  const name = `dx-recovered-${now.toISOString().slice(0, 19).replaceAll(":", "-")}.tar.gz`;
  const orbPath = `/home/user/dx-recovered/${name}`;
  const [inOrb, inStorage] = await Promise.allSettled([
    guest.files.write(
      orbPath,
      rescue.bytes.buffer.slice(
        rescue.bytes.byteOffset,
        rescue.bytes.byteOffset + rescue.bytes.byteLength,
      ) as ArrayBuffer,
    ),
    putThreadStorageFile(bindings, {
      threadId,
      name,
      mimeType: "application/gzip",
      bytes: rescue.bytes,
    }),
  ]);
  for (const [where, outcome] of [
    ["orb", inOrb],
    ["storage", inStorage],
  ] as const)
    if (outcome.status === "rejected")
      executionWorkspaceLogger.error("Rescued work could not be stored.", {
        event: "workspace_read_only_rescue",
        threadId,
        where,
        outcome: "error",
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message.slice(0, 300)
            : "failed",
      });
  return {
    name,
    changes: rescue.changes,
    commits: rescue.commits,
    ...(inOrb.status === "fulfilled" ? { orbPath } : {}),
    ...(inStorage.status === "fulfilled"
      ? { storageFileId: inStorage.value }
      : {}),
  };
};
