// What the agent is told about its Orb's disk at the start of a turn. The
// dx agent and Claude Code both read it, as a `workspace_disk` signal ahead
// of the person's message, so the agent frees regenerable space before a
// large install or build fills the disk, and starts by freeing space when
// the disk was already full.

import type { ThreadId } from "@dx/domain";
import {
  formatDiskBytes,
  WORKSPACE_DISK_RESERVE_BYTES,
  type WorkspaceDiskReading,
} from "./guard.js";

/** From this share in use, every turn starts with a note. */
export const WORKSPACE_DISK_NOTE_PERCENT = 85;

export const WORKSPACE_DISK_SIGNAL = "workspace_disk";

const usedPercent = (reading: WorkspaceDiskReading) =>
  Math.floor(
    ((reading.totalBytes - reading.availableBytes) * 100) / reading.totalBytes,
  );

const HOW_TO_FREE = `Free regenerable space yourself; you do not need to ask first: build outputs and caches you can recreate, such as node_modules, target, dist, build, .next, .turbo, .cache, and package manager caches (npm, pnpm, yarn, pip, cargo). Find the largest folders with \`du -xh -d 2 ~ 2>/dev/null | sort -h | tail -n 20\`. Never delete source files, uncommitted work, or anything you cannot rebuild; ask the person if only those take the space.`;

/** The note for this reading, or undefined when the disk has room. */
export const workspaceDiskNote = (reading: WorkspaceDiskReading) => {
  const percent = usedPercent(reading);
  const usage = `${String(percent)}% full: ${formatDiskBytes(reading.availableBytes)} free of ${formatDiskBytes(reading.totalBytes)}`;
  if (reading.full)
    return `This Orb's disk filled up completely. dx freed its own ${formatDiskBytes(WORKSPACE_DISK_RESERVE_BYTES)} emergency reserve so this turn could start; the disk is now ${usage}. Before anything else, free space, or commands and file writes will fail with "No space left on device" again. ${HOW_TO_FREE} Then continue with the request below.`;
  if (percent < WORKSPACE_DISK_NOTE_PERCENT) return undefined;
  return `This Orb's disk is ${usage}, and it cannot grow. Before a large install, build, download, or test run, check that it fits; if it may not, free space first and then do the work. ${HOW_TO_FREE}`;
};

/**
 * The last guard reading of each Thread's activation in this isolate, for
 * the turn that activation starts. Taken once: a later turn without an
 * activation of its own gets no stale note.
 */
const readings = new Map<string, WorkspaceDiskReading>();

export const rememberWorkspaceDisk = (
  threadId: ThreadId | string,
  reading: WorkspaceDiskReading,
) => {
  readings.set(threadId, reading);
};

export const takeWorkspaceDisk = (threadId: ThreadId | string) => {
  const reading = readings.get(threadId);
  readings.delete(threadId);
  return reading;
};
