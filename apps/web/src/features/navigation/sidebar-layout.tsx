import {
  type SidebarLayoutChoice,
  type SidebarLayoutEntry,
  SidebarSectionIdSchema,
  type ThreadData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Schema } from "effect";
import * as React from "react";
import {
  arrangementFrom,
  type SidebarArrangement,
  useSyncedSidebarChoices,
} from "./sidebar-layout-queries.js";

/**
 * Which parent Threads show their children, which sections are closed, and
 * the Sidebar Layout and Order. Signed in, it is the person's synced layout,
 * so it survives the mobile drawer closing, reloads, and switching devices.
 */
export interface SidebarLayout extends SidebarArrangement {
  readonly expandedThreads: ReadonlySet<ThreadData["id"]>;
  readonly collapsedSections: ReadonlySet<string>;
  readonly toggleThread: (threadId: ThreadData["id"]) => void;
  readonly toggleSection: (sectionId: string) => void;
}

/** Sections closed until the person opens them. */
const DEFAULT_COLLAPSED_SECTIONS = ["snoozed", "inactive", "archived"];

const isSyncedSection = Schema.is(SidebarSectionIdSchema);

const layoutFrom = (choices: ReadonlyArray<SidebarLayoutChoice>) => {
  const expandedThreads = new Set<ThreadData["id"]>();
  const collapsedSections = new Set(DEFAULT_COLLAPSED_SECTIONS);
  // Later choices win: server state first, then choices still being saved.
  for (const choice of choices) {
    if (choice.kind === "grouping" || choice.kind === "order") continue;
    if (choice.kind === "thread") {
      if (choice.open) expandedThreads.add(choice.id);
      else expandedThreads.delete(choice.id);
    } else if (choice.open) collapsedSections.delete(choice.id);
    else collapsedSections.add(choice.id);
  }
  return { expandedThreads, collapsedSections, ...arrangementFrom(choices) };
};

/** The choice that flips a parent's children or a section. */
const toggleEntry = (
  entries: ReadonlyArray<SidebarLayoutChoice>,
  kind: SidebarLayoutEntry["kind"],
  id: string,
): SidebarLayoutEntry | undefined => {
  const layout = layoutFrom(entries);
  if (kind === "thread")
    return {
      kind,
      id: id as ThreadData["id"],
      open: !layout.expandedThreads.has(id as ThreadData["id"]),
    };
  return isSyncedSection(id)
    ? { kind, id, open: layout.collapsedSections.has(id) }
    : undefined;
};

const noChoices: ReadonlyArray<SidebarLayoutChoice> = [];

/** The synced layout, which every device the person uses shares. */
export const useSyncedSidebarLayout = (userId: UserId): SidebarLayout => {
  const { choices, current, choose } = useSyncedSidebarChoices(userId);
  const toggle = (kind: SidebarLayoutEntry["kind"], id: string) => {
    const entry = toggleEntry(current(), kind, id);
    if (entry !== undefined) choose(entry);
  };
  const toggleThread = (id: ThreadData["id"]) => toggle("thread", id);
  const toggleSection = (id: string) => toggle("section", id);
  // Both sets are structurally shared, so they change only with the layout.
  const layout = layoutFrom(choices);
  return { ...layout, toggleThread, toggleSection };
};

/** This mount only; for a sidebar without a signed-in person. */
export const useLocalSidebarLayout = (): SidebarLayout => {
  const [entries, setEntries] =
    React.useState<ReadonlyArray<SidebarLayoutChoice>>(noChoices);
  const toggle = (kind: SidebarLayoutEntry["kind"], id: string) =>
    setEntries((current) => {
      const entry = toggleEntry(current, kind, id);
      return entry === undefined ? current : [...current, entry];
    });
  const toggleThread = (id: ThreadData["id"]) => toggle("thread", id);
  const toggleSection = (id: string) => toggle("section", id);
  const layout = layoutFrom(entries);
  return { ...layout, toggleThread, toggleSection };
};
