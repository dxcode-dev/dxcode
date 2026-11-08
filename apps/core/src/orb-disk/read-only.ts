// An Orb whose filesystem turned read-only fails every write, so every
// activation fails until the Orb restarts. Cloudflare Orbs run on a btrfs
// root in a Firecracker VM; btrfs forces itself read-only when a transaction
// aborts (memory exhaustion in the VM is one cause), and stays so until it
// is mounted again, which only a restart does.
//
// Activation names the failure WORKSPACE_READ_ONLY, restarts the Orb once
// through its provider (`recover`), and runs the turn on the restarted Orb.
// The turn starts with a note saying what the restart kept; when the restart
// is impossible or does not help, the run settles as `workspace_read_only`
// with what dx did, and the Thread shows it.

import type { ThreadId } from "@dx/domain";
import type { ExecutionWorkspaceRecovery } from "../plugins/execution/provider.js";
import { markRunFailure } from "../runtime/run-failure.js";

export const WORKSPACE_READ_ONLY_CODE = "WORKSPACE_READ_ONLY";

/** A write failed because the filesystem is read-only. */
export const isReadOnlyText = (text: string) =>
  /Read-only file system|\bEROFS\b/.test(text);

/**
 * WORKSPACE_READ_ONLY: not retried as it stands, since every retry writes
 * to the same disk; activation restarts the Orb instead.
 */
export const workspaceReadOnlyFailure = () =>
  markRunFailure({
    class: "internal",
    code: WORKSPACE_READ_ONLY_CODE,
    message: "The Orb's disk became read-only.",
    retryable: false,
  });

/** A failure carries the WORKSPACE_READ_ONLY stamp. */
export const isWorkspaceReadOnlyFailure = (cause: unknown) =>
  cause instanceof Error &&
  cause.message.includes(`:${WORKSPACE_READ_ONLY_CODE})`);

/** ` (2026-10-30 16:40 UTC)`, or nothing when the time is unknown. */
export const savedAtText = (savedAt: number | undefined) =>
  savedAt === undefined
    ? ""
    : ` (${new Date(savedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)`;

/** Where dx put the unsaved work it copied out before the restart. */
export interface RestoredWork {
  /** The archive's file name, in the Orb and in Thread storage. */
  readonly name: string;
  readonly orbPath?: string;
  readonly storageFileId?: string;
  /** Changed or untracked paths, and commits on no remote. */
  readonly changes: number;
  readonly commits: number;
}

/** A restart, and the copy of unsaved work it needed. */
export type WorkspaceRestart = ExecutionWorkspaceRecovery & {
  readonly restored?: RestoredWork;
  /** Why it restarted: a read-only disk, unless it stopped answering. */
  readonly cause?: "unresponsive";
};

/** What the restart kept, in a sentence for the person or the agent. */
export const workspaceRecoveryFiles = (recovery: ExecutionWorkspaceRecovery) =>
  recovery.files === "kept"
    ? "Its files were kept."
    : recovery.files === "earlier"
      ? `Its files are as they were at its last save${savedAtText(recovery.savedAt)}.`
      : "It could not be saved, so it started over from a fresh image and the repository was cloned again.";

const restoredText = (restored: RestoredWork) =>
  `Before restarting, dx copied the checkout's unsaved work (${restored.changes} changed or untracked paths, ${restored.commits} commits on no remote) into ${restored.name}${
    restored.orbPath === undefined ? "" : ` at ${restored.orbPath} in this Orb`
  }${
    restored.storageFileId === undefined
      ? ""
      : `${restored.orbPath === undefined ? "" : " and"} in the Thread's storage`
  }. Each checkout under ~/workspace that had unsaved work sits in it at its path there (repo/, a worktree's folder, repos/<name>/), with its untracked files, .dx-recovered/unpushed.patch (\`git am\`), .dx-recovered/uncommitted.patch (\`git apply --3way\`), and .dx-recovered/status.txt. Restore it before other work: extract it in ~/workspace, then in each checkout it holds, check out the branch it was on, apply the unpushed commits, then the uncommitted changes, and resolve any conflict.`;

export const WORKSPACE_RECOVERY_SIGNAL = "workspace_recovered";

/** The note for the turn that runs on the restarted Orb. */
export const workspaceRecoveryNote = (restart: WorkspaceRestart) =>
  restart.cause === "unresponsive"
    ? `This Orb stopped responding (every command hung, most likely from heavy processes overloading it), so dx restarted it before this turn. ${workspaceRecoveryFiles(restart)} Processes that were running in it, such as dev servers, test runs, and other background jobs, were stopped. Begin your final reply, the text after any tool calls, with this sentence: "The Orb stopped responding, so dx restarted it. Files are kept; running processes were stopped." Then continue with the request below, and avoid running several heavy jobs at once.`
    : `This Orb's disk became read-only, so every write failed. dx restarted the Orb before this turn. ${workspaceRecoveryFiles(restart)}${
        restart.restored === undefined
          ? ""
          : ` ${restoredText(restart.restored)}`
      } Tell the person in one sentence that dx restarted their Orb and what it kept${
        restart.restored === undefined ? "" : " and restored"
      }, then continue with the request below.`;

/**
 * The restart each Thread's activation made in this isolate, for the turn
 * that activation starts. Taken once, as the disk reading is.
 */
const recoveries = new Map<string, WorkspaceRestart>();

export const rememberWorkspaceRecovery = (
  threadId: ThreadId | string,
  restart: WorkspaceRestart,
) => {
  recoveries.set(threadId, restart);
};

export const takeWorkspaceRecovery = (threadId: ThreadId | string) => {
  const recovery = recoveries.get(threadId);
  recoveries.delete(threadId);
  return recovery;
};
