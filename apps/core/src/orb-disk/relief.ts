// Caches the Orb container object cleared between commands while the disk
// ran critically low (#1649). The heartbeat cannot reach the agent, so the
// next activation learns it from the object's open, and that turn's agent
// tells the person what dx freed.

import type { ThreadId } from "@dx/domain";
import type { DiskRelief } from "../execution/cloudflare/orb-container.js";

export const WORKSPACE_DISK_RELIEF_SIGNAL = "workspace_disk_relief";

const size = (kib: number) =>
  kib >= 1024 * 1024
    ? `${(kib / 1024 / 1024).toFixed(1)} GB`
    : `${String(Math.max(1, Math.round(kib / 1024)))} MB`;

const at = (time: number) =>
  `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The note for the turn after the clear. */
export const diskReliefNote = (relief: DiskRelief) =>
  `At ${at(relief.at)} this Orb's disk had only ${size(relief.beforeKiB)} left for new files, so dx cleared package-manager caches it can rebuild, between commands: ${relief.paths.map((path) => path.replace(/^\/home\/user/, "~")).join(", ")}. It now has ${size(relief.afterKiB)} free. The next install downloads what it needs again. dx deleted nothing else: no repository files, untracked work, or other caches. Tell the person in one sentence what dx cleared and why. If the disk keeps filling, find what grows (du -xh -d 2 ~ 2>/dev/null | sort -h | tail -n 20) before a large install or build.`;

const reliefs = new Map<string, DiskRelief>();

export const rememberDiskRelief = (
  threadId: ThreadId | string,
  relief: DiskRelief,
) => {
  reliefs.set(threadId, relief);
};

export const takeDiskRelief = (threadId: ThreadId | string) => {
  const relief = reliefs.get(threadId);
  reliefs.delete(threadId);
  return relief;
};
