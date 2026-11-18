// A Cloudflare Orb that dx stopped without saving its latest files (#1620).
// Its snapshots kept failing (a filesystem no snapshot can read, such as one
// whose btrfs metadata is full), so the Orb container object stopped it on
// its last good save instead of letting it run, and bill, indefinitely; an
// archive whose snapshot fails does the same. One never saved at all is
// stopped too, after an hour of failures, and starts over from the image
// with only the copy of its git work (#1687). The next activation learns it
// from the object's open, and that turn's agent tells the person what was
// kept and what is gone.

import type { ThreadId } from "@dx/domain";
import type { UnsavedStop } from "../execution/cloudflare/orb-container.js";
import { UNSAVED_WORK_MAX_BYTES } from "../execution/unsaved-work-script.js";
import { type RestoredWork, savedAtText } from "./read-only.js";

export const WORKSPACE_UNSAVED_STOP_SIGNAL = "workspace_unsaved_stop";

/** The stop, and where the copied-out work went in this Orb and Thread. */
export type ToldUnsavedStop = UnsavedStop & {
  readonly restored?: RestoredWork;
};

const mb = (bytes: number | undefined) =>
  bytes === undefined || bytes <= 0
    ? "too large"
    : `${String(Math.ceil(bytes / 1024 / 1024))} MB`;

const at = (time: number) =>
  `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** What a never-saved Orb's stop loses whatever the copy held (#1687). */
const NEVER_SAVED_LOST =
  "gitignored files (such as a .env, node_modules, and build output), files outside git checkouts, installed tools and global packages, and shell history";

const RESTORE_STEPS =
  "extract it in ~/workspace, where each checkout's part sits at that checkout's path, then in each checkout apply .dx-recovered/unpushed.patch with `git am` and .dx-recovered/uncommitted.patch with `git apply --3way`, and resolve any conflict; .dx-recovered/status.txt lists what had changed";

/**
 * The note for an Orb that had no save at all (#1687): it was started over
 * from the image, its repositories cloned again, and only the copy of its
 * git work survives.
 */
const neverSavedNote = (stop: ToldUnsavedStop) => {
  const stopped = `dx could not save this Orb's files (${String(stop.failures)} snapshots failed in a row over at least an hour), and it had never been saved, so dx stopped it at ${at(stop.stoppedAt)} instead of leaving it running. The Orb was started over from the image and its repositories were cloned again; running processes were stopped. Lost for good: ${NEVER_SAVED_LOST}.`;
  const restored = stop.restored;
  const rescue = stop.rescue;
  if (
    restored !== undefined &&
    rescue !== undefined &&
    restored.orbPath !== undefined
  )
    return `${stopped} Before stopping it, dx copied the git work of ${String(rescue.checkouts)} checkout${rescue.checkouts === 1 ? "" : "s"} under ~/workspace (${String(rescue.changes)} changed or untracked paths, ${String(rescue.commits)} commits on no remote) into ${restored.name}, now at ${restored.orbPath} in this Orb.${
      rescue.untracked
        ? ""
        : ` Its untracked files did not fit (${mb(rescue.fullBytes)} compressed, over dx's ${mb(UNSAVED_WORK_MAX_BYTES)} limit), so they are lost too; only commits and changes to tracked files are in it.`
    } Restore it before other work: ${RESTORE_STEPS}. Begin your final reply to the people in the Thread, the text after any tool calls, with this sentence: "dx couldn't save this Orb, so it stopped it at ${at(stop.stoppedAt)} and started it over; it had never been saved, so only your git work was copied out, and I've restored it." Then tell them in plain words which of the lost kinds of files above this Thread had, and continue with the request below.`;
  const lost =
    rescue !== undefined
      ? "dx copied the git work out before stopping it, but could not put the copy back yet; it tries again at the next turn. Until then, uncommitted changes and unpushed commits are missing here."
      : stop.rescueFailed !== undefined
        ? `dx tried to copy the git work out first, but ${stop.rescueFailed}, so uncommitted changes, untracked files, and unpushed commits are lost too.`
        : "No checkout under ~/workspace had uncommitted or unpushed changes, so no git work was lost.";
  return `${stopped} ${lost} Begin your final reply to the people in the Thread, the text after any tool calls, with this sentence: "dx couldn't save this Orb, so it stopped it at ${at(stop.stoppedAt)} and started it over; it had never been saved, so ${rescue !== undefined ? "everything but your git work is gone, and I'll restore that copy next turn" : stop.rescueFailed !== undefined ? "its files, uncommitted git work included, are gone" : "files outside git are gone, but no git work was lost"}." Then check the checkout (\`git status\`, \`git log\` against the remote) for work that needs redoing, and continue with the request below.`;
};

/** The note for the turn that runs on the restored Orb. */
export const unsavedStopNote = (stop: ToldUnsavedStop) => {
  if (stop.neverSaved === true) return neverSavedNote(stop);
  const kept =
    stop.savedAt === undefined
      ? "its last save"
      : `its last save${savedAtText(stop.savedAt)}`;
  const stopped = `dx could not save this Orb's files (${String(stop.failures)} snapshots failed in a row), so it stopped the Orb at ${at(stop.stoppedAt)} instead of leaving it running. The Orb restarted from ${kept}, and running processes were stopped.`;
  const restored = stop.restored;
  const rescue = stop.rescue;
  if (
    restored !== undefined &&
    rescue !== undefined &&
    restored.orbPath !== undefined
  )
    return `${stopped} Before stopping it, dx copied the unsaved work of ${String(rescue.checkouts)} checkout${rescue.checkouts === 1 ? "" : "s"} under ~/workspace (${String(rescue.changes)} changed or untracked paths, ${String(rescue.commits)} commits on no remote) into ${restored.name}, now at ${restored.orbPath} in this Orb.${
      rescue.untracked
        ? ""
        : ` Its untracked files did not fit: with them the copy was ${mb(rescue.fullBytes)} compressed, over dx's ${mb(UNSAVED_WORK_MAX_BYTES)} limit, so only commits and changes to tracked files are in it, and untracked files changed after the save are lost.`
    } Restore it before other work: ${RESTORE_STEPS}. Begin your final reply to the people in the Thread, the text after any tool calls, with this sentence: "dx couldn't save this Orb, so it stopped it at ${at(stop.stoppedAt)} and restarted it from ${kept}; your unsaved work was copied out first, and I've restored it." Then continue with the request below.`;
  const lost =
    rescue !== undefined
      ? `dx copied the unsaved work out before stopping it, but could not put the copy back yet; it tries again at the next turn. Until then, files changed after that save are missing here.`
      : stop.rescueFailed !== undefined
        ? `dx tried to copy the unsaved work out first, but ${stop.rescueFailed}, so files changed after that save are lost.`
        : "No checkout under ~/workspace had uncommitted or unpushed changes, so no git work was lost; other files changed after that save are gone.";
  return `${stopped} ${lost} Begin your final reply to the people in the Thread, the text after any tool calls, with this sentence: "dx couldn't save this Orb, so it stopped it at ${at(stop.stoppedAt)}; files are as of ${kept}, and later changes were lost${rescue !== undefined ? " until dx restores its copy" : ""}." Then check the checkout (\`git status\`, \`git log\` against the remote) for work that needs redoing, and continue with the request below.`;
};

/**
 * The unsaved stop each Thread's activation learned in this isolate, for the
 * turn that activation starts. Taken once.
 */
const stops = new Map<string, ToldUnsavedStop>();

export const rememberUnsavedStop = (
  threadId: ThreadId | string,
  stop: ToldUnsavedStop,
) => {
  stops.set(threadId, stop);
};

export const takeUnsavedStop = (threadId: ThreadId | string) => {
  const stop = stops.get(threadId);
  stops.delete(threadId);
  return stop;
};
