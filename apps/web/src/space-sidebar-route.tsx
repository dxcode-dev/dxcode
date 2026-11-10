import { SidebarSpacesSection } from "./features/spaces/sidebar-spaces-section.js";
import { useDictationSlot } from "./features/threads/dictation/use-dictation.js";

/**
 * The sidebar's Spaces section, given the composer's mic for New Space's
 * goal: features do not reach into each other, so the application hands it
 * over.
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
    />
  );
}
