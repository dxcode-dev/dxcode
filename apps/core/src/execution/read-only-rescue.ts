import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger } from "../logging.js";
import type { RestoredWork } from "../orb-disk/read-only.js";
import type { ExecutionGuest } from "../plugins/execution/provider.js";
import { putThreadStorageFile } from "../thread-storage/store.js";
import {
  parseUnsavedWork,
  UNSAVED_WORK_MAX_BYTES,
  unsavedWorkScript,
} from "./unsaved-work-script.js";

/**
 * Before dx restarts an Orb whose disk turned read-only, or any restart
 * that cannot keep its files, it copies the person's unsaved work out, which
 * a read-only disk still lets it read: for every git checkout under
 * ~/workspace (the repository, its worktrees, additional repositories,
 * #1658), its untracked files, `uncommitted.patch` (`git diff HEAD`),
 * `unpushed.patch` (commits on no remote), and `git status`, at the
 * checkout's path in the archive (unsaved-work-script.ts). The archive is built in `/dev/shm`, the one writable place
 * left, and read back in base64 chunks. A restart that cannot keep the
 * Orb's files restores this archive into the new Orb and Thread storage.
 */

/** `/dev/shm` holds 64 MB on a Cloudflare Orb; leave it room. */
export const RESCUE_MAX_BYTES = UNSAVED_WORK_MAX_BYTES;
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
      /** Checkouts with unsaved work; unset from a caller before #1658. */
      readonly checkouts?: number;
      /** False when untracked files did not fit and were left out. */
      readonly untracked?: boolean;
    }
  | { readonly kind: "failed"; readonly reason: string };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  /** The workspace root; tests pass a temporary one. */
  root = "/home/user/workspace",
): Promise<UnsavedWorkRescue> => {
  let directory: string | undefined;
  try {
    const built = parseUnsavedWork(await run(guest, unsavedWorkScript(root)));
    if (built.kind !== "archive") return built;
    directory = built.directory;
    const size = built.size;
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
      changes: built.changes,
      commits: built.commits,
      checkouts: built.checkouts,
      untracked: built.untracked,
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
  /**
   * Also keep it in Thread storage, which everyone who can read the Thread
   * can list and read, and which outlives the Orb. Off for a copy that may
   * hold untracked files such as a `.env`: the Orb alone keeps it, with the
   * same audience as the files it copies.
   */
  threadStorage = true,
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
    threadStorage
      ? putThreadStorageFile(bindings, {
          threadId,
          name,
          mimeType: "application/gzip",
          bytes: rescue.bytes,
        })
      : Promise.reject(new Error("not kept in Thread storage")),
  ]);
  for (const [where, outcome] of [
    ["orb", inOrb],
    ["storage", inStorage],
  ] as const)
    if (outcome.status === "rejected" && (threadStorage || where === "orb"))
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
