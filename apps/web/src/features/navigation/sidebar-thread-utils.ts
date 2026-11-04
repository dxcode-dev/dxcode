import type {
  ProjectData,
  SidebarGrouping,
  SidebarOrder,
  ThreadData,
} from "@dx/api";
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
  /** A Project section whose name is still loading. */
  readonly loading?: boolean;
  readonly threads: ReadonlyArray<ThreadData>;
  /**
   * Inactive's Threads under a subheader per Project, newest first; their
   * concatenation is `threads`.
   */
  readonly groups?: ReadonlyArray<ThreadSectionGroup>;
}

/** A Project's Threads inside a status section. */
export interface ThreadSectionGroup {
  readonly id: string;
  readonly label: string;
  readonly threads: ReadonlyArray<ThreadData>;
}

/** Groups a pending No Project Thread until the server names its Project. */
const PENDING_PROJECTLESS_ID = "prj_pending-no-project" as ProjectId;

/**
 * The one section for every No Project Thread. A person has a hidden No
 * Project per scope (personal, and each workspace they joined).
 */
const NO_PROJECT_SECTION_ID = "no-project";

/** The one section a One List Sidebar Layout shows below Pinned. */
const ONE_LIST_SECTION_ID = "threads";

/**
 * The listed Threads plus those this browser is still creating. A pending
 * Thread comes from the creation itself, not the list cache, so no list
 * refetch can drop it before Core admits it. Admission caches the server's
 * row in the lists first, so the pending row hands over without a gap, and
 * from then the server's list alone decides whether the Thread is shown.
 *
 * A pending No Project Thread is marked projectless, so it joins the one No
 * Project section. Its hidden Project is unknown until Core answers. When
 * every Project's name is loaded, an owned Thread under an unnamed Project
 * can only be under that hidden one, so the pending row takes its ID.
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
    ...unlisted.map((creation) => ({
      ...optimisticThreadData(
        creation.id,
        creation.project?.id ?? projectlessId,
        creation.title,
        creation.startedAt,
      ),
      ...(creation.project === undefined ? { projectless: true as const } : {}),
    })),
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

/** The newest Thread first. */
const byCreation = (left: ThreadData, right: ThreadData) =>
  right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds ||
  right.id.localeCompare(left.id);

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
 *
 * Until `projectsComplete`, a Project without a loaded name may be any of
 * the person's Projects, so its section shows as loading. Only Threads Core
 * marks projectless are in No Project then.
 *
 * `archiveAvailable`, true for a signed-in person, keeps Snoozed and
 * Archived listed while empty.
 *
 * `arrangement` is the person's Sidebar Layout and Order. One List puts the
 * Threads every Project section would hold in one section without a heading,
 * and Inactive's without Project subheaders. The order sorts the Threads
 * within each section, except Pinned (by pin) and Snoozed (by wake).
 */
export function buildThreadSections(
  projects: ReadonlyArray<ProjectData>,
  threads: ReadonlyArray<ThreadData>,
  now: number,
  archiveAvailable = false,
  sharedThreads: ReadonlyArray<ThreadData> = [],
  projectsComplete = true,
  arrangement: {
    readonly grouping: SidebarGrouping;
    readonly order: SidebarOrder;
  } = { grouping: "project", order: "activity" },
): ReadonlyArray<ThreadSection> {
  const oneList = arrangement.grouping === "list";
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
  const groups = new Map<string, Array<ThreadData>>();

  const owned = new Set(threads.map(({ id }) => id));
  for (const thread of [
    ...threads,
    ...sharedThreads.filter(({ id }) => !owned.has(id)),
  ].toSorted(arrangement.order === "created" ? byCreation : byActivity)) {
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
        const key = oneList
          ? ONE_LIST_SECTION_ID
          : thread.projectless
            ? NO_PROJECT_SECTION_ID
            : thread.projectId;
        const group = groups.get(key) ?? [];
        group.push(thread);
        groups.set(key, group);
      }
    }
  }
  pinned.sort(byPin);
  snoozed.sort(byWake);
  const nameOf = (id: string) =>
    id === NO_PROJECT_SECTION_ID
      ? PROJECTLESS_PROJECT_NAME
      : projectNames.get(id);
  // Inactive groups by Project, the Project of its first Thread first.
  const inactiveByProject = new Map<string, Array<ThreadData>>();
  for (const thread of inactive) {
    const key = thread.projectless ? NO_PROJECT_SECTION_ID : thread.projectId;
    const group = inactiveByProject.get(key) ?? [];
    group.push(thread);
    inactiveByProject.set(key, group);
  }
  const inactiveGroups = Array.from(
    inactiveByProject,
    ([id, groupThreads]): ThreadSectionGroup => ({
      id,
      label:
        nameOf(id) ??
        (projectsComplete ? PROJECTLESS_PROJECT_NAME : "Loading…"),
      threads: groupThreads,
    }),
  );

  return [
    ...(pinned.length === 0 ? [] : [{ id: "pinned", threads: pinned }]),
    ...Array.from(groups, ([id, groupedThreads]): ThreadSection => {
      if (id === ONE_LIST_SECTION_ID) return { id, threads: groupedThreads };
      const name = nameOf(id);
      if (name !== undefined)
        return { id, label: name, project: true, threads: groupedThreads };
      // Once every Project is loaded, an unnamed one is a hidden No Project
      // whose Threads came without the marker.
      return projectsComplete
        ? {
            id,
            label: PROJECTLESS_PROJECT_NAME,
            project: true,
            threads: groupedThreads,
          }
        : {
            id,
            label: "Loading…",
            project: true,
            loading: true,
            threads: groupedThreads,
          };
    }),
    ...(inactive.length === 0
      ? []
      : [
          {
            id: "inactive",
            label: "Inactive Last 72h",
            ...(oneList
              ? { threads: inactive }
              : {
                  threads: inactiveGroups.flatMap(({ threads }) => threads),
                  groups: inactiveGroups,
                }),
          },
        ]),
    // Snoozed stays listed, at 0, wherever a Thread can be snoozed.
    ...(snoozed.length === 0 && !archiveAvailable
      ? []
      : [{ id: "snoozed", label: "Snoozed", threads: snoozed }]),
    ...(archived.length === 0 && !archiveAvailable
      ? []
      : [{ id: "archived", label: "Archived", threads: archived }]),
  ];
}
