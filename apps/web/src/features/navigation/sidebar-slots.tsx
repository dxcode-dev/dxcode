import type { SettingsContextData } from "@dx/api";
import type { UserId } from "@dx/domain";
import * as React from "react";

/**
 * The sidebar's public slots. dx's own sections register here as any
 * other contribution does: Spaces leads the Threads list, and Projects,
 * Artifacts, and Mail are the dock's links (`dx-sidebar-sections.tsx`).
 *
 * - `leading`: above the Threads list, inside its scroll area.
 * - `after-threads`: below the Threads list, above the dock.
 * - `dock`: the links at the foot of the sidebar.
 */
const SIDEBAR_SLOTS = ["leading", "after-threads", "dock"] as const;

export type SidebarSlot = (typeof SIDEBAR_SLOTS)[number];

/** What every section is drawn with. */
export interface SidebarSlotContext {
  readonly userId: UserId | undefined;
  readonly settingsContext: SettingsContextData | undefined;
  readonly pathname: string;
  /** Closes the phone's sidebar drawer after a link is followed. */
  readonly onNavigate: () => void;
}

export interface SidebarSectionRegistration {
  readonly id: string;
  readonly slot: SidebarSlot;
  /** Whether it shows for this person; absent shows it always. */
  readonly shownWhen?: (context: SidebarSlotContext) => boolean;
  readonly render: (context: SidebarSlotContext) => React.ReactNode;
}

export type SidebarSections = Readonly<
  Record<SidebarSlot, ReadonlyArray<SidebarSectionRegistration>>
>;

export const createSidebarSections = (
  registrations: ReadonlyArray<SidebarSectionRegistration>,
): SidebarSections => {
  const ids = registrations.map(({ id }) => id);
  if (new Set(ids).size !== ids.length)
    throw new Error(`Duplicate sidebar section: ${ids}`);
  return {
    leading: registrations.filter(({ slot }) => slot === "leading"),
    "after-threads": registrations.filter(
      ({ slot }) => slot === "after-threads",
    ),
    dock: registrations.filter(({ slot }) => slot === "dock"),
  };
};

/** Every section registered in one slot that shows for this person. */
export const renderSidebarSlot = (
  sections: SidebarSections,
  slot: SidebarSlot,
  context: SidebarSlotContext,
): ReadonlyArray<React.ReactNode> =>
  sections[slot].flatMap((section) =>
    section.shownWhen === undefined || section.shownWhen(context)
      ? [
          <React.Fragment key={section.id}>
            {section.render(context)}
          </React.Fragment>,
        ]
      : [],
  );
