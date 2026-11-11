import type {
  SpaceArtifactItem,
  SpaceData,
  SpaceThreadItem,
  SpaceThreadState,
  ThreadDetailData,
} from "@dx/api";
import { PROJECTLESS_PROJECT_NAME, type ThreadId } from "@dx/domain";
import { DateTime } from "effect";
import { threadSelectionSummary } from "../../shared/thread-selection-summary.js";

/** A row's age: `now`, `5m`, `3h`, `15d`, `1mo`, `2y`, as sidebar rows show it. */
export const compactAge = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`;
};

/** Epoch milliseconds of a decoded API timestamp. */
export const epochOf = (value: DateTime.Utc): number =>
  DateTime.toEpochMillis(value);

/**
 * The Space panel's sections, in order: what needs a person first, then
 * what runs, then what finished. Shipped and Archived start collapsed.
 */
export const SPACE_THREAD_SECTIONS: ReadonlyArray<{
  readonly state: SpaceThreadState;
  readonly label: string;
  readonly collapsed: boolean;
}> = [
  { state: "needs_you", label: "Needs You", collapsed: false },
  { state: "ready_to_ship", label: "Ready to Ship", collapsed: false },
  { state: "working", label: "Working", collapsed: false },
  { state: "idle", label: "Idle", collapsed: false },
  { state: "failed", label: "Failed", collapsed: false },
  { state: "shipped", label: "Shipped", collapsed: true },
  { state: "archived", label: "Archived", collapsed: true },
];

export const spaceThreadStateLabel = (state: SpaceThreadState) =>
  SPACE_THREAD_SECTIONS.find((section) => section.state === state)?.label ??
  state;

/** The threads in each non-empty section, newest activity first. */
export const groupSpaceThreads = (threads: ReadonlyArray<SpaceThreadItem>) =>
  SPACE_THREAD_SECTIONS.flatMap((section) => {
    const items = threads
      .filter(({ state }) => state === section.state)
      .toSorted(
        (a, b) => epochOf(b.lastActivityAt) - epochOf(a.lastActivityAt),
      );
    return items.length === 0 ? [] : [{ ...section, items }];
  });

/**
 * A Space's artifacts by the thread they belong to, in the order the server
 * lists the threads, with the Space's own first.
 */
export const groupSpaceArtifacts = (
  items: ReadonlyArray<SpaceArtifactItem>,
  spaceThreadId: ThreadId,
) => {
  const groups = new Map<
    string,
    { thread: SpaceArtifactItem["thread"]; items: SpaceArtifactItem[] }
  >();
  for (const item of items) {
    const group = groups.get(item.thread.id);
    if (group === undefined)
      groups.set(item.thread.id, { thread: item.thread, items: [item] });
    else group.items.push(item);
  }
  return [...groups.values()].toSorted(
    (a, b) =>
      Number(b.thread.id === spaceThreadId) -
      Number(a.thread.id === spaceThreadId),
  );
};

/** "Today", "Yesterday", or the date, for the chat's day divider. */
export const dayLabel = (at: number, now: number) => {
  const day = (time: number) => new Date(time).toDateString();
  if (day(at) === day(now)) return "Today";
  if (day(at) === day(now - 86_400_000)) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(new Date(at).getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
};

/** The Space's Project, or undefined for a Space without one. */
export const spaceProject = (space: SpaceData) => {
  // A Space without a Project may name none, or dx's projectless Project.
  const id = space.projectId as string | null | undefined;
  const name = space.projectName as string | null | undefined;
  return id == null ||
    id === "" ||
    name == null ||
    name === "" ||
    name === PROJECTLESS_PROJECT_NAME
    ? undefined
    : { id: space.projectId, name: space.projectName };
};

/** "5h", "2d", as "Updated 5h ago" reads it. */
export const updatedAgo = (at: number, now: number) => {
  const age = compactAge(at, now);
  return age === "now" ? "Updated just now" : `Updated ${age} ago`;
};

/**
 * The Space's own status, as its agent set it: its status line, or "Needs
 * input" while it waits on a person without one; undefined when it has none.
 */
export const spaceStatusText = (space: SpaceData) =>
  space.statusLine ?? (space.waitingOnInput ? "Needs input" : undefined);

/**
 * What a Space shows for what a thread (or its own agent) runs on, as a
 * Thread's title bar does: a pinned model's ID,
 * else the summary's label, with the summary's title as its tooltip.
 */
export function threadSelectionChip(
  selection: ThreadDetailData["agentInitialization"]["selection"],
) {
  const summary = threadSelectionSummary(selection);
  return {
    label:
      selection.kind === "model" && summary.kind === "model"
        ? selection.model
        : summary.label,
    title: summary.title,
  };
}
