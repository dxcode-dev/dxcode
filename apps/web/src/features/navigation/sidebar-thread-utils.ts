import type { ProjectData, ThreadData } from "@dx/api";
import {
  PROJECTLESS_PROJECT_NAME,
  type ProjectId,
  threadReturnedAt,
  threadSnoozeState,
} from "@dx/domain";
import { DateTime } from "effect";
import type {
  ThreadListClientItem,
  ThreadPage,
} from "../../shared/api/client.js";
import type { PendingThreadCreation } from "../../shared/new-thread-surface.js";
import { optimisticThreadData } from "../threads/thread-mutations.js";

export interface ThreadSection {
  readonly id: string;
  readonly label?: string;
  readonly project?: boolean;
  readonly threads: ReadonlyArray<ThreadData>;
}

/** Groups a pending No Project Thread until the server names its Project. */
const PENDING_PROJECTLESS_ID = "prj_pending-no-project" as ProjectId;

/**
 * The listed Threads plus those this browser is still creating. A pending
 * Thread comes from the creation itself, not the list cache, so no list
 * refetch can drop it before Core admits it. Admission caches the server's
 * row in the lists first, so the pending row hands over without a gap, and
 * from then the server's list alone decides whether the Thread is shown.
 *
 * A No Project Thread's hidden Project is unknown until Core answers. When
 * every Project's name is loaded, an owned Thread under an unnamed Project
 * can only be under that hidden one, so the pending row joins its section;
 * otherwise it gets a No Project section of its own.
 */
export function withPendingThreads(
  threads: ReadonlyArray<ThreadData>,
  pending: ReadonlyArray<PendingThreadCreation>,
  projectNames: ReadonlyMap<string, string>,
  projectNamesComplete: boolean,
): ReadonlyArray<ThreadData> {
  const listed = new Set(threads.map(({ id }) => id));
  const unlisted = pending.filter(
    ({ id, submissionId }) => submissionId === undefined && !listed.has(id),
  );
  if (unlisted.length === 0) return threads;
  const projectlessId =
    (projectNamesComplete
      ? threads.find(
          (thread) =>
            thread.lifecycleState === "active" &&
            thread.pinnedAt === undefined &&
            !projectNames.has(thread.projectId),
        )?.projectId
      : undefined) ?? PENDING_PROJECTLESS_ID;
  return [
    ...unlisted.map((creation) =>
      optimisticThreadData(
        creation.id,
        creation.project?.id ?? projectlessId,
        creation.title,
        creation.startedAt,
      ),
    ),
    ...threads,
  ];
}

/** A roots list's child Threads by parent, in the order Core listed them. */
export function childThreadsByParent(
  pages: ReadonlyArray<ThreadPage> | undefined,
): ReadonlyMap<ThreadData["id"], ReadonlyArray<ThreadListClientItem>> {
  const byParent = new Map<ThreadData["id"], Array<ThreadListClientItem>>();
  for (const page of pages ?? []) {
    for (const child of page.children ?? []) {
      if (child.parentThreadId === undefined) continue;
      const siblings = byParent.get(child.parentThreadId) ?? [];
      // A root that pages moved between lists can repeat its children.
      if (!siblings.some(({ id }) => id === child.id)) siblings.push(child);
      byParent.set(child.parentThreadId, siblings);
    }
  }
  return byParent;
}

const INACTIVE_AFTER_MS = 72 * 60 * 60 * 1_000;

const byActivity = (left: ThreadData, right: ThreadData) =>
  right.lastActivityAt.epochMilliseconds -
    left.lastActivityAt.epochMilliseconds || right.id.localeCompare(left.id);

const byPin = (left: ThreadData, right: ThreadData) =>
  (right.pinnedAt?.epochMilliseconds ?? 0) -
    (left.pinnedAt?.epochMilliseconds ?? 0) || byActivity(left, right);

/** The soonest wake first. */
const byWake = (left: ThreadData, right: ThreadData) =>
  (left.snoozedUntil === undefined
    ? 0
    : DateTime.toEpochMillis(left.snoozedUntil)) -
    (right.snoozedUntil === undefined
      ? 0
      : DateTime.toEpochMillis(right.snoozedUntil)) || byActivity(left, right);

/**
 * The next time a listed Thread wakes after `now`, when the sidebar must
 * move it back; undefined when none is snoozed.
 */
export const nextSnoozeWake = (
  threads: ReadonlyArray<ThreadData>,
  now: number,
): number | undefined => {
  let next: number | undefined;
  for (const thread of threads) {
    if (
      thread.snoozedUntil === undefined ||
      threadSnoozeState(thread, now) !== "snoozed"
    )
      continue;
    const wakeAt = DateTime.toEpochMillis(thread.snoozedUntil);
    if (next === undefined || wakeAt < next) next = wakeAt;
  }
  return next;
};

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
  const snoozed: Array<ThreadData> = [];
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
      // A snoozed Thread leaves every other section, even Pinned, and
      // keeps its pin for when it wakes.
      if (threadSnoozeState(thread, now) === "snoozed") {
        snoozed.push(thread);
      } else if (thread.pinnedAt !== undefined) {
        pinned.push(thread);
      } else if (
        thread.activityStatus !== "working" &&
        now - threadReturnedAt(thread, now) >= INACTIVE_AFTER_MS
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
  snoozed.sort(byWake);

  return [
    ...(pinned.length === 0 ? [] : [{ id: "pinned", threads: pinned }]),
    ...Array.from(groups, ([id, groupedThreads]) => ({
      id,
      // Project lists leave out each person's No Project.
      label: projectNames.get(id) ?? PROJECTLESS_PROJECT_NAME,
      project: true,
      threads: groupedThreads,
    })),
    ...(snoozed.length === 0
      ? []
      : [{ id: "snoozed", label: "Snoozed", threads: snoozed }]),
    ...(inactive.length === 0
      ? []
      : [{ id: "inactive", label: "Inactive Last 72h", threads: inactive }]),
    ...(archived.length === 0 && !archiveAvailable
      ? []
      : [{ id: "archived", label: "Archived", threads: archived }]),
  ];
}
