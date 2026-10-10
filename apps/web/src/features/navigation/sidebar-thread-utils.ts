import type { ProjectData, ThreadData } from "@dx/api";
import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";

export interface ThreadSection {
  readonly id: string;
  readonly label?: string;
  readonly project?: boolean;
  readonly threads: ReadonlyArray<ThreadData>;
}

const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1_000;

const byActivity = (left: ThreadData, right: ThreadData) =>
  right.lastActivityAt.epochMilliseconds -
    left.lastActivityAt.epochMilliseconds || right.id.localeCompare(left.id);

const byPin = (left: ThreadData, right: ThreadData) =>
  (right.pinnedAt?.epochMilliseconds ?? 0) -
    (left.pinnedAt?.epochMilliseconds ?? 0) || byActivity(left, right);

/**
 * Sidebar sections. Shared Threads the user follows sit with their own
 * Threads under the Thread's Project, named by the Project even when it is
 * another member's.
 */
export function buildThreadSections(
  projects: ReadonlyArray<ProjectData>,
  threads: ReadonlyArray<ThreadData>,
  now: number,
  archiveAvailable = false,
  sharedThreads: ReadonlyArray<ThreadData> = [],
): ReadonlyArray<ThreadSection> {
  const projectNames = new Map<string, string>(
    sharedThreads.flatMap((thread) =>
      thread.projectName === undefined
        ? []
        : [[thread.projectId, thread.projectName] as const],
    ),
  );
  for (const project of projects) projectNames.set(project.id, project.name);
  const pinned: Array<ThreadData> = [];
  const inactive: Array<ThreadData> = [];
  const archived: Array<ThreadData> = [];
  const groups = new Map<ThreadData["projectId"], Array<ThreadData>>();

  const owned = new Set(threads.map(({ id }) => id));
  for (const thread of [
    ...threads,
    ...sharedThreads.filter(({ id }) => !owned.has(id)),
  ].toSorted(byActivity)) {
    if (thread.lifecycleState === "archived") {
      archived.push(thread);
    } else if (thread.lifecycleState === "active") {
      if (thread.pinnedAt !== undefined) {
        pinned.push(thread);
      } else if (
        thread.activityStatus !== "working" &&
        now - thread.lastActivityAt.epochMilliseconds >= INACTIVE_AFTER_MS
      ) {
        inactive.push(thread);
      } else {
        const group = groups.get(thread.projectId) ?? [];
        group.push(thread);
        groups.set(thread.projectId, group);
      }
    }
  }
  pinned.sort(byPin);

  return [
    ...(pinned.length === 0 ? [] : [{ id: "pinned", threads: pinned }]),
    ...Array.from(groups, ([id, groupedThreads]) => ({
      id,
      // Project lists leave out each person's No Project.
      label: projectNames.get(id) ?? PROJECTLESS_PROJECT_NAME,
      project: true,
      threads: groupedThreads,
    })),
    ...(inactive.length === 0
      ? []
      : [{ id: "inactive", label: "Inactive Last 72h", threads: inactive }]),
    ...(archived.length === 0 && !archiveAvailable
      ? []
      : [{ id: "archived", label: "Archived", threads: archived }]),
  ];
}
