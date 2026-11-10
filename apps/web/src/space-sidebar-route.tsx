import * as React from "react";
import { SidebarSpacesSection } from "./features/spaces/sidebar-spaces-section.js";
import { useDictationSlot } from "./features/threads/dictation/use-dictation.js";

// Loads with New Space's Agent row, as the New Thread composer's does.
const ClaudePlanPicker = React.lazy(() =>
  import("./features/threads/claude-code-mode.js").then((module) => ({
    default: module.ClaudePlanPicker,
  })),
);

/**
 * The sidebar's Spaces section, given the composer's mic for New Space's
 * goal and its Claude plan list for New Space's Agent row: features do not
 * reach into each other, so the application hands them over.
 */
export function SpaceSidebarSection({
  onNavigate,
}: {
  readonly onNavigate: () => void;
}) {
  return (
    <SidebarSpacesSection
      onNavigate={onNavigate}
      dictation={useDictationSlot()}
      PlanPicker={ClaudePlanPicker}
    />
  );
}
