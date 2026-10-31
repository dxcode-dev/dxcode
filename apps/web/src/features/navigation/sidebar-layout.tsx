import {
  type SidebarLayoutEntry,
  SidebarSectionIdSchema,
  type ThreadData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Schema } from "effect";
import * as React from "react";
import {
  sidebarLayoutKeys,
  sidebarLayoutQueryOptions,
  updateSidebarLayoutMutationOptions,
} from "./sidebar-layout-queries.js";

/**
 * Which parent Threads show their children and which sections are closed.
 * Signed in, it is the person's synced layout, so it survives the mobile
 * drawer closing, reloads, and switching devices.
 */
export interface SidebarLayout {
  readonly expandedThreads: ReadonlySet<ThreadData["id"]>;
  readonly collapsedSections: ReadonlySet<string>;
  readonly toggleThread: (threadId: ThreadData["id"]) => void;
  readonly toggleSection: (sectionId: string) => void;
}

/** Sections closed until the person opens them. */
const DEFAULT_COLLAPSED_SECTIONS = ["snoozed", "inactive", "archived"];

const isSyncedSection = Schema.is(SidebarSectionIdSchema);

const layoutFrom = (entries: ReadonlyArray<SidebarLayoutEntry>) => {
  const expandedThreads = new Set<ThreadData["id"]>();
  const collapsedSections = new Set(DEFAULT_COLLAPSED_SECTIONS);
  // Later entries win: server state first, then choices still being saved.
  for (const entry of entries) {
    if (entry.kind === "thread") {
      if (entry.open) expandedThreads.add(entry.id);
      else expandedThreads.delete(entry.id);
    } else if (entry.open) collapsedSections.delete(entry.id);
    else collapsedSections.add(entry.id);
  }
  return { expandedThreads, collapsedSections };
};

/** The choice that flips a parent's children or a section. */
const toggleEntry = (
  entries: ReadonlyArray<SidebarLayoutEntry>,
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

const noEntries: ReadonlyArray<SidebarLayoutEntry> = [];

/**
 * The synced layout: what the server holds with every choice not yet saved
 * applied on top, so a click shows at once and no refetch can undo it.
 */
export const useSyncedSidebarLayout = (userId: UserId): SidebarLayout => {
  const queryClient = useQueryClient();
  const saved = useQuery(sidebarLayoutQueryOptions(userId)).data?.entries;
  const pending = useMutationState({
    filters: {
      mutationKey: sidebarLayoutKeys.update(userId),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables as SidebarLayoutEntry,
  });
  const { mutate } = useMutation(
    updateSidebarLayoutMutationOptions(queryClient, userId),
  );
  // Stable: memoized sidebar rows receive these handlers, so they read the
  // layout when clicked rather than when rendered.
  const toggle = (kind: SidebarLayoutEntry["kind"], id: string) => {
    const entries = [
      ...(queryClient.getQueryData(sidebarLayoutQueryOptions(userId).queryKey)
        ?.entries ?? noEntries),
      ...queryClient
        .getMutationCache()
        .findAll({
          mutationKey: sidebarLayoutKeys.update(userId),
          status: "pending",
        })
        .map((mutation) => mutation.state.variables as SidebarLayoutEntry),
    ];
    const entry = toggleEntry(entries, kind, id);
    if (entry !== undefined) mutate(entry);
  };
  const toggleThread = (id: ThreadData["id"]) => toggle("thread", id);
  const toggleSection = (id: string) => toggle("section", id);
  // Both are structurally shared, so they change only with the layout.
  const layout = layoutFrom([...(saved ?? noEntries), ...pending]);
  return { ...layout, toggleThread, toggleSection };
};

/** This mount only; for a sidebar without a signed-in person. */
export const useLocalSidebarLayout = (): SidebarLayout => {
  const [entries, setEntries] =
    React.useState<ReadonlyArray<SidebarLayoutEntry>>(noEntries);
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
